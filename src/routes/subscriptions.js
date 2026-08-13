import express from "express";

import PricingPlan from "../models/PricingPlan.js";
import ServiceSubscription from "../models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../models/SubscriptionBillingCycle.js";
import SubscriptionLifecycleNotice from "../models/SubscriptionLifecycleNotice.js";
import { protect } from "../middleware/auth.js";
import {
  addMonthsToMonthKey,
  monthKeyFromDateArgentina,
} from "../services/subscriptions/subscriptionLifecycle.js";

const router = express.Router();
router.use(protect);

function userId(req) {
  return String(req.user?._id || req.user?.id || "");
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
