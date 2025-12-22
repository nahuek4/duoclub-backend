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

/* =======================
   Helpers membresía / créditos
======================= */
function isPlusActive(user) {
  const m = user?.membership || {};
  if (m.tier !== "plus") return false;
  if (!m.activeUntil) return false;
  return new Date(m.activeUntil) > new Date();
}

function ensureBasicIfExpired(user) {
  const now = new Date();
  user.membership = user.membership || {};

  const expired =
    user.membership.tier === "plus" &&
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

function activatePlus(user) {
  const now = new Date();

  user.membership = user.membership || {};

  // si ya estaba activo, extendemos desde el activeUntil, si no desde hoy
  const base =
    user.membership.tier === "plus" &&
    user.membership.activeUntil &&
    new Date(user.membership.activeUntil) > now
      ? new Date(user.membership.activeUntil)
      : now;

  const until = new Date(base);
  until.setDate(until.getDate() + 30);

  user.membership.tier = "plus";
  user.membership.activeUntil = until;

  // reglas Plus
  user.membership.cancelHours = 12;
  user.membership.cancelsLeft = 2;
  user.membership.creditsExpireDays = 40;
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

function addCreditLot(user, { amount, serviceKey, source, orderId }) {
  const now = new Date();
  ensureBasicIfExpired(user);

  // si querés que sea configurable por membership:
  const expireDays =
    Number(user?.membership?.creditsExpireDays) > 0
      ? Number(user.membership.creditsExpireDays)
      : isPlusActive(user)
      ? 40
      : 30;

  const exp = new Date(now);
  exp.setDate(exp.getDate() + expireDays);

  const sk = String(serviceKey || "EP").toUpperCase().trim();

  user.creditLots = user.creditLots || [];
  user.creditLots.push({
    serviceKey: sk, // ✅ CLAVE PARA REGLA EP/OTROS
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
   MercadoPago
======================= */
async function createMpPreference({ order, user }) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    return { ok: false, error: "MP_ACCESS_TOKEN no configurado." };
  }

  const FRONT_BASE = process.env.FRONT_BASE_URL || "https://app.duoclub.ar";

  const body = {
    items: [
      {
        title: `DUO - Compra`,
        quantity: 1,
        currency_id: "ARS",
        unit_price: Number(order.total || order.price || 0),
      },
    ],
    external_reference: String(order._id),
    metadata: {
      orderId: String(order._id),
      userId: String(user._id),
      payMethod: order.payMethod,
      itemsCount: Array.isArray(order.items) ? order.items.length : 0,
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
   ✅ NUEVO: POST /orders/checkout
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

    // armar items server-authority
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
        items.push({
          kind: "MEMBERSHIP",
          membershipTier: "plus",
          label: base.label,
          qty: 1,
          basePrice: base.basePrice,
          price: base.basePrice,
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

    const order = await Order.create({
      user: req.user._id,
      payMethod: pm,
      items,
      totalBase,
      total,
      status: "pending",
      applied: false,
    });

    if (pm === "CASH") {
      return res.status(201).json({
        ok: true,
        orderId: order._id,
        status: "pending",
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
    });
  } catch (err) {
    console.error("POST /orders/checkout", err);
    return res
      .status(500)
      .json({ error: err?.message || "Error creando orden." });
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
      // legacy fields
      serviceKey: sk,
      credits: cr,
      basePrice,
      plusIncluded: wantsPlus,
      plusPrice,
      price: total,
      label: plan.label || "",
      status: "pending",
      creditsApplied: false,
      applied: false, // por consistencia
    });

    if (pm === "CASH") {
      return res
        .status(201)
        .json({ ok: true, orderId: order._id, status: "pending" });
    }

    const mp = await createMpPreference({
      order: { ...order.toObject(), total: total },
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

    return res
      .status(201)
      .json({ ok: true, init_point: mp.init_point, orderId: order._id });
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
    .populate("user", "name email role membership credits")
    .sort({ createdAt: -1 })
    .lean();
  res.json(list);
});

/* =========================================================
   ✅ PATCH /orders/:id/mark-paid (solo CASH)
   ✅ marca paid + aplica items/legacy (idempotente)
========================================================= */
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
      return res
        .status(400)
        .json({ error: "Solo CASH puede marcarse manualmente" });
    }

    const st = String(order.status || "").toLowerCase();
    if (st === "paid" && order.applied) {
      return res.json({ ok: true, message: "Ya estaba pagada y aplicada" });
    }

    const user = await User.findById(order.user);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    // 1) marcar pagada
    order.status = "paid";
    order.paidAt = order.paidAt || new Date();

    // 2) aplicar una sola vez
    if (!order.applied) {
      ensureBasicIfExpired(user);

      const items = Array.isArray(order.items) ? order.items : [];

      const hasItems = items.length > 0;

      if (hasItems) {
        // === APLICAR ITEMS NUEVOS
        for (const it of items) {
          const kind = String(it.kind || "").toUpperCase();

          if (kind === "MEMBERSHIP") {
            // hoy solo plus
            activatePlus(user);
          }

          if (kind === "CREDITS") {
            const qty = Math.max(1, Number(it.qty) || 1);
            const credits = Math.max(0, Number(it.credits) || 0);
            const totalCredits = credits * qty;

            if (totalCredits > 0) {
              addCreditLot(user, {
                amount: totalCredits,
                serviceKey: it.serviceKey || "EP",
                source: "order",
                orderId: order._id,
              });
            }
          }
        }
      } else {
        // === APLICAR LEGACY
        if (order.plusIncluded) {
          activatePlus(user);
        }

        const legacyCredits = Math.max(0, Number(order.credits) || 0);
        if (legacyCredits > 0) {
          addCreditLot(user, {
            amount: legacyCredits,
            serviceKey: order.serviceKey || "EP",
            source: "order_legacy",
            orderId: order._id,
          });
        }
      }

      order.applied = true;
      await user.save();
    }

    await order.save();

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
