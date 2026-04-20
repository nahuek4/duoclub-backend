// backend/src/routes/orders.js
import express from "express";
import mongoose from "mongoose";
import { protect, adminOnly } from "../middleware/auth.js";
import PricingPlan from "../models/PricingPlan.js";
import Order from "../models/Order.js";
import User from "../models/User.js";

import {
  fireAndForget,
  sendAdminNewOrderEmail,
  sendUserOrderCashCreatedEmail,
  sendAdminOrderPaidEmail,
  sendUserOrderPaidEmail,
} from "../mail.js";
import { logActivity, buildUserSubject } from "../lib/activityLogger.js";

const router = express.Router();

const PLUS_PRICE = Number(process.env.PLUS_PRICE || 20000);
const PLUS_DISCOUNT_PCT = 15;
const CREDITS_EXPIRE_DAYS = 30;

const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RA", "RF", "NUT"]);
const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  NUT: "Nutrición",
};

function normalizeServiceKey(value, { allowEmpty = false } = {}) {
  const sk = String(value || "").toUpperCase().trim();
  if (!sk) return allowEmpty ? "" : null;
  return ALLOWED_SERVICE_KEYS.has(sk) ? sk : null;
}

function assertServiceKey(value, label = "serviceKey") {
  const sk = normalizeServiceKey(value);
  if (!sk) throw new Error(`${label} inválido.`);
  return sk;
}

/* =======================
   Helpers membresía / créditos
======================= */
function isPlusActive(user) {
  const m = user?.membership || {};
  if (String(m.tier || "").toLowerCase() !== "plus") return false;
  if (!m.activeUntil) return false;
  return new Date(m.activeUntil) > new Date();
}

function ensureBasicIfExpired(user) {
  const now = new Date();
  user.membership = user.membership || {};

  const expired =
    String(user.membership.tier || "").toLowerCase() === "plus" &&
    user.membership.activeUntil &&
    new Date(user.membership.activeUntil) <= now;

  if (expired) {
    user.membership.tier = "basic";
    user.membership.activeUntil = null;
    user.membership.cancelHours = 24;
    user.membership.cancelsLeft = 1;
    user.membership.creditsExpireDays = CREDITS_EXPIRE_DAYS;
  }

  if (!user.membership.tier) {
    user.membership.tier = "basic";
    user.membership.cancelHours = 24;
    user.membership.cancelsLeft = 1;
    user.membership.creditsExpireDays = CREDITS_EXPIRE_DAYS;
  }
}

function addPlusMonths(user, months = 1) {
  const now = new Date();
  user.membership = user.membership || {};

  const curUntil = user.membership.activeUntil
    ? new Date(user.membership.activeUntil)
    : null;
  const base = curUntil && curUntil > now ? curUntil : now;

  const until = new Date(base);
  until.setDate(until.getDate() + 30 * Math.max(1, Number(months) || 1));

  user.membership.tier = "plus";
  user.membership.activeUntil = until;
  user.membership.cancelHours = 12;
  user.membership.cancelsLeft = 2;
  user.membership.creditsExpireDays = CREDITS_EXPIRE_DAYS;
}

function activatePlus(user) {
  addPlusMonths(user, 1);
}

function recalcCreditsCache(user) {
  const now = new Date();
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
  const sum = lots.reduce((acc, lot) => {
    const exp = lot.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return acc;
    return acc + Number(lot.remaining || 0);
  }, 0);
  user.credits = sum;
}

function addCreditLot(user, { amount, source, orderId, serviceKey }) {
  const now = new Date();
  ensureBasicIfExpired(user);

  const expireDays = CREDITS_EXPIRE_DAYS;
  const sk = assertServiceKey(serviceKey);

  const exp = new Date(now);
  exp.setDate(exp.getDate() + expireDays);

  user.creditLots = user.creditLots || [];
  user.creditLots.push({
    serviceKey: sk,
    amount: Number(amount || 0),
    remaining: Number(amount || 0),
    expiresAt: exp,
    source: source || "",
    orderId: orderId || null,
    createdAt: now,
  });

  recalcCreditsCache(user);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}
function ymd(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function hm(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function safeServiceFromOrder(order) {
  const hasItems = Array.isArray(order?.items) && order.items.length > 0;
  if (hasItems) {
    const kinds = order.items
      .map((it) => String(it?.kind || "").toUpperCase())
      .filter(Boolean);

    if (kinds.includes("MEMBERSHIP") && kinds.includes("CREDITS")) {
      return "MEMBERSHIP+CREDITS";
    }
    if (kinds.includes("MEMBERSHIP")) return "MEMBERSHIP";

    if (kinds.includes("CREDITS")) {
      const sks = order.items
        .filter((it) => String(it?.kind || "").toUpperCase() === "CREDITS")
        .map((it) => normalizeServiceKey(it?.serviceKey, { allowEmpty: true }))
        .filter(Boolean);
      const uniq = Array.from(new Set(sks));
      if (uniq.length === 1) return uniq[0];
      if (uniq.length > 1) return uniq.join("+");
      return "CREDITS";
    }

    return "ITEMS";
  }

  return normalizeServiceKey(order?.serviceKey, { allowEmpty: true }) || "ORDER";
}

function prettyServiceNameFromKey(sk) {
  const normalized = normalizeServiceKey(sk, { allowEmpty: true });
  if (normalized) return SERVICE_KEY_TO_NAME[normalized] || normalized;
  const raw = String(sk || "").trim();
  return raw || "Sesiones";
}

function pluralizeSessions(n) {
  return Number(n) === 1 ? "sesión" : "sesiones";
}

function buildOrderHistoryTitle(order) {
  const items = Array.isArray(order?.items) ? order.items : [];

  if (items.length) {
    const creditItems = items.filter(
      (it) => String(it?.kind || "").toUpperCase() === "CREDITS"
    );
    const membershipItems = items.filter(
      (it) => String(it?.kind || "").toUpperCase() === "MEMBERSHIP"
    );

    const parts = [];

    for (const it of creditItems) {
      const qty = Math.max(1, Number(it?.qty) || 1);
      const credits = Math.max(0, Number(it?.credits) || 0);
      const totalCredits = qty * credits;
      const serviceName = prettyServiceNameFromKey(it?.serviceKey);

      if (totalCredits > 0) {
        parts.push(
          `${totalCredits} ${pluralizeSessions(totalCredits)} para ${serviceName}`
        );
      }
    }

    if (membershipItems.length) {
      const months = membershipItems.reduce(
        (acc, it) => acc + Math.max(1, Number(it?.qty) || 1),
        0
      );
      parts.push(months === 1 ? "DUO+ mensual" : `${months} meses de DUO+`);
    }

    if (parts.length === 1) {
      return `Realizó una orden de ${parts[0]}.`;
    }

    if (parts.length > 1) {
      return `Realizó una orden de ${parts.join(" y ")}.`;
    }
  }

  const legacyCredits = Math.max(0, Number(order?.credits) || 0);
  const legacyService = prettyServiceNameFromKey(order?.serviceKey);

  if (legacyCredits > 0 && order?.plusIncluded) {
    return `Realizó una orden de ${legacyCredits} ${pluralizeSessions(
      legacyCredits
    )} para ${legacyService} y DUO+ mensual.`;
  }

  if (legacyCredits > 0) {
    return `Realizó una orden de ${legacyCredits} ${pluralizeSessions(
      legacyCredits
    )} para ${legacyService}.`;
  }

  if (order?.plusIncluded) {
    return "Realizó una orden de DUO+ mensual.";
  }

  return "Realizó una orden.";
}

/* =======================
   Notificar admin
======================= */
async function notifyAdminIfNeeded(order) {
  if (!order || order.adminNotifiedAt) return;

  try {
    const u = await User.findById(order.user).lean().catch(() => null);
    await sendAdminNewOrderEmail(order, u);
    order.adminNotifiedAt = new Date();
    await order.save();
  } catch (e) {
    console.warn("ORDERS: no se pudo enviar mail admin:", e?.message || e);
  }
}

/* =======================
   Notificar pago
======================= */
async function notifyOrderPaidIfNeeded(order) {
  if (!order || order.userPaidNotifiedAt) return;

  try {
    const u = await User.findById(order.user).lean().catch(() => null);

    if (u?.email) await sendUserOrderPaidEmail(order, u);
    await sendAdminOrderPaidEmail(order, u);

    order.userPaidNotifiedAt = new Date();
    await order.save();
  } catch (e) {
    console.warn("ORDERS: no se pudo enviar mail de pago:", e?.message || e);
  }
}

/* =======================
   Aplicar créditos SOLO
======================= */
async function applyCreditsOnlyIfNeeded(order) {
  if (!order) return { ok: false, error: "Orden inválida." };

  if (order.creditsApplied) {
    return { ok: true, message: "Créditos ya habilitados." };
  }

  const user = await User.findById(order.user);
  if (!user) return { ok: false, error: "Usuario no encontrado." };

  const hasItems = Array.isArray(order.items) && order.items.length > 0;

  ensureBasicIfExpired(user);

  if (hasItems) {
    for (const it of order.items) {
      const kind = String(it.kind || "").toUpperCase();
      if (kind !== "CREDITS") continue;

      const qty = Math.max(1, Number(it.qty) || 1);
      const creditsPer = Math.max(0, Number(it.credits) || 0);
      const totalCredits = creditsPer * qty;

      if (totalCredits > 0) {
        addCreditLot(user, {
          amount: totalCredits,
          source: "order-credits-only",
          orderId: order._id,
          serviceKey: assertServiceKey(it.serviceKey),
        });
      }
    }
  } else {
    const totalCredits = Math.max(0, Number(order.credits) || 0);
    if (totalCredits > 0) {
      addCreditLot(user, {
        amount: totalCredits,
        source: "order-legacy-credits-only",
        orderId: order._id,
        serviceKey: assertServiceKey(order.serviceKey),
      });
    }
  }

  await user.save();

  order.creditsApplied = true;
  await order.save();

  return { ok: true };
}

/* =======================
   Aplicar una orden completa
======================= */
async function applyOrderIfNeeded(order) {
  if (!order) return { ok: false, error: "Orden inválida." };

  if (order.applied) {
    return { ok: true, message: "Orden ya aplicada." };
  }

  const user = await User.findById(order.user);
  if (!user) return { ok: false, error: "Usuario no encontrado." };

  const hasItems = Array.isArray(order.items) && order.items.length > 0;

  if (hasItems) {
    const membershipItems = order.items.filter(
      (it) => String(it.kind || "").toUpperCase() === "MEMBERSHIP"
    );

    if (membershipItems.length > 0) {
      let monthsToAdd = 0;

      for (const it of membershipItems) {
        const qty = Math.max(1, Number(it.qty) || 1);
        monthsToAdd += qty;
      }

      if (monthsToAdd > 0) addPlusMonths(user, monthsToAdd);
    } else {
      ensureBasicIfExpired(user);
    }
  } else {
    if (order.plusIncluded) activatePlus(user);
    else ensureBasicIfExpired(user);
  }

  if (!order.creditsApplied) {
    if (hasItems) {
      for (const it of order.items) {
        const kind = String(it.kind || "").toUpperCase();
        if (kind !== "CREDITS") continue;

        const qty = Math.max(1, Number(it.qty) || 1);
        const creditsPer = Math.max(0, Number(it.credits) || 0);
        const totalCredits = creditsPer * qty;

        if (totalCredits > 0) {
          addCreditLot(user, {
            amount: totalCredits,
            source: "order",
            orderId: order._id,
            serviceKey: assertServiceKey(it.serviceKey),
          });
        }
      }
    } else {
      const totalCredits = Math.max(0, Number(order.credits) || 0);
      if (totalCredits > 0) {
        addCreditLot(user, {
          amount: totalCredits,
          source: "order-legacy",
          orderId: order._id,
          serviceKey: assertServiceKey(order.serviceKey),
        });
      }
    }
  }

  await user.save();

  order.applied = true;
  order.creditsApplied = true;
  await order.save();

  return { ok: true };
}

/* =======================
   MercadoPago
======================= */
async function createMpPreference({ order, user }) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    return { ok: false, error: "MP_ACCESS_TOKEN no configurado." };
  }

  const FRONT_BASE = process.env.FRONT_BASE_URL || "https://app.duoclub.ar";
  const amountToCharge = Number(order.totalFinal ?? order.total ?? order.price ?? 0);

  const body = {
    items: [
      {
        title: `DUO - Compra`,
        quantity: 1,
        currency_id: "ARS",
        unit_price: amountToCharge,
      },
    ],
    external_reference: String(order._id),
    metadata: {
      orderId: String(order._id),
      userId: String(user._id),
      payMethod: order.payMethod,
      itemsCount: Array.isArray(order.items) ? order.items.length : 0,
      discountPercent: Number(order.discountPercent || 0),
      discountAmount: Number(order.discountAmount || 0),
      totalFinal: amountToCharge,
    },
    back_urls: {
      success: `${FRONT_BASE}/?mp=success`,
      pending: `${FRONT_BASE}/?mp=pending`,
      failure: `${FRONT_BASE}/?mp=failure`,
    },
    auto_return: "approved",
    notification_url: process.env.MP_WEBHOOK_URL || undefined,
  };

  const resp = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    return { ok: false, error: data?.message || "Error creando preferencia MP" };
  }

  return { ok: true, preferenceId: data.id, init_point: data.init_point };
}

/* =======================
   Pricing resolvers
======================= */
async function resolveCreditsItem({ serviceKey, credits, payMethod }) {
  const sk = normalizeServiceKey(serviceKey);
  const pm = String(payMethod || "").toUpperCase();
  const cr = Number(credits);

  if (!sk || !pm || !cr) throw new Error("Ítem de créditos inválido.");

  const plan = await PricingPlan.findOne({
    serviceKey: sk,
    payMethod: pm,
    credits: cr,
    active: true,
  }).lean();

  if (!plan) throw new Error(`Plan inválido (${sk} ${cr} ${pm}).`);

  return {
    kind: "CREDITS",
    serviceKey: sk,
    credits: cr,
    label: plan.label || "",
    basePrice: Number(plan.price || 0),
  };
}

function resolveMembershipItem() {
  return {
    kind: "MEMBERSHIP",
    membershipTier: "plus",
    label: "DUO+ mensual",
    basePrice: PLUS_PRICE,
  };
}

/* =========================================================
   POST /orders/checkout
========================================================= */
router.post("/checkout", protect, async (req, res) => {
  try {
    const pm = String(req.body?.payMethod || "").toUpperCase();
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!["CASH", "MP"].includes(pm)) {
      return res.status(400).json({ error: "Medio de pago inválido." });
    }
    if (!rawItems.length) {
      return res.status(400).json({ error: "Carrito vacío." });
    }

    const freshUser = await User.findById(req.user._id).lean();
    const plusActiveNow = isPlusActive(freshUser);

    const items = [];

    for (const it of rawItems) {
      const kind = String(it?.kind || "").toUpperCase();
      const qty = Math.max(1, Number(it?.qty) || 1);

      if (kind === "CREDITS") {
        const base = await resolveCreditsItem({
          serviceKey: it.serviceKey,
          credits: it.credits,
          payMethod: pm,
        });

        items.push({
          kind: "CREDITS",
          serviceKey: base.serviceKey,
          credits: base.credits,
          label: base.label,
          qty,
          basePrice: base.basePrice,
          price: base.basePrice * qty,
        });
      } else if (kind === "MEMBERSHIP") {
        const base = resolveMembershipItem();
        const action = String(it?.action || "BUY").toUpperCase();
        const monthsQty = Math.max(1, Number(it?.qty) || 1);

        items.push({
          kind: "MEMBERSHIP",
          membershipTier: "plus",
          label: base.label,
          action,
          qty: monthsQty,
          basePrice: base.basePrice,
          price: base.basePrice * monthsQty,
        });
      } else {
        return res.status(400).json({ error: "Ítem inválido en el carrito." });
      }
    }

    const totalBase = items.reduce(
      (acc, x) => acc + Number(x.basePrice || 0) * (Number(x.qty) || 1),
      0
    );

    const total = items.reduce((acc, x) => acc + Number(x.price || 0), 0);

    const shopSubtotal = items
      .filter((x) => String(x.kind || "").toUpperCase() === "SHOP")
      .reduce((acc, x) => acc + Number(x.price || 0), 0);

    const discountPercent = plusActiveNow && shopSubtotal > 0 ? PLUS_DISCOUNT_PCT : 0;
    const discountAmount =
      plusActiveNow && shopSubtotal > 0
        ? Math.round(shopSubtotal * (PLUS_DISCOUNT_PCT / 100))
        : 0;

    const totalFinal = Math.max(0, Math.round(total - discountAmount));

    const order = await Order.create({
      user: req.user._id,
      payMethod: pm,
      items,
      totalBase,
      total,
      discountPercent,
      discountAmount,
      totalFinal,
      status: "pending",
      applied: false,
      creditsApplied: false,
    });

    try {
      const userDoc = await User.findById(req.user._id);
      if (userDoc) {
        userDoc.history = Array.isArray(userDoc.history) ? userDoc.history : [];
        userDoc.history.push({
          action: "order_created",
          title: buildOrderHistoryTitle(order),
          createdAt: new Date(),
        });
        await userDoc.save();
      }
    } catch (e) {
      console.warn("ORDER HISTORY checkout:", e?.message || e);
    }

    await logActivity({
      req,
      category: "orders",
      action: "order_checkout_created",
      entity: "order",
      entityId: order._id,
      title: "Orden generada",
      description: "Se generó una nueva orden desde checkout.",
      subject: buildUserSubject(req.user),
      meta: {
        total: Number(order.totalFinal || order.total || 0),
        payMethod: order.payMethod,
        status: order.status,
      },
    });

    if (pm === "CASH") {
      res.status(201).json({
        ok: true,
        status: "pending",
        totalFinal,
        discountPercent,
        discountAmount,
        message: "Pedido generado correctamente. Coordiná el pago con el staff.",
      });

      fireAndForget(() => notifyAdminIfNeeded(order), "MAIL_ADMIN_NEW_ORDER_CASH");

      fireAndForget(async () => {
        const u = await User.findById(order.user).lean().catch(() => null);
        if (u?.email) await sendUserOrderCashCreatedEmail(order, u);
      }, "MAIL_USER_CASH_CREATED");

      return;
    }

    const mp = await createMpPreference({ order, user: req.user });
    if (!mp.ok) {
      order.notes = mp.error;
      await order.save();
      return res.status(500).json({ error: mp.error });
    }

    order.mpPreferenceId = mp.preferenceId;
    order.mpInitPoint = mp.init_point;
    await order.save();

    return res.status(201).json({
      ok: true,
      init_point: mp.init_point,
      totalFinal,
      discountPercent,
      discountAmount,
    });
  } catch (err) {
    console.error("POST /orders/checkout", err);
    return res.status(500).json({ error: err?.message || "Error creando orden." });
  }
});

/* =========================================================
   LEGACY: POST /orders
========================================================= */
router.post("/", protect, async (req, res) => {
  try {
    const { serviceKey, credits, payMethod, plus } = req.body || {};

    const sk = normalizeServiceKey(serviceKey);
    const pm = String(payMethod || "").toUpperCase();
    const cr = Number(credits);
    const wantsPlus = Boolean(plus);

    if (!sk || !pm || !cr) {
      return res.status(400).json({ error: "Datos incompletos o serviceKey inválido." });
    }
    if (!["CASH", "MP"].includes(pm)) {
      return res.status(400).json({ error: "Medio de pago inválido." });
    }

    const plan = await PricingPlan.findOne({
      serviceKey: sk,
      payMethod: pm,
      credits: cr,
      active: true,
    }).lean();

    if (!plan) return res.status(404).json({ error: "Plan inválido." });

    const basePrice = Number(plan.price || 0);
    const plusPrice = wantsPlus ? PLUS_PRICE : 0;
    const total = basePrice + plusPrice;

    const order = await Order.create({
      user: req.user._id,
      payMethod: pm,
      serviceKey: sk,
      credits: cr,
      basePrice,
      plusIncluded: wantsPlus,
      plusPrice,
      price: total,
      label: plan.label || "",
      status: "pending",
      creditsApplied: false,
      applied: false,
    });

    try {
      const userDoc = await User.findById(req.user._id);
      if (userDoc) {
        userDoc.history = Array.isArray(userDoc.history) ? userDoc.history : [];
        userDoc.history.push({
          action: "order_created",
          title: buildOrderHistoryTitle(order),
          createdAt: new Date(),
        });
        await userDoc.save();
      }
    } catch (e) {
      console.warn("ORDER HISTORY legacy:", e?.message || e);
    }

    await logActivity({
      req,
      category: "orders",
      action: "order_created",
      entity: "order",
      entityId: order._id,
      title: "Orden generada",
      description: "Se creó una orden manual/tradicional.",
      subject: buildUserSubject(req.user),
      meta: {
        total: Number(order.totalFinal || order.total || order.price || 0),
        payMethod: order.payMethod,
        status: order.status,
      },
    });

    if (pm === "CASH") {
      res.status(201).json({ ok: true, status: "pending" });

      fireAndForget(() => notifyAdminIfNeeded(order), "MAIL_ADMIN_NEW_ORDER_LEGACY_CASH");
      fireAndForget(async () => {
        const u = await User.findById(order.user).lean().catch(() => null);
        if (u?.email) await sendUserOrderCashCreatedEmail(order, u);
      }, "MAIL_USER_LEGACY_CASH_CREATED");

      return;
    }

    const mp = await createMpPreference({
      order: { ...order.toObject(), totalFinal: total, total: total },
      user: req.user,
    });

    if (!mp.ok) {
      order.notes = mp.error;
      await order.save();
      return res.status(500).json({ error: mp.error });
    }

    order.mpPreferenceId = mp.preferenceId;
    order.mpInitPoint = mp.init_point;
    await order.save();

    return res.status(201).json({ ok: true, init_point: mp.init_point });
  } catch (err) {
    console.error("POST /orders", err);
    return res.status(500).json({ error: "Error creando orden." });
  }
});

router.get("/me", protect, async (req, res) => {
  const list = await Order.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
  res.json(list);
});

/* =======================
   ADMIN
======================= */
router.get("/", protect, adminOnly, async (req, res) => {
  const list = await Order.find()
    .populate("user", "name lastName fullName email")
    .sort({ createdAt: -1 })
    .lean();

  res.json(list);
});

router.patch("/:id/enable-credits", protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID de orden inválido" });
    }

    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    const pm = String(order.payMethod || "").toUpperCase();
    if (pm !== "CASH") {
      return res.status(400).json({ error: "Solo CASH permite habilitar créditos sin pago" });
    }

    const st = String(order.status || "").toLowerCase();
    if (st !== "pending") {
      return res
        .status(400)
        .json({ error: "Solo órdenes pendientes pueden habilitar créditos sin pago" });
    }

    const r = await applyCreditsOnlyIfNeeded(order);
    if (!r.ok) {
      return res.status(500).json({ error: r.error || "No se pudo habilitar créditos." });
    }

    await logActivity({
      req,
      category: "orders",
      action: "order_credits_enabled",
      entity: "order",
      entityId: order._id,
      title: "Créditos habilitados",
      description: "Se habilitaron créditos manualmente en una orden CASH pendiente.",
      subject: buildUserSubject(req.user),
      meta: { total: Number(order.totalFinal || order.total || 0) },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /orders/:id/enable-credits error:", err);
    return res.status(500).json({
      error: "Error interno al habilitar créditos",
      detail: err?.message || String(err),
    });
  }
});

router.patch("/:id/mark-paid", protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID de orden inválido" });
    }

    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    const pm = String(order.payMethod || "").toUpperCase();
    if (pm !== "CASH") {
      return res.status(400).json({ error: "Solo CASH puede marcarse manualmente" });
    }

    const st = String(order.status || "").toLowerCase();
    const wasPaid = st === "paid";

    if (!wasPaid) {
      order.status = "paid";
      order.paidAt = new Date();
      await order.save();
    }

    const applied = await applyOrderIfNeeded(order);
    if (!applied.ok) {
      return res.status(500).json({ error: applied.error || "No se pudo aplicar." });
    }

    if (!wasPaid) {
      try {
        const userDoc = await User.findById(order.user);
        if (userDoc) {
          userDoc.history = Array.isArray(userDoc.history) ? userDoc.history : [];
          userDoc.history.push({
            action: "order_paid",
            title: "Se acreditó una orden.",
            createdAt: new Date(),
          });
          await userDoc.save();
        }
      } catch (e) {
        console.warn("ORDER PAID HISTORY:", e?.message || e);
      }

      fireAndForget(() => notifyOrderPaidIfNeeded(order), "MAIL_ORDER_PAID");
    }

    await logActivity({
      req,
      category: "orders",
      action: "order_marked_paid",
      entity: "order",
      entityId: order._id,
      title: "Orden marcada como pagada",
      description: "Un admin marcó manualmente una orden como pagada.",
      subject: buildUserSubject(req.user),
      meta: {
        total: Number(order.totalFinal || order.total || 0),
        wasAlreadyPaid: wasPaid,
      },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /orders/:id/mark-paid error:", err);
    return res.status(500).json({
      error: "Error interno al marcar como pagada",
      detail: err?.message || String(err),
    });
  }
});

router.delete("/:id", protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "ID de orden inválido" });
    }

    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ error: "Orden no encontrada" });

    const impacted = !!(order.applied || order.creditsApplied);

    try {
      const user = await User.findById(order.user);
      if (user) {
        user.history = Array.isArray(user.history) ? user.history : [];
        user.history.push({
          action: impacted ? "ORDER_DELETED_IMPACTED" : "ORDER_DELETED",
          date: ymd(new Date()),
          time: hm(new Date()),
          service: safeServiceFromOrder(order),
          createdAt: new Date(),
        });
        await user.save();
      }
    } catch (e) {
      console.warn("ORDER DELETE: no se pudo guardar history:", e?.message || e);
    }

    await logActivity({
      req,
      category: "orders",
      action: "order_deleted",
      entity: "order",
      entityId: order._id,
      title: "Orden eliminada",
      description: impacted
        ? "Se eliminó una orden que ya había impactado créditos/sesiones."
        : "Se eliminó una orden.",
      subject: buildUserSubject(req.user),
      meta: { impacted, total: Number(order.totalFinal || order.total || 0) },
      deletedSnapshot: order.toObject(),
    });

    await Order.deleteOne({ _id: order._id });

    if (impacted) {
      return res.json({
        ok: true,
        warning: true,
        message:
          "Venta borrada. Atención: esta orden ya había impactado (créditos/membresía). No se revierte lo habilitado.",
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /orders/:id error:", err);
    return res.status(500).json({
      error: "Error interno al borrar la orden",
      detail: err?.message || String(err),
    });
  }
});

export default router;