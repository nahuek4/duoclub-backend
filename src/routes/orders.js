// backend/src/routes/orders.js
import express from "express";
import { protect, adminOnly } from "../middleware/auth.js";
import PricingPlan from "../models/PricingPlan.js";
import Order from "../models/Order.js";
import User from "../models/User.js";

const router = express.Router();

/* ======================================================
   MERCADOPAGO
====================================================== */

async function createMpPreference({ order, user }) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) {
    return { ok: false, error: "MP_ACCESS_TOKEN no configurado." };
  }

  const FRONT_BASE =
    process.env.FRONT_BASE_URL || "https://app.duoclub.ar";

  const body = {
    items: [
      {
        title: `DUO - ${order.serviceKey} (${order.credits} créditos)`,
        quantity: 1,
        currency_id: "ARS",
        unit_price: Number(order.price),
      },
    ],
    external_reference: String(order._id),
    metadata: {
      orderId: String(order._id),
      userId: String(user._id),
    },
    back_urls: {
      success: `${FRONT_BASE}/?mp=success`,
      pending: `${FRONT_BASE}/?mp=pending`,
      failure: `${FRONT_BASE}/?mp=failure`,
    },
    auto_return: "approved",
    notification_url: process.env.MP_WEBHOOK_URL || undefined,
  };

  const resp = await fetch(
    "https://api.mercadopago.com/checkout/preferences",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    return {
      ok: false,
      error: data?.message || "Error creando preferencia MP",
    };
  }

  return {
    ok: true,
    preferenceId: data.id,
    init_point: data.init_point,
  };
}

/* ======================================================
   CLIENTE
====================================================== */

// POST /orders
router.post("/", protect, async (req, res) => {
  try {
    const { serviceKey, credits, payMethod } = req.body || {};
    const sk = String(serviceKey || "").toUpperCase();
    const pm = String(payMethod || "").toUpperCase();
    const cr = Number(credits);

    if (!sk || !pm || !cr) {
      return res.status(400).json({ error: "Datos incompletos." });
    }

    const plan = await PricingPlan.findOne({
      serviceKey: sk,
      payMethod: pm,
      credits: cr,
      active: true,
    }).lean();

    if (!plan) {
      return res.status(404).json({ error: "Plan inválido." });
    }

    const order = await Order.create({
      user: req.user._id,
      serviceKey: sk,
      credits: cr,
      payMethod: pm,
      price: plan.price,
      label: plan.label || "",
      status: "pending",
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

    res.status(201).json({
      ok: true,
      init_point: mp.init_point,
      orderId: order._id,
    });
  } catch (err) {
    console.error("POST /orders", err);
    res.status(500).json({ error: "Error creando orden." });
  }
});

// GET /orders/me
router.get("/me", protect, async (req, res) => {
  const list = await Order.find({ user: req.user._id })
    .sort({ createdAt: -1 })
    .lean();
  res.json(list);
});

/* ======================================================
   ADMIN
====================================================== */

// GET /orders
router.get("/", protect, adminOnly, async (req, res) => {
  const list = await Order.find()
    .populate("user", "name email")
    .sort({ createdAt: -1 })
    .lean();
  res.json(list);
});

// PATCH /orders/:id/mark-paid
router.patch("/:id/mark-paid", protect, adminOnly, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ error: "Orden no encontrada." });

    if (order.status === "paid") {
      return res.status(400).json({ error: "Ya está pagada." });
    }

    const user = await User.findById(order.user);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!order.creditsApplied) {
      user.credits = (user.credits || 0) + order.credits;
      await user.save();
      order.creditsApplied = true;
    }

    order.status = "paid";
    await order.save();

    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /orders/:id/mark-paid", err);
    res.status(500).json({ error: "Error al marcar pagado." });
  }
});

export default router;
