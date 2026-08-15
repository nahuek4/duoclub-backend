import express from "express";
import mongoose from "mongoose";

import { protect, adminOnly } from "../middleware/auth.js";
import User from "../models/User.js";
import PricingPlan from "../models/PricingPlan.js";
import FixedSchedule from "../models/FixedSchedule.js";
import ServiceSubscription from "../models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../models/SubscriptionBillingCycle.js";
import SubscriptionExtraSessionNotice from "../models/SubscriptionExtraSessionNotice.js";
import {
  addMonthsToMonthKey,
  monthKeyFromDateArgentina,
} from "../services/subscriptions/subscriptionLifecycle.js";

const router = express.Router();
router.use(protect, adminOnly);

const SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN", "NUT"]);
const SUBSCRIPTION_STATUSES = new Set([
  "active",
  "pending_change",
  "suspended",
  "cancelled",
  "terminated_for_non_payment",
]);
const BILLING_STATUSES = new Set(["pending", "paid", "overdue", "cancelled", "written_off"]);

function clean(value) {
  return String(value ?? "").trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function asInt(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function asMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function assertObjectId(value, label = "id") {
  const id = clean(value);
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const error = new Error(`${label} inválido.`);
    error.status = 400;
    throw error;
  }
  return id;
}

function assertServiceKey(value, optional = true) {
  const key = upper(value);
  if (!key && optional) return "";
  if (!SERVICE_KEYS.has(key)) {
    const error = new Error("Servicio inválido.");
    error.status = 400;
    throw error;
  }
  return key;
}

function assertSubscriptionStatus(value) {
  const status = clean(value);
  if (!status) return "";
  if (!SUBSCRIPTION_STATUSES.has(status)) {
    const error = new Error("Estado de suscripción inválido.");
    error.status = 400;
    throw error;
  }
  return status;
}

function assertBillingStatus(value) {
  const status = clean(value);
  if (!status) return "";
  if (!BILLING_STATUSES.has(status)) {
    const error = new Error("Estado de pago inválido.");
    error.status = 400;
    throw error;
  }
  return status;
}

function nextPeriodKey() {
  return addMonthsToMonthKey(monthKeyFromDateArgentina(), 1);
}

function userName(user) {
  if (!user) return "Usuario";
  return (
    clean(user.fullName) ||
    [clean(user.name), clean(user.lastName)].filter(Boolean).join(" ") ||
    clean(user.email) ||
    "Usuario"
  );
}

function serializePendingChange(pending) {
  if (!pending) return null;
  return {
    type: pending.type || "change",
    effectivePeriodKey: pending.effectivePeriodKey || "",
    requestedAt: pending.requestedAt || null,
    pricingPlanId: pending.pricingPlan ? String(pending.pricingPlan) : null,
    monthlySessions: pending.monthlySessions ?? null,
    price: pending.price ?? null,
    payMethod: pending.payMethod || "",
    autoRenew: pending.autoRenew !== false,
    reason: pending.reason || "",
  };
}

function serializeCycle(cycle) {
  if (!cycle) return null;
  return {
    id: String(cycle._id),
    periodKey: cycle.periodKey,
    sessions: asInt(cycle.planSnapshot?.monthlySessions),
    payMethod: cycle.planSnapshot?.payMethod || "",
    amount: asMoney(cycle.billing?.total),
    billingStatus: cycle.billing?.status || "",
    issuedAt: cycle.billing?.issuedAt || null,
    dueAt: cycle.billing?.dueAt || null,
    paidAt: cycle.billing?.paidAt || null,
    orderId: cycle.billing?.order ? String(cycle.billing.order) : null,
    planStatus: cycle.lifecycle?.planStatus || "",
    fixedOccurrences: asInt(cycle.coverage?.fixedOccurrencesCount),
    extraSessionsNeeded: asInt(cycle.coverage?.additionalSessionsStillNeeded),
    freeSessions: asInt(cycle.coverage?.freeSessions),
    creditsGranted: !!cycle.creditGrant?.granted,
    grantedSessions: asInt(cycle.creditGrant?.grantedSessions),
  };
}

function serializeExtra(extra) {
  if (!extra) return null;
  const required = asInt(extra.extraSessionsRequired);
  const purchased = asInt(extra.extraSessionsPurchased);
  return {
    id: String(extra._id),
    periodKey: extra.periodKey,
    status: extra.status,
    basePlanSessions: asInt(extra.basePlanSessions),
    fixedOccurrences: asInt(extra.projectedFixedOccurrences),
    required,
    purchased,
    remaining: Math.max(0, required - purchased),
    pendingOrderId: extra.pendingOrder ? String(extra.pendingOrder) : null,
  };
}

function serializeSubscription(subscription, { latestCycle = null, extra = null, fixed = null } = {}) {
  const pricingPlan = subscription.pricingPlan && typeof subscription.pricingPlan === "object"
    ? subscription.pricingPlan
    : null;
  const user = subscription.user && typeof subscription.user === "object"
    ? subscription.user
    : null;

  return {
    id: String(subscription._id),
    user: {
      id: user?._id ? String(user._id) : subscription.user ? String(subscription.user) : "",
      name: userName(user),
      email: clean(user?.email),
      phone: clean(user?.phone),
      role: clean(user?.role),
    },
    serviceKey: subscription.serviceKey,
    serviceName: subscription.serviceName || subscription.serviceKey,
    status: subscription.status,
    autoRenew: subscription.autoRenew !== false,
    pricingPlanId: pricingPlan?._id
      ? String(pricingPlan._id)
      : subscription.pricingPlan
        ? String(subscription.pricingPlan)
        : null,
    pricingPlanActive: pricingPlan ? pricingPlan.active !== false : null,
    monthlySessions: asInt(subscription.monthlySessions || pricingPlan?.credits),
    price: asMoney(subscription.price ?? pricingPlan?.price),
    regularPrice: asMoney(subscription.regularPrice || subscription.price || pricingPlan?.price),
    payMethod: subscription.payMethod || pricingPlan?.payMethod || "CASH",
    currentPeriodKey: subscription.currentPeriodKey || "",
    currentPeriodStart: subscription.currentPeriodStart || null,
    currentPeriodEnd: subscription.currentPeriodEnd || null,
    lastRenewedAt: subscription.lastRenewedAt || null,
    suspendedAt: subscription.suspendedAt || null,
    suspensionReason: subscription.suspensionReason || "",
    fixedSlotsProtectedUntil: subscription.fixedSlotsProtectedUntil || null,
    cancelledAt: subscription.cancelledAt || null,
    cancelReason: subscription.cancelReason || "",
    terminatedAt: subscription.terminatedAt || null,
    terminationReason: subscription.terminationReason || "",
    pendingChange: serializePendingChange(subscription.pendingChange),
    fixedSchedules: fixed || { schedules: 0, weeklySlots: 0 },
    latestCycle: serializeCycle(latestCycle),
    extra: serializeExtra(extra),
    createdAt: subscription.createdAt || null,
    updatedAt: subscription.updatedAt || null,
  };
}

async function loadOverviewData(subscriptions) {
  const subscriptionIds = subscriptions.map((s) => s._id);
  const userServicePairs = subscriptions
    .map((s) => ({
      user: s.user?._id || s.user,
      serviceKey: s.serviceKey,
    }))
    .filter((pair) => pair.user && mongoose.Types.ObjectId.isValid(String(pair.user)));

  const [cycles, extras, fixedSchedules] = await Promise.all([
    SubscriptionBillingCycle.find({ subscription: { $in: subscriptionIds } })
      .sort({ periodKey: -1, createdAt: -1 })
      .lean(),
    SubscriptionExtraSessionNotice.find({
      subscription: { $in: subscriptionIds },
      status: { $in: ["pending", "order_pending", "covered"] },
    })
      .sort({ periodKey: -1, createdAt: -1 })
      .lean(),
    userServicePairs.length
      ? FixedSchedule.find({
          active: true,
          $or: userServicePairs,
        })
          .select("user serviceKey items active")
          .lean()
      : [],
  ]);

  const cycleBySubscription = new Map();
  for (const cycle of cycles) {
    const key = String(cycle.subscription);
    if (!cycleBySubscription.has(key)) cycleBySubscription.set(key, cycle);
  }

  const extraBySubscription = new Map();
  for (const extra of extras) {
    const key = String(extra.subscription);
    if (!extraBySubscription.has(key)) extraBySubscription.set(key, extra);
  }

  const fixedByPair = new Map();
  for (const schedule of fixedSchedules) {
    const key = `${String(schedule.user)}:${schedule.serviceKey}`;
    const current = fixedByPair.get(key) || { schedules: 0, weeklySlots: 0 };
    current.schedules += 1;
    current.weeklySlots += Array.isArray(schedule.items) ? schedule.items.length : 0;
    fixedByPair.set(key, current);
  }

  return { cycleBySubscription, extraBySubscription, fixedByPair };
}

function buildSummary(items) {
  const summary = {
    total: items.length,
    active: 0,
    pendingChange: 0,
    suspended: 0,
    cancelled: 0,
    terminated: 0,
    unpaidCycles: 0,
    paidCycles: 0,
    extrasPending: 0,
    extrasSessions: 0,
  };

  for (const item of items) {
    if (item.status === "active") summary.active += 1;
    if (item.status === "pending_change") summary.pendingChange += 1;
    if (item.status === "suspended") summary.suspended += 1;
    if (item.status === "cancelled") summary.cancelled += 1;
    if (item.status === "terminated_for_non_payment") summary.terminated += 1;

    if (["pending", "overdue"].includes(item.latestCycle?.billingStatus)) {
      summary.unpaidCycles += 1;
    }
    if (item.latestCycle?.billingStatus === "paid") summary.paidCycles += 1;

    if (item.extra?.remaining > 0) {
      summary.extrasPending += 1;
      summary.extrasSessions += item.extra.remaining;
    }
  }
  return summary;
}

router.get("/catalog", async (req, res) => {
  try {
    const serviceKey = assertServiceKey(req.query?.serviceKey, false);
    const plans = await PricingPlan.find({
      active: true,
      isCustom: { $ne: true },
      serviceKey,
    })
      .sort({ credits: 1, payMethod: 1, price: 1 })
      .lean();

    return res.json({
      plans: plans.map((plan) => ({
        id: String(plan._id),
        serviceKey: plan.serviceKey,
        label: clean(plan.label || plan.title || `${plan.credits} sesiones`),
        sessions: asInt(plan.credits),
        price: asMoney(plan.price),
        payMethod: plan.payMethod,
      })),
    });
  } catch (error) {
    return res.status(Number(error?.status || 500)).json({
      error: error?.message || "No se pudo cargar el catálogo.",
    });
  }
});

router.get("/", async (req, res) => {
  try {
    const query = {};
    const serviceKey = assertServiceKey(req.query?.serviceKey, true);
    const status = assertSubscriptionStatus(req.query?.status);
    const billingStatus = assertBillingStatus(req.query?.billingStatus);
    const q = clean(req.query?.q).toLowerCase();

    if (serviceKey) query.serviceKey = serviceKey;
    if (status) query.status = status;

    const subscriptions = await ServiceSubscription.find(query)
      .populate("user", "name lastName fullName email phone role")
      .populate("pricingPlan", "serviceKey credits price payMethod active label title")
      .sort({ updatedAt: -1 })
      .limit(750)
      .lean();

    const { cycleBySubscription, extraBySubscription, fixedByPair } =
      await loadOverviewData(subscriptions);

    let items = subscriptions.map((subscription) => {
      const userId = subscription.user?._id || subscription.user;
      return serializeSubscription(subscription, {
        latestCycle: cycleBySubscription.get(String(subscription._id)) || null,
        extra: extraBySubscription.get(String(subscription._id)) || null,
        fixed: fixedByPair.get(`${String(userId)}:${subscription.serviceKey}`) || {
          schedules: 0,
          weeklySlots: 0,
        },
      });
    });

    if (billingStatus) {
      items = items.filter((item) => item.latestCycle?.billingStatus === billingStatus);
    }

    if (q) {
      items = items.filter((item) => {
        const haystack = [
          item.user?.name,
          item.user?.email,
          item.serviceKey,
          item.serviceName,
        ]
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      });
    }

    return res.json({
      items,
      summary: buildSummary(items),
      filters: { q, serviceKey, status, billingStatus },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("GET /admin/plans", error);
    return res.status(Number(error?.status || 500)).json({
      error: error?.message || "No se pudieron cargar los planes.",
    });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const id = assertObjectId(req.params.id, "subscriptionId");
    const subscription = await ServiceSubscription.findById(id)
      .populate("user", "name lastName fullName email phone role")
      .populate("pricingPlan", "serviceKey credits price payMethod active label title")
      .lean();

    if (!subscription) return res.status(404).json({ error: "Suscripción no encontrada." });

    const [cycles, extras, fixedSchedules] = await Promise.all([
      SubscriptionBillingCycle.find({ subscription: id })
        .sort({ periodKey: -1 })
        .limit(12)
        .lean(),
      SubscriptionExtraSessionNotice.find({ subscription: id })
        .sort({ periodKey: -1 })
        .limit(12)
        .lean(),
      FixedSchedule.find({
        user: subscription.user?._id || subscription.user,
        serviceKey: subscription.serviceKey,
        active: true,
      })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const latestCycle = cycles[0] || null;
    const extra = extras.find((item) => ["pending", "order_pending"].includes(item.status)) || extras[0] || null;

    return res.json({
      item: serializeSubscription(subscription, {
        latestCycle,
        extra,
        fixed: {
          schedules: fixedSchedules.length,
          weeklySlots: fixedSchedules.reduce(
            (sum, schedule) => sum + (Array.isArray(schedule.items) ? schedule.items.length : 0),
            0
          ),
        },
      }),
      cycles: cycles.map(serializeCycle),
      extras: extras.map(serializeExtra),
      fixedSchedules: fixedSchedules.map((schedule) => ({
        id: String(schedule._id),
        startDate: schedule.startDate || "",
        endDate: schedule.endDate || "",
        active: schedule.active !== false,
        items: (schedule.items || []).map((item) => ({
          weekday: item.weekday,
          time: item.time,
        })),
      })),
    });
  } catch (error) {
    console.error("GET /admin/plans/:id", error);
    return res.status(Number(error?.status || 500)).json({
      error: error?.message || "No se pudo cargar la suscripción.",
    });
  }
});

router.post("/:id/change-next", async (req, res) => {
  try {
    const id = assertObjectId(req.params.id, "subscriptionId");
    const subscription = await ServiceSubscription.findById(id);
    if (!subscription) return res.status(404).json({ error: "Suscripción no encontrada." });

    if (["cancelled", "terminated_for_non_payment"].includes(subscription.status)) {
      return res.status(400).json({ error: "Esta suscripción no admite un cambio programado." });
    }

    const pricingPlanId = assertObjectId(req.body?.pricingPlanId, "pricingPlanId");
    const plan = await PricingPlan.findOne({
      _id: pricingPlanId,
      active: true,
      isCustom: { $ne: true },
      serviceKey: subscription.serviceKey,
    }).lean();

    if (!plan) {
      return res.status(400).json({ error: "El plan elegido no está publicado para este servicio." });
    }

    const effectivePeriodKey = nextPeriodKey();
    subscription.pendingChange = {
      type: "change",
      effectivePeriodKey,
      requestedAt: new Date(),
      requestedBy: req.user?._id || req.user?.id,
      pricingPlan: plan._id,
      monthlySessions: asInt(plan.credits),
      price: asMoney(plan.price),
      payMethod: plan.payMethod,
      fixedScheduleIds: subscription.fixedScheduleIds || [],
      addOns: subscription.addOns || [],
      autoRenew: true,
      reason: clean(req.body?.reason) || "Cambio programado por administración.",
    };
    if (subscription.status !== "suspended") subscription.status = "pending_change";
    subscription.updatedBy = req.user?._id || req.user?.id;
    await subscription.save();

    return res.json({ ok: true, effectivePeriodKey, pendingChange: serializePendingChange(subscription.pendingChange) });
  } catch (error) {
    console.error("POST /admin/plans/:id/change-next", error);
    return res.status(Number(error?.status || 500)).json({ error: error?.message || "No se pudo programar el cambio." });
  }
});

router.post("/:id/suspend", async (req, res) => {
  try {
    const id = assertObjectId(req.params.id, "subscriptionId");
    const subscription = await ServiceSubscription.findById(id);
    if (!subscription) return res.status(404).json({ error: "Suscripción no encontrada." });

    if (["cancelled", "terminated_for_non_payment"].includes(subscription.status)) {
      return res.status(400).json({ error: "Esta suscripción ya no puede suspenderse." });
    }

    subscription.status = "suspended";
    subscription.suspendedAt = new Date();
    subscription.suspensionReason = clean(req.body?.reason) || "Suspensión manual desde administración.";
    subscription.pendingChange = null;
    subscription.updatedBy = req.user?._id || req.user?.id;
    await subscription.save();

    return res.json({ ok: true, status: subscription.status });
  } catch (error) {
    return res.status(Number(error?.status || 500)).json({ error: error?.message || "No se pudo suspender el plan." });
  }
});

router.post("/:id/reactivate", async (req, res) => {
  try {
    const id = assertObjectId(req.params.id, "subscriptionId");
    const subscription = await ServiceSubscription.findById(id);
    if (!subscription) return res.status(404).json({ error: "Suscripción no encontrada." });

    if (subscription.status === "terminated_for_non_payment") {
      return res.status(400).json({
        error: "El plan fue terminado por falta de pago. Debe contratarse nuevamente un plan publicado.",
      });
    }
    if (subscription.status === "cancelled") {
      return res.status(400).json({
        error: "El plan está cancelado. Debe contratarse nuevamente un plan publicado.",
      });
    }

    const latestCycle = await SubscriptionBillingCycle.findOne({ subscription: id })
      .sort({ periodKey: -1 })
      .lean();
    const unpaidCurrent = latestCycle && ["pending", "overdue"].includes(latestCycle.billing?.status);
    const suspendedForNonPayment = latestCycle?.lifecycle?.planStatus === "suspended";

    if (unpaidCurrent && suspendedForNonPayment) {
      return res.status(409).json({
        error: "El servicio está suspendido por falta de pago. Marcá la orden/ciclo como pagado para reactivarlo automáticamente.",
      });
    }

    subscription.status = "active";
    subscription.autoRenew = true;
    subscription.suspendedAt = null;
    subscription.suspensionReason = "";
    if (["suspend", "cancel"].includes(subscription.pendingChange?.type)) {
      subscription.pendingChange = null;
    }
    subscription.updatedBy = req.user?._id || req.user?.id;
    await subscription.save();

    return res.json({ ok: true, status: subscription.status });
  } catch (error) {
    return res.status(Number(error?.status || 500)).json({ error: error?.message || "No se pudo reactivar el plan." });
  }
});

router.post("/:id/cancel-next", async (req, res) => {
  try {
    const id = assertObjectId(req.params.id, "subscriptionId");
    const subscription = await ServiceSubscription.findById(id);
    if (!subscription) return res.status(404).json({ error: "Suscripción no encontrada." });

    if (["cancelled", "terminated_for_non_payment"].includes(subscription.status)) {
      return res.status(400).json({ error: "La suscripción ya está finalizada." });
    }

    const effectivePeriodKey = nextPeriodKey();
    subscription.pendingChange = {
      type: "cancel",
      effectivePeriodKey,
      requestedAt: new Date(),
      requestedBy: req.user?._id || req.user?.id,
      autoRenew: false,
      reason: clean(req.body?.reason) || "Cancelación de renovación programada por administración.",
    };
    if (subscription.status !== "suspended") subscription.status = "pending_change";
    subscription.updatedBy = req.user?._id || req.user?.id;
    await subscription.save();

    return res.json({ ok: true, effectivePeriodKey });
  } catch (error) {
    return res.status(Number(error?.status || 500)).json({ error: error?.message || "No se pudo programar la cancelación." });
  }
});

router.post("/:id/clear-change", async (req, res) => {
  try {
    const id = assertObjectId(req.params.id, "subscriptionId");
    const subscription = await ServiceSubscription.findById(id);
    if (!subscription) return res.status(404).json({ error: "Suscripción no encontrada." });
    if (!subscription.pendingChange) {
      return res.json({ ok: true, alreadyClear: true, status: subscription.status });
    }

    subscription.pendingChange = null;
    if (subscription.status === "pending_change") subscription.status = "active";
    subscription.updatedBy = req.user?._id || req.user?.id;
    await subscription.save();

    return res.json({ ok: true, status: subscription.status });
  } catch (error) {
    return res.status(Number(error?.status || 500)).json({ error: error?.message || "No se pudo quitar el cambio programado." });
  }
});

export default router;
