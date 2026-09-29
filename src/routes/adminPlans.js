import express from "express";
import mongoose from "mongoose";

import { protect, adminOnly } from "../middleware/auth.js";
import User from "../models/User.js";
import PricingPlan from "../models/PricingPlan.js";
import Order from "../models/Order.js";
import FixedSchedule from "../models/FixedSchedule.js";
import ServiceSubscription from "../models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../models/SubscriptionBillingCycle.js";
import SubscriptionExtraSessionNotice from "../models/SubscriptionExtraSessionNotice.js";
import {
  addMonthsToMonthKey,
  monthKeyFromDateArgentina,
} from "../services/subscriptions/subscriptionLifecycle.js";
import {
  ensureServiceCatalogLoaded,
  isServiceEnabledFor,
  normalizeCatalogServiceKey,
} from "../services/serviceCatalogRuntime.js";

// STEP3B2_DYNAMIC_ADMIN_PLANS

const router = express.Router();
router.use(protect, adminOnly);
router.use(async (req, res, next) => {
  await ensureServiceCatalogLoaded();
  next();
});
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
  const raw = clean(value);
  if (!raw && optional) return "";

  const key = normalizeCatalogServiceKey(raw);
  if (
    !key ||
    !isServiceEnabledFor(key, "recurringPlanEnabled")
  ) {
    const error = new Error(
      "Servicio inválido o sin plan mensual habilitado."
    );
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

function isPaidOrderStatus(value) {
  return ["paid", "approved"].includes(clean(value).toLowerCase());
}

function orderId(value) {
  const id = clean(value?._id || value?.id || value);
  return mongoose.Types.ObjectId.isValid(id) ? id : "";
}

function orderAmount(order) {
  return asMoney(order?.totalFinal ?? order?.total ?? order?.price);
}

function bootstrapExtraForSubscription(subscription) {
  const bootstrap = subscription?.bootstrap || {};
  const historicalRequired = asInt(bootstrap?.extraSessionsRequired);
  const periodKey = clean(bootstrap?.monthKey);
  if (!historicalRequired || !/^\d{4}-\d{2}$/.test(periodKey)) return null;

  const basePlanSessions = Math.max(
    1,
    asInt(bootstrap?.basePlanSessions || subscription?.monthlySessions)
  );
  const paidCredits = asInt(
    bootstrap?.paidCredits || bootstrap?.latestPaidOrder?.sessions
  );
  const inferredPurchased = Math.min(
    historicalRequired,
    Math.max(0, paidCredits - basePlanSessions)
  );

  return {
    subscriptionId: String(subscription?._id || ""),
    periodKey,
    basePlanSessions,
    fixedOccurrences: Math.max(
      asInt(bootstrap?.projectedFixedOccurrences),
      basePlanSessions + historicalRequired
    ),
    historicalRequired,
    inferredPurchased,
    paidOrderId:
      inferredPurchased > 0 && bootstrap?.latestPaidOrder?.orderId
        ? String(bootstrap.latestPaidOrder.orderId)
        : null,
    initializedAt: bootstrap?.initializedAt || subscription?.createdAt || null,
    source: clean(bootstrap?.source) || "legacy_migration",
  };
}

function sessionsFromOrderForNotice(order, noticeId) {
  const target = clean(noticeId);
  return (Array.isArray(order?.items) ? order.items : [])
    .filter((item) => {
      const kind = upper(item?.kind);
      const itemNotice = clean(item?.extraSessionNotice);
      return kind === "SUBSCRIPTION_EXTRA" && target && itemNotice === target;
    })
    .reduce(
      (sum, item) => sum + asInt(item?.credits) * Math.max(1, asInt(item?.qty) || 1),
      0
    );
}

function serializeOrderLink(order, { noticeId = "", fallbackSessions = 0 } = {}) {
  if (!order) return null;
  const id = orderId(order);
  if (!id) return null;

  const sessions =
    sessionsFromOrderForNotice(order, noticeId) || asInt(fallbackSessions);

  return {
    id,
    status: clean(order.status).toLowerCase(),
    paid: isPaidOrderStatus(order.status),
    payMethod: upper(order.payMethod),
    amount: orderAmount(order),
    paidAt: order.paidAt || null,
    createdAt: order.createdAt || null,
    sessions,
  };
}

function serializeExtra(extra, orderById = new Map(), bootstrap = null) {
  if (!extra && !bootstrap) return null;

  const rawId = extra?._id ? String(extra._id) : "";
  const periodKey = clean(extra?.periodKey || bootstrap?.periodKey);
  const bootstrapRequired = asInt(bootstrap?.historicalRequired);
  // Un bootstrap sin notice moderno es evidencia histórica, no deuda actual.
  // Aunque el bootstrap sea del mes corriente, no inventamos un pendiente
  // vigente: el pendiente actual solo nace de SubscriptionExtraSessionNotice.
  const historicalOnly = !extra && Boolean(bootstrap);
  const currentRequired = extra ? asInt(extra?.extraSessionsRequired) : 0;
  const historicalRequired = Math.max(
    currentRequired,
    asInt(extra?.historicalExtraSessionsRequired),
    bootstrapRequired
  );

  // El contexto histórico debe corresponder al momento en que se generó el
  // máximo de diferencia. No usamos Math.max contra el estado actual porque
  // un cambio posterior de plan podría falsear el histórico (ej. debía con 8
  // y hoy tiene 12).
  const historicalBasePlanSessions =
    asInt(extra?.historicalBasePlanSessions) ||
    asInt(bootstrap?.basePlanSessions) ||
    asInt(extra?.basePlanSessions);
  const historicalFixedOccurrences =
    asInt(extra?.historicalFixedOccurrences) ||
    asInt(bootstrap?.fixedOccurrences) ||
    asInt(extra?.projectedFixedOccurrences);

  const rawPurchased = asInt(extra?.extraSessionsPurchased);
  const purchasedIds = new Set(
    (Array.isArray(extra?.purchasedOrderIds) ? extra.purchasedOrderIds : [])
      .map((value) => orderId(value))
      .filter(Boolean)
  );
  const lastPaidOrderId = orderId(extra?.lastPaidOrder);
  if (lastPaidOrderId) purchasedIds.add(lastPaidOrderId);

  const bootstrapOrderId = orderId(bootstrap?.paidOrderId);
  let purchased = rawPurchased;
  let bootstrapPurchasedApplied = 0;

  if (bootstrap && asInt(bootstrap.inferredPurchased) > 0) {
    if (!bootstrapOrderId || !purchasedIds.has(bootstrapOrderId)) {
      bootstrapPurchasedApplied = asInt(bootstrap.inferredPurchased);
      purchased += bootstrapPurchasedApplied;
    }
    if (bootstrapOrderId) purchasedIds.add(bootstrapOrderId);
  }

  // La diferencia histórica puede haberse reducido porque se canceló/eliminó
  // un turno. "released" conserva esa historia sin seguir cobrando algo que ya
  // no corresponde al estado actual.
  const remaining = Math.max(0, currentRequired - purchased);
  const released = Math.max(
    0,
    historicalRequired - Math.max(currentRequired, purchased)
  );
  const paidAgainstDifference = Math.min(historicalRequired, purchased);

  let paymentState = "none";
  if (historicalRequired > 0) {
    if (historicalOnly && purchased <= 0) paymentState = "historical";
    else if (remaining > 0 && purchased > 0) paymentState = "partial";
    else if (remaining > 0) paymentState = "pending";
    else if (purchased >= historicalRequired) paymentState = "paid";
    else if (currentRequired <= 0 && purchased <= 0) paymentState = "released";
    else if (released > 0 && purchased > 0) paymentState = "covered_mixed";
    else paymentState = "covered";
  }

  const linkedOrders = [...purchasedIds]
    .map((id) => {
      const fallbackSessions =
        id === bootstrapOrderId ? asInt(bootstrap?.inferredPurchased) : 0;
      return serializeOrderLink(orderById.get(id), {
        noticeId: rawId,
        fallbackSessions,
      });
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ad = new Date(a.paidAt || a.createdAt || 0).getTime();
      const bd = new Date(b.paidAt || b.createdAt || 0).getTime();
      return bd - ad;
    });

  const pendingOrderId = orderId(extra?.pendingOrder);
  const pendingOrder = pendingOrderId
    ? serializeOrderLink(orderById.get(pendingOrderId), { noticeId: rawId })
    : null;

  return {
    id:
      rawId ||
      `bootstrap:${clean(bootstrap?.subscriptionId || extra?.subscription || "")}:${periodKey}`,
    periodKey,
    status: clean(extra?.status) || (remaining > 0 ? "pending" : "covered"),
    paymentState,
    hadDifference: historicalRequired > 0,
    source: clean(extra?.source || bootstrap?.source || "bootstrap"),
    occurrenceSource: clean(extra?.occurrenceSource),

    basePlanSessions: asInt(extra?.basePlanSessions || bootstrap?.basePlanSessions),
    fixedOccurrences: asInt(
      extra?.projectedFixedOccurrences || bootstrap?.fixedOccurrences
    ),
    required: currentRequired,
    purchased,
    remaining,

    historicalBasePlanSessions,
    historicalFixedOccurrences,
    historicalRequired,
    historicalFirstDetectedAt:
      extra?.historicalFirstDetectedAt || bootstrap?.initializedAt || null,
    historicalLastChangedAt: extra?.historicalLastChangedAt || null,
    released,
    paidAgainstDifference,

    pendingOrderId,
    pendingOrder,
    lastPaidOrderId: lastPaidOrderId || bootstrapOrderId || null,
    paidOrders: linkedOrders.filter((order) => order.paid),
    linkedOrders,
    bootstrapPurchasedApplied,
    inferredFromBootstrap: Boolean(bootstrapPurchasedApplied > 0),
    historicalOnly,
  };
}

function buildExtraHistory(subscription, rawExtras = [], orderById = new Map()) {
  const bootstrap = bootstrapExtraForSubscription(subscription);
  const rows = [];
  let bootstrapMerged = false;

  for (const extra of rawExtras) {
    const sameBootstrap =
      bootstrap && clean(extra?.periodKey) === clean(bootstrap.periodKey)
        ? bootstrap
        : null;
    if (sameBootstrap) bootstrapMerged = true;
    const serialized = serializeExtra(extra, orderById, sameBootstrap);
    if (serialized?.hadDifference) rows.push(serialized);
  }

  if (bootstrap && !bootstrapMerged) {
    const serialized = serializeExtra(null, orderById, bootstrap);
    if (serialized?.hadDifference) rows.push(serialized);
  }

  return rows.sort((a, b) => clean(b.periodKey).localeCompare(clean(a.periodKey)));
}

function serializeSubscription(
  subscription,
  { latestCycle = null, extra = null, fixed = null, coverageHistory = [] } = {}
) {
  const pricingPlan =
    subscription.pricingPlan && typeof subscription.pricingPlan === "object"
      ? subscription.pricingPlan
      : null;
  const user =
    subscription.user && typeof subscription.user === "object"
      ? subscription.user
      : null;

  const history = Array.isArray(coverageHistory) ? coverageHistory : [];
  const pendingSessions = history.reduce(
    (sum, row) => sum + asInt(row?.remaining),
    0
  );

  return {
    id: String(subscription._id),
    user: {
      id: user?._id
        ? String(user._id)
        : subscription.user
          ? String(subscription.user)
          : "",
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
    regularPrice: asMoney(
      subscription.regularPrice || subscription.price || pricingPlan?.price
    ),
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
    extra,
    differenceSummary: {
      periods: history.length,
      pendingPeriods: history.filter((row) => row.remaining > 0).length,
      paidPeriods: history.filter((row) => row.paymentState === "paid").length,
      partialPeriods: history.filter((row) => row.paymentState === "partial").length,
      releasedPeriods: history.filter((row) => row.paymentState === "released").length,
      historicalSessions: history.reduce(
        (sum, row) => sum + asInt(row.historicalRequired),
        0
      ),
      purchasedSessions: history.reduce(
        (sum, row) => sum + asInt(row.paidAgainstDifference),
        0
      ),
      pendingSessions,
    },
    createdAt: subscription.createdAt || null,
    updatedAt: subscription.updatedAt || null,
  };
}

async function loadOrdersForExtras({ extras = [], subscriptions = [] } = {}) {
  const ids = new Set();
  const noticeIds = [];

  for (const extra of extras) {
    const eid = orderId(extra?._id);
    if (eid) noticeIds.push(eid);
    for (const value of [
      extra?.pendingOrder,
      extra?.lastPaidOrder,
      ...(Array.isArray(extra?.purchasedOrderIds) ? extra.purchasedOrderIds : []),
    ]) {
      const id = orderId(value);
      if (id) ids.add(id);
    }
  }

  for (const subscription of subscriptions) {
    const id = orderId(subscription?.bootstrap?.latestPaidOrder?.orderId);
    if (id) ids.add(id);
  }

  const or = [];
  if (ids.size) {
    or.push({ _id: { $in: [...ids].map((id) => new mongoose.Types.ObjectId(id)) } });
  }
  if (noticeIds.length) {
    or.push({
      "items.extraSessionNotice": {
        $in: noticeIds.map((id) => new mongoose.Types.ObjectId(id)),
      },
    });
  }
  if (!or.length) return new Map();

  const orders = await Order.find({ $or: or })
    .select(
      "_id status payMethod total totalFinal price paidAt createdAt items subscriptionExtraApplied"
    )
    .sort({ paidAt: -1, createdAt: -1 })
    .lean();

  return new Map(orders.map((order) => [String(order._id), order]));
}

async function loadOverviewData(subscriptions) {
  const subscriptionIds = subscriptions.map((s) => s._id);
  const userServicePairs = subscriptions
    .map((s) => ({
      user: s.user?._id || s.user,
      serviceKey: s.serviceKey,
    }))
    .filter(
      (pair) => pair.user && mongoose.Types.ObjectId.isValid(String(pair.user))
    );

  const [cycles, extras, fixedSchedules] = await Promise.all([
    SubscriptionBillingCycle.find({ subscription: { $in: subscriptionIds } })
      .sort({ periodKey: -1, createdAt: -1 })
      .lean(),
    SubscriptionExtraSessionNotice.find({
      subscription: { $in: subscriptionIds },
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

  const orderById = await loadOrdersForExtras({ extras, subscriptions });

  const cycleBySubscription = new Map();
  for (const cycle of cycles) {
    const key = String(cycle.subscription);
    if (!cycleBySubscription.has(key)) cycleBySubscription.set(key, cycle);
  }

  const extrasBySubscription = new Map();
  for (const extra of extras) {
    const key = String(extra.subscription);
    const list = extrasBySubscription.get(key) || [];
    list.push(extra);
    extrasBySubscription.set(key, list);
  }

  const fixedByPair = new Map();
  for (const schedule of fixedSchedules) {
    const key = `${String(schedule.user)}:${schedule.serviceKey}`;
    const current = fixedByPair.get(key) || { schedules: 0, weeklySlots: 0 };
    current.schedules += 1;
    current.weeklySlots += Array.isArray(schedule.items) ? schedule.items.length : 0;
    fixedByPair.set(key, current);
  }

  return { cycleBySubscription, extrasBySubscription, fixedByPair, orderById };
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
    differencePeriods: 0,
    differencePaidPeriods: 0,
    differencePartialPeriods: 0,
    differenceReleasedPeriods: 0,
    differenceHistoricalSessions: 0,
    differencePurchasedSessions: 0,
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

    const ds = item.differenceSummary || {};
    summary.differencePeriods += asInt(ds.periods);
    summary.differencePaidPeriods += asInt(ds.paidPeriods);
    summary.differencePartialPeriods += asInt(ds.partialPeriods);
    summary.differenceReleasedPeriods += asInt(ds.releasedPeriods);
    summary.differenceHistoricalSessions += asInt(ds.historicalSessions);
    summary.differencePurchasedSessions += asInt(ds.purchasedSessions);
    summary.extrasSessions += asInt(ds.pendingSessions);
    if (asInt(ds.pendingSessions) > 0) summary.extrasPending += 1;
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

    const { cycleBySubscription, extrasBySubscription, fixedByPair, orderById } =
      await loadOverviewData(subscriptions);

    let items = subscriptions.map((subscription) => {
      const userId = subscription.user?._id || subscription.user;
      const coverageHistory = buildExtraHistory(
        subscription,
        extrasBySubscription.get(String(subscription._id)) || [],
        orderById
      );
      const extra =
        coverageHistory.find((row) => row.remaining > 0) ||
        coverageHistory[0] ||
        null;

      return serializeSubscription(subscription, {
        latestCycle: cycleBySubscription.get(String(subscription._id)) || null,
        extra,
        coverageHistory,
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
        .limit(24)
        .lean(),
      SubscriptionExtraSessionNotice.find({ subscription: id })
        .sort({ periodKey: -1 })
        .limit(24)
        .lean(),
      FixedSchedule.find({
        user: subscription.user?._id || subscription.user,
        serviceKey: subscription.serviceKey,
        active: true,
      })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    const orderById = await loadOrdersForExtras({
      extras,
      subscriptions: [subscription],
    });
    const coverageHistory = buildExtraHistory(subscription, extras, orderById);
    const latestCycle = cycles[0] || null;
    const extra =
      coverageHistory.find((item) => item.remaining > 0) ||
      coverageHistory[0] ||
      null;

    return res.json({
      item: serializeSubscription(subscription, {
        latestCycle,
        extra,
        coverageHistory,
        fixed: {
          schedules: fixedSchedules.length,
          weeklySlots: fixedSchedules.reduce(
            (sum, schedule) =>
              sum + (Array.isArray(schedule.items) ? schedule.items.length : 0),
            0
          ),
        },
      }),
      cycles: cycles.map(serializeCycle),
      extras: coverageHistory,
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
