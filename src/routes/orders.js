// backend/src/routes/orders.js
import express from "express";
import { protect, adminOnly } from "../middleware/auth.js";
import PricingPlan from "../models/PricingPlan.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import mongoose from "mongoose";

const router = express.Router();

// ✅ DUO+ mensual (server authority)
const PLUS_PRICE = Number(process.env.PLUS_PRICE || 20000);
const PLUS_DISCOUNT_PCT = 15;

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
    user.membership.creditsExpireDays = 30;
  }

  if (!user.membership.tier) {
    user.membership.tier = "basic";
    user.membership.cancelHours = 24;
    user.membership.cancelsLeft = 1;
    user.membership.creditsExpireDays = 30;
  }
}

// ✅ NUEVO: suma 30 días sobre activeUntil si todavía está activo, sino sobre hoy
function addPlusMonths(user, months = 1) {
  const now = new Date();
  user.membership = user.membership || {};

  const curUntil = user.membership.activeUntil ? new Date(user.membership.activeUntil) : null;
  const base = curUntil && curUntil > now ? curUntil : now;

  const until = new Date(base);
  until.setDate(until.getDate() + 30 * Math.max(1, Number(months) || 1));

  user.membership.tier = "plus";
  user.membership.activeUntil = until;

  // ✅ reglas Plus
  user.membership.cancelHours = 12;
  user.membership.cancelsLeft = 2;
  user.membership.creditsExpireDays = 40;
}

// compat: si querés “comprar DUO+” y también sume, usamos lo mismo
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

  const expireDays = isPlusActive(user) ? 40 : 30;

  const exp = new Date(now);
  exp.setDate(exp.getDate() + expireDays);

  user.creditLots = user.creditLots || [];
  user.creditLots.push({
    serviceKey: String(serviceKey || "EP").toUpperCase().trim(),
    amount: Number(amount || 0),
    remaining: Number(amount || 0),
    expiresAt: exp,
    source: source || "",
    orderId: orderId || null,
    createdAt: now,
  });

  recalcCreditsCache(user);
}

/* =======================
   Aplicar una orden (idempotente)
   - activa/EXTIENDE plus si viene MEMBERSHIP plus
   - suma lotes por cada item CREDITS
======================= */
async function applyOrderIfNeeded(order) {
  if (!order) return { ok: false, error: "Orden inválida." };

  if (order.applied) {
    return { ok: true, message: "Orden ya aplicada." };
  }

  const user = await User.findById(order.user);
  if (!user) return { ok: false, error: "Usuario no encontrado." };

  const hasItems = Array.isArray(order.items) && order.items.length > 0;

  // 1) membership primero (para que créditos expiren 40 si corresponde)
  if (hasItems) {
    const membershipItems = order.items.filter(
      (it) => String(it.kind || "").toUpperCase() === "MEMBERSHIP"
    );

    if (membershipItems.length > 0) {
      // Sumamos meses según qty (y según action)
      let monthsToAdd = 0;

      for (const it of membershipItems) {
        const qty = Math.max(1, Number(it.qty) || 1);
        const action = String(it.action || "BUY").toUpperCase();

        // BUY: si no era plus -> activa 1 mes; si ya era plus -> también suma (mejor UX)
        // EXTEND: siempre suma
        if (action === "EXTEND") {
          monthsToAdd += qty;
        } else {
          // BUY
          monthsToAdd += qty;
        }
      }

      if (monthsToAdd > 0) addPlusMonths(user, monthsToAdd);
    } else {
      ensureBasicIfExpired(user);
    }
  } else {
    // legacy
    if (order.plusIncluded) activatePlus(user);
    else ensureBasicIfExpired(user);
  }

  // 2) créditos
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
          serviceKey: it.serviceKey || "EP",
        });
      }
    }
  } else {
    // legacy: credits + serviceKey
    const totalCredits = Math.max(0, Number(order.credits) || 0);
    if (totalCredits > 0) {
      addCreditLot(user, {
        amount: totalCredits,
        source: "order-legacy",
        orderId: order._id,
        serviceKey: order.serviceKey || "EP",
      });
    }
  }

  await user.save();

  order.applied = true;
  order.creditsApplied = true; // legacy compat
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

  // ✅ si guardamos totalFinal, MercadoPago debe cobrar eso
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
  const sk = String(serviceKey || "").toUpperCase();
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
   - Soporta action (BUY/EXTEND) en MEMBERSHIP
   - Soporta qty en MEMBERSHIP (suma meses)
   - Aplica 15% off si el usuario YA es PLUS activo (solo sobre CREDITS)
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

    // 🔥 importante: detectar PLUS real del usuario (server side)
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
          basePrice: base.basePrice, // precio unitario
          price: base.basePrice * qty, // subtotal
        });
      } else if (kind === "MEMBERSHIP") {
        const base = resolveMembershipItem();

        const action = String(it?.action || "BUY").toUpperCase(); // BUY / EXTEND
        // Para MEMBERSHIP dejamos qty (meses) (si no querés, ponelo fijo a 1)
        const monthsQty = Math.max(1, Number(it?.qty) || 1);

        items.push({
          kind: "MEMBERSHIP",
          membershipTier: "plus",
          label: base.label,
          action,
          qty: monthsQty,
          basePrice: base.basePrice, // unitario mensual
          price: base.basePrice * monthsQty, // subtotal
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

    // ✅ descuento PLUS: 15% sobre CREDITS únicamente (seguro)
    // Si querés que descuente TODO (también membership), cambiá creditsSubtotal -> total.
    const creditsSubtotal = items
      .filter((x) => String(x.kind || "").toUpperCase() === "CREDITS")
      .reduce((acc, x) => acc + Number(x.price || 0), 0);

    const discountPercent = plusActiveNow ? PLUS_DISCOUNT_PCT : 0;
    const discountAmount = plusActiveNow
      ? Math.round(creditsSubtotal * (PLUS_DISCOUNT_PCT / 100))
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
    });

    if (pm === "CASH") {
      return res.status(201).json({
        ok: true,
        orderId: order._id,
        status: "pending",
        totalFinal,
        discountPercent,
        discountAmount,
      });
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
      orderId: order._id,
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

    const sk = String(serviceKey || "").toUpperCase();
    const pm = String(payMethod || "").toUpperCase();
    const cr = Number(credits);
    const wantsPlus = Boolean(plus);

    if (!sk || !pm || !cr)
      return res.status(400).json({ error: "Datos incompletos." });
    if (!["CASH", "MP"].includes(pm))
      return res.status(400).json({ error: "Medio de pago inválido." });

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

    if (pm === "CASH") {
      return res.status(201).json({ ok: true, orderId: order._id, status: "pending" });
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

    return res.status(201).json({ ok: true, init_point: mp.init_point, orderId: order._id });
  } catch (err) {
    console.error("POST /orders", err);
    return res.status(500).json({ error: "Error creando orden." });
  }
});

// GET /orders/me
router.get("/me", protect, async (req, res) => {
  const list = await Order.find({ user: req.user._id })
    .sort({ createdAt: -1 })
    .lean();
  res.json(list);
});

/* =======================
   ADMIN
======================= */
router.get("/", protect, adminOnly, async (req, res) => {
  const list = await Order.find()
    .populate("user", "name email")
    .sort({ createdAt: -1 })
    .lean();
  res.json(list);
});

// PATCH /orders/:id/mark-paid (solo CASH)
// ✅ marca paid + aplica items (plus + créditos)
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
    if (st !== "paid") {
      order.status = "paid";
      order.paidAt = new Date();
      await order.save();
    }

    const applied = await applyOrderIfNeeded(order);
    if (!applied.ok) {
      return res.status(500).json({ error: applied.error || "No se pudo aplicar." });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /orders/:id/mark-paid error:", err);
    return res.status(500).json({
      error: "Error interno al marcar como pagada",
      detail: err?.message || String(err),
    });
  }
});

export default router;
