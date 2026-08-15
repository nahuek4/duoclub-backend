import express from "express";

import PricingPlan from "../models/PricingPlan.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import ServiceSubscription from "../models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../models/SubscriptionBillingCycle.js";
import SubscriptionLifecycleNotice from "../models/SubscriptionLifecycleNotice.js";
import { protect } from "../middleware/auth.js";
import {
  addMonthsToMonthKey,
  monthKeyFromDateArgentina,
} from "../services/subscriptions/subscriptionLifecycle.js";
import {
  buildSubscriptionRenewalItem,
  applySubscriptionRenewalFromOrder,
} from "../services/subscriptions/subscriptionCyclePayments.js";

const router = express.Router();
router.use(protect);

function userId(req) {
  return String(req.user?._id || req.user?.id || "");
}


function getFrontBaseUrl() {
  return String(
    process.env.FRONTEND_URL ||
      process.env.FRONT_BASE_URL ||
      process.env.APP_URL ||
      "https://duoclub.ar"
  ).replace(/\/+$/, "");
}

async function createMpPreferenceForRenewal({ order, user, cycle }) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) throw new Error("MP_ACCESS_TOKEN no configurado.");

  const amount = Math.max(0, Number(order.totalFinal ?? order.total ?? 0));
  if (!(amount > 0)) throw new Error("El ciclo no tiene un importe válido para Mercado Pago.");

  const frontBase = getFrontBaseUrl();
  const body = {
    items: [
      {
        title: `DUO - Renovación ${cycle.serviceKey} ${cycle.periodKey}`,
        quantity: 1,
        currency_id: "ARS",
        unit_price: amount,
      },
    ],
    external_reference: String(order._id),
    metadata: {
      orderId: String(order._id),
      userId: String(user?._id || order.user || ""),
      subscriptionCycleId: String(cycle._id),
      subscriptionId: String(cycle.subscription),
      periodKey: cycle.periodKey,
      kind: "SUBSCRIPTION_RENEWAL",
    },
    back_urls: {
      success: `${frontBase}/?mp=success`,
      pending: `${frontBase}/?mp=pending`,
      failure: `${frontBase}/?mp=failure`,
    },
    auto_return: "approved",
    notification_url: process.env.MP_WEBHOOK_URL || undefined,
  };

  if (user?.email) body.payer = { email: String(user.email).trim() };

  const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || "No se pudo crear la preferencia de Mercado Pago.");
  }

  return { preferenceId: data.id, initPoint: data.init_point };
}

function renewalOrderResponse(order) {
  return {
    orderId: String(order._id),
    status: order.status,
    payMethod: order.payMethod,
    amount: Number(order.totalFinal ?? order.total ?? 0),
    init_point: order.mpInitPoint || "",
  };
}

function serializeSubscription(subscription, cycles = []) {
  return {
    id: String(subscription._id),
    serviceKey: subscription.serviceKey,
    serviceName: subscription.serviceName,
    status: subscription.status,
    autoRenew: subscription.autoRenew,
    monthlySessions: subscription.monthlySessions,
    price: subscription.price,
    regularPrice: subscription.regularPrice,
    payMethod: subscription.payMethod,
    pricingPlan: subscription.pricingPlan,
    currentPeriodKey: subscription.currentPeriodKey,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    fixedSlotsProtectedUntil: subscription.fixedSlotsProtectedUntil,
    pendingChange: subscription.pendingChange,
    cycles: cycles.map((cycle) => ({
      id: String(cycle._id),
      periodKey: cycle.periodKey,
      billingStatus: cycle.billing?.status,
      amount: cycle.billing?.total || 0,
      dueAt: cycle.billing?.dueAt || null,
      paidAt: cycle.billing?.paidAt || null,
      planStatus: cycle.lifecycle?.planStatus,
      sessions: cycle.planSnapshot?.monthlySessions || 0,
      creditsGranted: !!cycle.creditGrant?.granted,
    })),
  };
}

router.get("/me", async (req, res) => {
  try {
    const uid = userId(req);
    const subscriptions = await ServiceSubscription.find({ user: uid })
      .populate("pricingPlan", "serviceKey credits price payMethod active label title")
      .sort({ serviceKey: 1 })
      .lean();

    const subscriptionIds = subscriptions.map((item) => item._id);
    const cycles = await SubscriptionBillingCycle.find({
      subscription: { $in: subscriptionIds },
    })
      .sort({ periodKey: -1 })
      .lean();

    const bySubscription = new Map();
    for (const cycle of cycles) {
      const key = String(cycle.subscription);
      if (!bySubscription.has(key)) bySubscription.set(key, []);
      if (bySubscription.get(key).length < 3) bySubscription.get(key).push(cycle);
    }

    return res.json({
      subscriptions: subscriptions.map((subscription) =>
        serializeSubscription(
          subscription,
          bySubscription.get(String(subscription._id)) || []
        )
      ),
    });
  } catch (error) {
    console.error("GET /subscriptions/me", error);
    return res.status(500).json({ error: "No se pudieron cargar tus planes." });
  }
});

router.get("/notices", async (req, res) => {
  try {
    const notices = await SubscriptionLifecycleNotice.find({
      user: userId(req),
      status: { $in: ["unread", "read"] },
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      notices: notices.map((notice) => ({
        id: String(notice._id),
        subscriptionId: String(notice.subscription),
        cycleId: notice.cycle ? String(notice.cycle) : null,
        serviceKey: notice.serviceKey,
        periodKey: notice.periodKey,
        type: notice.type,
        title: notice.title,
        message: notice.message,
        action: notice.action,
        actionRequired: notice.actionRequired,
        status: notice.status,
        metadata: notice.metadata || {},
        createdAt: notice.createdAt,
      })),
    });
  } catch (error) {
    console.error("GET /subscriptions/notices", error);
    return res.status(500).json({ error: "No se pudieron cargar las notificaciones." });
  }
});

router.patch("/notices/:id/read", async (req, res) => {
  try {
    const notice = await SubscriptionLifecycleNotice.findOneAndUpdate(
      { _id: req.params.id, user: userId(req) },
      { $set: { status: "read", readAt: new Date() } },
      { new: true }
    );
    if (!notice) return res.status(404).json({ error: "Notificación no encontrada." });
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: "No se pudo actualizar la notificación." });
  }
});


router.post("/cycles/:cycleId/pay", async (req, res) => {
  try {
    const uid = userId(req);
    const cycle = await SubscriptionBillingCycle.findOne({
      _id: req.params.cycleId,
      user: uid,
    });

    if (!cycle) return res.status(404).json({ error: "Ciclo mensual no encontrado." });

    if (cycle.billing?.status === "paid") {
      return res.json({
        ok: true,
        alreadyPaid: true,
        cycleId: String(cycle._id),
        billingStatus: "paid",
      });
    }

    if (!["pending", "overdue"].includes(String(cycle.billing?.status || ""))) {
      return res.status(400).json({ error: "Este ciclo no admite pagos en su estado actual." });
    }

    const subscription = await ServiceSubscription.findOne({
      _id: cycle.subscription,
      user: uid,
    });
    if (!subscription) return res.status(404).json({ error: "Suscripción no encontrada." });

    const expectedMethod = String(cycle.planSnapshot?.payMethod || subscription.payMethod || "CASH")
      .toUpperCase()
      .trim();
    const requestedMethod = String(req.body?.payMethod || expectedMethod).toUpperCase().trim();

    if (requestedMethod !== expectedMethod) {
      return res.status(400).json({
        error: `Este plan se renueva mediante ${expectedMethod === "MP" ? "Mercado Pago" : "efectivo/transferencia"}. Para cambiar el medio de pago, modificá el plan del próximo período.`,
      });
    }

    if (cycle.billing?.order) {
      const existingOrder = await Order.findById(cycle.billing.order);
      if (existingOrder) {
        const status = String(existingOrder.status || "").toLowerCase();

        if (status === "paid" || status === "approved") {
          if (!existingOrder.subscriptionCycleApplied) {
            await applySubscriptionRenewalFromOrder({
              order: existingOrder,
              paymentProvider: existingOrder.payMethod,
              paymentId: existingOrder.mpPaymentId || "",
              paidAt: existingOrder.paidAt || new Date(),
            });
            existingOrder.subscriptionCycleApplied = true;
            existingOrder.applied = true;
            await existingOrder.save();
          }
          return res.json({ ok: true, alreadyPaid: true, ...renewalOrderResponse(existingOrder) });
        }

        if (status === "pending") {
          if (expectedMethod === "MP" && !existingOrder.mpInitPoint) {
            const user = await User.findById(uid).lean();
            const mp = await createMpPreferenceForRenewal({ order: existingOrder, user, cycle });
            existingOrder.mpPreferenceId = mp.preferenceId;
            existingOrder.mpInitPoint = mp.initPoint;
            await existingOrder.save();
          }

          return res.json({ ok: true, reused: true, ...renewalOrderResponse(existingOrder) });
        }
      }
    }

    const item = buildSubscriptionRenewalItem({ cycle, subscription });
    const amount = Math.max(0, Math.round(Number(cycle.billing?.total || 0)));
    if (!(amount > 0)) {
      return res.status(400).json({ error: "El ciclo mensual no tiene saldo pendiente." });
    }

    const order = await Order.create({
      user: uid,
      payMethod: expectedMethod,
      items: [item],
      totalBase: amount,
      total: amount,
      totalFinal: amount,
      status: "pending",
      applied: false,
      creditsApplied: false,
      subscriptionExtraApplied: false,
      subscriptionCycleApplied: false,
      suppressUserEmails: true,
      notes: `Renovación mensual ${cycle.serviceKey} ${cycle.periodKey}. Las sesiones ya fueron acreditadas por el ciclo; esta orden solo registra el cobro.`,
    });

    cycle.billing.order = order._id;
    await cycle.save();

    if (expectedMethod === "MP") {
      try {
        const user = await User.findById(uid).lean();
        const mp = await createMpPreferenceForRenewal({ order, user, cycle });
        order.mpPreferenceId = mp.preferenceId;
        order.mpInitPoint = mp.initPoint;
        await order.save();
      } catch (error) {
        order.status = "cancelled";
        order.notes = `${order.notes}\nNo se pudo generar Mercado Pago: ${error?.message || error}`;
        await order.save();
        cycle.billing.order = null;
        await cycle.save();
        throw error;
      }
    }

    return res.status(201).json({ ok: true, ...renewalOrderResponse(order) });
  } catch (error) {
    console.error("POST /subscriptions/cycles/:cycleId/pay", error);
    return res.status(500).json({ error: error?.message || "No se pudo generar el pago mensual." });
  }
});

router.post("/:id/change-next", async (req, res) => {
  try {
    const subscription = await ServiceSubscription.findOne({
      _id: req.params.id,
      user: userId(req),
    });
    if (!subscription) return res.status(404).json({ error: "Plan no encontrado." });

    const pricingPlanId = String(req.body?.pricingPlanId || "");
    const plan = await PricingPlan.findOne({
      _id: pricingPlanId,
      active: true,
      isCustom: { $ne: true },
      serviceKey: subscription.serviceKey,
    }).lean();
    if (!plan) {
      return res.status(400).json({ error: "El plan elegido no está publicado para este servicio." });
    }

    const effectivePeriodKey = addMonthsToMonthKey(monthKeyFromDateArgentina(), 1);
    subscription.pendingChange = {
      type: "change",
      effectivePeriodKey,
      requestedAt: new Date(),
      requestedBy: req.user?._id || req.user?.id,
      pricingPlan: plan._id,
      monthlySessions: Number(plan.credits || 0),
      price: Number(plan.price || 0),
      payMethod: plan.payMethod,
      fixedScheduleIds: subscription.fixedScheduleIds || [],
      addOns: subscription.addOns || [],
      autoRenew: true,
      reason: "Cambio solicitado por el usuario desde Mi Plan.",
    };
    subscription.status = "pending_change";
    await subscription.save();

    return res.json({
      ok: true,
      effectivePeriodKey,
      pendingChange: subscription.pendingChange,
    });
  } catch (error) {
    console.error("POST /subscriptions/:id/change-next", error);
    return res.status(500).json({ error: "No se pudo programar el cambio de plan." });
  }
});

router.post("/:id/cancel-next", async (req, res) => {
  try {
    const subscription = await ServiceSubscription.findOne({
      _id: req.params.id,
      user: userId(req),
    });
    if (!subscription) return res.status(404).json({ error: "Plan no encontrado." });

    const effectivePeriodKey = addMonthsToMonthKey(monthKeyFromDateArgentina(), 1);
    subscription.pendingChange = {
      type: "cancel",
      effectivePeriodKey,
      requestedAt: new Date(),
      requestedBy: req.user?._id || req.user?.id,
      autoRenew: false,
      reason: "Cancelación solicitada por el usuario para el próximo período.",
    };
    subscription.status = "pending_change";
    await subscription.save();
    return res.json({ ok: true, effectivePeriodKey });
  } catch (error) {
    return res.status(500).json({ error: "No se pudo programar la cancelación." });
  }
});

router.post("/:id/suspend-next", async (req, res) => {
  try {
    const subscription = await ServiceSubscription.findOne({
      _id: req.params.id,
      user: userId(req),
    });
    if (!subscription) return res.status(404).json({ error: "Plan no encontrado." });

    const effectivePeriodKey = addMonthsToMonthKey(monthKeyFromDateArgentina(), 1);
    subscription.pendingChange = {
      type: "suspend",
      effectivePeriodKey,
      requestedAt: new Date(),
      requestedBy: req.user?._id || req.user?.id,
      autoRenew: false,
      reason: "Suspensión solicitada por el usuario para el próximo período.",
    };
    subscription.status = "pending_change";
    await subscription.save();
    return res.json({ ok: true, effectivePeriodKey });
  } catch (error) {
    return res.status(500).json({ error: "No se pudo programar la suspensión." });
  }
});

export default router;
