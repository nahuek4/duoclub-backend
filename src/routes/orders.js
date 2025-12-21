// backend/src/routes/orders.js
import express from "express";
import { protect, adminOnly } from "../middleware/auth.js";
import PricingPlan from "../models/PricingPlan.js";
import MembershipPlan from "../models/MembershipPlan.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import { startOrExtendMembership } from "../utils/membership.js";

const router = express.Router();

/* ======================================================
   MERCADOPAGO
====================================================== */

async function createMpPreference({ order, user }) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    return { ok: false, error: "MP_ACCESS_TOKEN no configurado." };
  }

  const FRONT_BASE = process.env.FRONT_BASE_URL || "https://app.duoclub.ar";

  const title =
    order.kind === "MEMBERSHIP"
      ? `DUO+ Membresía (${order.membershipDays || 30} días)`
      : `DUO - ${order.serviceKey} (${order.credits} créditos)`;

  const body = {
    items: [
      {
        title,
        quantity: 1,
        currency_id: "ARS",
        unit_price: Number(order.price),
      },
    ],
    external_reference: String(order._id),
    metadata: {
      orderId: String(order._id),
      userId: String(user._id),
      kind: String(order.kind),
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

/* ======================================================
   CLIENTE - CRÉDITOS
====================================================== */

// POST /orders  (compra créditos)
router.post("/", protect, async (req, res) => {
  try {
    const { serviceKey, credits, payMethod } = req.body || {};
    const sk = String(serviceKey || "").toUpperCase().trim();
    const pm = String(payMethod || "").toUpperCase().trim();
    const cr = Number(credits);

    if (!sk || !pm || !Number.isFinite(cr) || cr <= 0) {
      return res.status(400).json({ error: "Datos incompletos." });
    }

    const plan = await PricingPlan.findOne({
      serviceKey: sk,
      payMethod: pm,
      credits: cr,
      active: true,
    }).lean();

    if (!plan) return res.status(404).json({ error: "Plan inválido." });

    const order = await Order.create({
      user: req.user._id,
      kind: "CREDITS",
      serviceKey: sk,
      credits: cr,
      payMethod: pm,
      price: Number(plan.price || 0),
      label: plan.label || "",
      status: "pending",
    });

    if (pm === "CASH") {
      return res.status(201).json({ ok: true, orderId: order._id, status: "pending" });
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

    return res.status(201).json({ ok: true, init_point: mp.init_point, orderId: order._id });
  } catch (err) {
    console.error("POST /orders", err);
    return res.status(500).json({ error: "Error creando orden." });
  }
});

/* ======================================================
   CLIENTE - MEMBRESÍA
====================================================== */

// POST /orders/membership  (compra DUO+)
router.post("/membership", protect, async (req, res) => {
  try {
    const { payMethod } = req.body || {};
    const pm = String(payMethod || "").toUpperCase().trim();
    const tier = "PLUS";

    if (!pm) return res.status(400).json({ error: "Falta payMethod." });

    const plan = await MembershipPlan.findOne({
      tier,
      payMethod: pm,
      active: true,
    }).lean();

    if (!plan) {
      return res.status(404).json({ error: "Membresía inválida o inactiva." });
    }

    const order = await Order.create({
      user: req.user._id,
      kind: "MEMBERSHIP",
      membershipTier: tier,
      membershipDays: Number(plan.durationDays || 30),
      payMethod: pm,
      price: Number(plan.price || 0),
      label: plan.label || "DUO+ mensual",
      status: "pending",
    });

    if (pm === "CASH") {
      return res.status(201).json({ ok: true, orderId: order._id, status: "pending" });
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

    return res.status(201).json({ ok: true, init_point: mp.init_point, orderId: order._id });
  } catch (err) {
    console.error("POST /orders/membership", err);
    return res.status(500).json({ error: "Error creando orden de membresía." });
  }
});

// GET /orders/me
router.get("/me", protect, async (req, res) => {
  const list = await Order.find({ user: req.user._id }).sort({ createdAt: -1 }).lean();
  res.json(list);
});

/* ======================================================
   ADMIN
====================================================== */

// GET /orders
router.get("/", protect, adminOnly, async (req, res) => {
  const list = await Order.find()
    .populate("user", "name email membership")
    .sort({ createdAt: -1 })
    .lean();
  res.json(list);
});

// PATCH /orders/:id/mark-paid
router.patch("/:id/mark-paid", protect, adminOnly, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Orden no encontrada." });

    if (order.status === "paid") return res.status(400).json({ error: "Ya está pagada." });

    const user = await User.findById(order.user);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    // ✅ aplicar según tipo
    if (order.kind === "CREDITS") {
      if (!order.creditsApplied) {
        user.credits = (user.credits || 0) + Number(order.credits || 0);
        order.creditsApplied = true;
      }
    }

    if (order.kind === "MEMBERSHIP") {
      if (!order.membershipApplied) {
        startOrExtendMembership(user, {
          tier: order.membershipTier || "PLUS",
          days: order.membershipDays || 30,
        });
        order.membershipApplied = true;
      }
    }

    order.status = "paid";
    await user.save();
    await order.save();

    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /orders/:id/mark-paid", err);
    res.status(500).json({ error: "Error al marcar pagado." });
  }
});

export default router;
