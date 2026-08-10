// backend/src/services/subscriptions/subscriptionExtraSessions.js
// Calcula y administra el faltante de sesiones de turnos fijos por período.
// No envía mails y no modifica el plan base de la suscripción.

import mongoose from "mongoose";

import Appointment from "../../models/Appointment.js";
import FixedSchedule from "../../models/FixedSchedule.js";
import Order from "../../models/Order.js";
import PricingPlan from "../../models/PricingPlan.js";
import ScheduleBlock from "../../models/ScheduleBlock.js";
import ServiceSubscription from "../../models/ServiceSubscription.js";
import SubscriptionExtraSessionNotice from "../../models/SubscriptionExtraSessionNotice.js";

import {
  calculateServiceMonthCoverage,
  isValidMonthKey,
  monthRangeFromKey,
  normalizeServiceKey,
} from "./fixedScheduleCoverage.js";
import { projectActiveFixedSchedulesForMonth } from "./subscriptionScheduleProjection.js";

const ACTIVE_SUBSCRIPTION_STATUSES = ["active", "pending_change", "suspended"];
const PAID_ORDER_STATUSES = new Set(["paid", "approved"]);
const CLOSED_ORDER_STATUSES = new Set(["cancelled", "canceled", "expired"]);

function clean(value) {
  return String(value || "").trim();
}

function idOf(value) {
  return clean(value?._id || value?.id || value);
}

function nonNegativeInt(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function createHttpError(message, status = 400, code = "INVALID_EXTRA_SESSION_REQUEST") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function currentMonthKeyArgentina(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : "";
}


export function shouldUseActualCurrentMonthAppointments(periodKey, now = new Date()) {
  return clean(periodKey) === currentMonthKeyArgentina(now);
}

export function resolveExtraSessionPeriodKey(subscription = {}, now = new Date()) {
  const current = currentMonthKeyArgentina(now);
  const subscriptionPeriod = clean(subscription?.currentPeriodKey);

  if (isValidMonthKey(subscriptionPeriod) && subscriptionPeriod >= current) {
    return subscriptionPeriod;
  }
  return current;
}

function scheduleBlockQuery(startYmd, endYmd) {
  return {
    active: true,
    dateFrom: { $lte: endYmd },
    $or: [
      { indefinite: true },
      { dateTo: { $gte: startYmd } },
      { dateTo: "" },
      { dateTo: { $exists: false } },
    ],
  };
}

function activePlanQuery({ serviceKey, sessions, payMethod }) {
  return {
    active: true,
    isCustom: { $ne: true },
    serviceKey,
    credits: sessions,
    payMethod,
  };
}

export function calculateProportionalExtraPrice({ planPrice, planSessions, extraSessions }) {
  const price = Math.max(0, Number(planPrice || 0));
  const sessions = Math.max(1, nonNegativeInt(planSessions));
  const extras = nonNegativeInt(extraSessions);
  const exactUnitPrice = price / sessions;

  return {
    unitPrice: Math.round(exactUnitPrice),
    totalPrice: Math.round(exactUnitPrice * extras),
  };
}

async function buildPricingOption({ serviceKey, basePlanSessions, payMethod, remaining }) {
  const plan = await PricingPlan.findOne(
    activePlanQuery({
      serviceKey,
      sessions: basePlanSessions,
      payMethod,
    })
  )
    .sort({ updatedAt: -1 })
    .lean();

  if (!plan) return null;

  const calculated = calculateProportionalExtraPrice({
    planPrice: plan.price,
    planSessions: plan.credits,
    extraSessions: remaining,
  });

  return {
    payMethod,
    pricingPlanId: String(plan._id),
    basePlanPrice: Number(plan.price || 0),
    basePlanSessions: Number(plan.credits || basePlanSessions),
    unitPrice: calculated.unitPrice,
    totalPrice: calculated.totalPrice,
  };
}

async function refreshNoticePendingOrder(notice, { session = null } = {}) {
  if (!notice?.pendingOrder) return notice;

  const orderQuery = Order.findById(notice.pendingOrder).select("status");
  if (session) orderQuery.session(session);
  const order = await orderQuery.lean();

  const status = clean(order?.status).toLowerCase();
  if (!order || CLOSED_ORDER_STATUSES.has(status)) {
    notice.pendingOrder = null;
    notice.status = notice.remainingSessions > 0 ? "pending" : "covered";
    await notice.save({ session: session || undefined });
  }

  return notice;
}

async function calculateExtraSessionStateForUserService({
  userId,
  serviceKey,
  now = new Date(),
} = {}) {
  const normalizedServiceKey = normalizeServiceKey(serviceKey);
  if (!mongoose.Types.ObjectId.isValid(clean(userId)) || !normalizedServiceKey) {
    throw createHttpError(
      "Usuario o servicio inválido para calcular sesiones adicionales.",
      400,
      "INVALID_USER_OR_SERVICE"
    );
  }

  const subscription = await ServiceSubscription.findOne({
    user: userId,
    serviceKey: normalizedServiceKey,
    status: { $in: ACTIVE_SUBSCRIPTION_STATUSES },
  }).sort({ createdAt: -1 });

  if (!subscription) {
    return {
      ok: true,
      skipped: true,
      reason: "SUBSCRIPTION_NOT_FOUND",
      userId: String(userId),
      serviceKey: normalizedServiceKey,
    };
  }

  const periodKey = resolveExtraSessionPeriodKey(subscription, now);
  const range = monthRangeFromKey(periodKey);

  const existing = await SubscriptionExtraSessionNotice.findOne({
    user: userId,
    serviceKey: normalizedServiceKey,
    periodKey,
  });

  const basePlanSessions = Math.max(1, nonNegativeInt(subscription.monthlySessions));
  const purchased = nonNegativeInt(existing?.extraSessionsPurchased);
  const currentPeriodKey = currentMonthKeyArgentina(now);

  // Para el mes actual, la fuente de verdad son los turnos fijos que realmente
  // existen en Appointment. Esto evita cobrar ocurrencias teóricas del patrón
  // que no fueron creadas (por ejemplo, horarios/días anteriores al momento en
  // que el admin asignó el turno fijo durante el mes).
  if (shouldUseActualCurrentMonthAppointments(periodKey, now)) {
    const appointments = await Appointment.find({
      user: userId,
      serviceKey: normalizedServiceKey,
      fixedScheduleId: { $ne: null },
      status: "reserved",
      date: { $gte: range.startYmd, $lte: range.endYmd },
    })
      .select("_id fixedScheduleId date time status")
      .sort({ date: 1, time: 1 })
      .lean();

    const fixedScheduleIds = Array.from(
      new Set(
        appointments
          .map((appointment) => idOf(appointment?.fixedScheduleId))
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      )
    );

    const actualFixedOccurrences = appointments.length;
    const extraSessionsRequired = Math.max(
      0,
      actualFixedOccurrences - basePlanSessions
    );

    return {
      ok: true,
      skipped: false,
      userId: String(userId),
      serviceKey: normalizedServiceKey,
      subscription,
      existing,
      periodKey,
      fixedScheduleIds,
      basePlanSessions,
      projectedFixedOccurrences: actualFixedOccurrences,
      blockedOccurrencesCount: 0,
      extraSessionsRequired,
      extraSessionsPurchased: purchased,
      remainingSessions: Math.max(0, extraSessionsRequired - purchased),
      occurrenceSource: "actual_current_month_appointments",
    };
  }

  // Para períodos futuros todavía no existen Appointment materializados. Ahí
  // sí proyectamos el patrón semanal activo para conocer la cobertura necesaria.
  const [rawSchedules, blocks] = await Promise.all([
    FixedSchedule.find({
      user: userId,
      serviceKey: normalizedServiceKey,
      active: true,
      startDate: { $lte: range.endYmd },
    })
      .sort({ createdAt: 1 })
      .lean(),
    ScheduleBlock.find(scheduleBlockQuery(range.startYmd, range.endYmd)).lean(),
  ]);

  const projection = projectActiveFixedSchedulesForMonth({
    schedules: rawSchedules,
    monthKey: periodKey,
    serviceKey: normalizedServiceKey,
  });

  const coverage = calculateServiceMonthCoverage({
    schedules: projection.projectedSchedules,
    blocks,
    monthKey: periodKey,
    serviceKey: normalizedServiceKey,
    monthlySessions: basePlanSessions,
    extraSessionsSelected: purchased,
  });

  const fixedScheduleIds = projection.projectedSchedules
    .map((schedule) => idOf(schedule))
    .filter((id) => mongoose.Types.ObjectId.isValid(id));

  return {
    ok: true,
    skipped: false,
    userId: String(userId),
    serviceKey: normalizedServiceKey,
    subscription,
    existing,
    periodKey,
    fixedScheduleIds,
    basePlanSessions,
    projectedFixedOccurrences: coverage.fixedOccurrencesCount,
    blockedOccurrencesCount: coverage.blockedOccurrencesCount,
    extraSessionsRequired: coverage.extraSessionsNeeded,
    extraSessionsPurchased: purchased,
    remainingSessions: Math.max(0, coverage.extraSessionsNeeded - purchased),
    occurrenceSource: "projected_future_pattern",
  };
}

export async function previewExtraSessionNoticeForUserService(args = {}) {
  const state = await calculateExtraSessionStateForUserService(args);
  if (state.skipped) return state;

  return {
    ok: true,
    skipped: false,
    userId: state.userId,
    subscriptionId: String(state.subscription._id),
    serviceKey: state.serviceKey,
    periodKey: state.periodKey,
    fixedScheduleIds: state.fixedScheduleIds,
    basePlanSessions: state.basePlanSessions,
    projectedFixedOccurrences: state.projectedFixedOccurrences,
    blockedOccurrencesCount: state.blockedOccurrencesCount,
    extraSessionsRequired: state.extraSessionsRequired,
    extraSessionsPurchased: state.extraSessionsPurchased,
    remainingSessions: state.remainingSessions,
    occurrenceSource: state.occurrenceSource || "",
  };
}

export async function syncExtraSessionNoticeForUserService({
  userId,
  serviceKey,
  actorId = null,
  source = "manual_refresh",
  now = new Date(),
} = {}) {
  const state = await calculateExtraSessionStateForUserService({
    userId,
    serviceKey,
    now,
  });
  if (state.skipped) return state;

  const {
    subscription,
    existing,
    periodKey,
    fixedScheduleIds,
    basePlanSessions,
    projectedFixedOccurrences,
    blockedOccurrencesCount,
    extraSessionsRequired,
    extraSessionsPurchased,
    remainingSessions,
  } = state;

  subscription.fixedScheduleIds = fixedScheduleIds;
  subscription.updatedBy = actorId || subscription.updatedBy || null;
  await subscription.save();

  if (extraSessionsRequired <= 0 && !existing) {
    return {
      ok: true,
      skipped: true,
      reason: "NO_EXTRA_SESSIONS_REQUIRED",
      subscriptionId: String(subscription._id),
      userId: String(userId),
      serviceKey: state.serviceKey,
      periodKey,
      basePlanSessions,
      projectedFixedOccurrences,
      blockedOccurrencesCount,
      extraSessionsRequired: 0,
      extraSessionsPurchased,
      remainingSessions: 0,
    };
  }

  const notice = existing || new SubscriptionExtraSessionNotice({
    user: userId,
    subscription: subscription._id,
    serviceKey: state.serviceKey,
    periodKey,
  });

  notice.subscription = subscription._id;
  notice.fixedScheduleIds = fixedScheduleIds;
  notice.basePlanSessions = basePlanSessions;
  notice.projectedFixedOccurrences = projectedFixedOccurrences;
  notice.blockedOccurrencesCount = blockedOccurrencesCount;
  notice.extraSessionsRequired = extraSessionsRequired;
  notice.extraSessionsPurchased = extraSessionsPurchased;
  notice.calculatedAt = new Date();
  notice.calculatedBy = actorId || null;
  notice.source = source;

  await refreshNoticePendingOrder(notice);
  await notice.save();

  return {
    ok: true,
    skipped: false,
    subscriptionId: String(subscription._id),
    noticeId: String(notice._id),
    serviceKey: state.serviceKey,
    periodKey,
    basePlanSessions,
    projectedFixedOccurrences,
    blockedOccurrencesCount,
    extraSessionsRequired,
    extraSessionsPurchased,
    remainingSessions,
    status: notice.status,
    occurrenceSource: state.occurrenceSource || "",
  };
}

export async function serializeExtraSessionNoticeForUser(noticeInput) {
  const notice =
    typeof noticeInput?.save === "function"
      ? noticeInput
      : await SubscriptionExtraSessionNotice.findById(noticeInput?._id || noticeInput);

  if (!notice) return null;
  await refreshNoticePendingOrder(notice);

  const remaining = Math.max(
    0,
    nonNegativeInt(notice.extraSessionsRequired) -
      nonNegativeInt(notice.extraSessionsPurchased)
  );

  const [cash, mp] = await Promise.all([
    buildPricingOption({
      serviceKey: notice.serviceKey,
      basePlanSessions: notice.basePlanSessions,
      payMethod: "CASH",
      remaining,
    }),
    buildPricingOption({
      serviceKey: notice.serviceKey,
      basePlanSessions: notice.basePlanSessions,
      payMethod: "MP",
      remaining,
    }),
  ]);

  let pendingOrder = null;
  if (notice.pendingOrder) {
    pendingOrder = await Order.findById(notice.pendingOrder)
      .select("status payMethod totalFinal total createdAt")
      .lean();
  }

  return {
    id: String(notice._id),
    subscriptionId: String(notice.subscription),
    serviceKey: notice.serviceKey,
    periodKey: notice.periodKey,
    basePlanSessions: nonNegativeInt(notice.basePlanSessions),
    projectedFixedOccurrences: nonNegativeInt(notice.projectedFixedOccurrences),
    blockedOccurrencesCount: nonNegativeInt(notice.blockedOccurrencesCount),
    extraSessionsRequired: nonNegativeInt(notice.extraSessionsRequired),
    extraSessionsPurchased: nonNegativeInt(notice.extraSessionsPurchased),
    remainingSessions: remaining,
    status: notice.status,
    pendingOrder: pendingOrder
      ? {
          id: String(pendingOrder._id),
          status: pendingOrder.status,
          payMethod: pendingOrder.payMethod,
          total: Number(pendingOrder.totalFinal ?? pendingOrder.total ?? 0),
          createdAt: pendingOrder.createdAt || null,
        }
      : null,
    pricing: { CASH: cash, MP: mp },
  };
}

export async function listExtraSessionNoticesForUser(userId) {
  const notices = await SubscriptionExtraSessionNotice.find({
    user: userId,
    status: { $in: ["pending", "order_pending"] },
  }).sort({ periodKey: 1, serviceKey: 1 });

  const serialized = await Promise.all(
    notices.map((notice) => serializeExtraSessionNoticeForUser(notice))
  );

  return serialized.filter(
    (notice) => notice && (notice.remainingSessions > 0 || notice.pendingOrder)
  );
}

export async function resolveExtraSessionCheckoutItem({
  noticeId,
  userId,
  payMethod,
} = {}) {
  if (!mongoose.Types.ObjectId.isValid(clean(noticeId))) {
    throw createHttpError("Aviso de sesiones adicionales inválido.", 400, "INVALID_NOTICE_ID");
  }

  const normalizedPayMethod = clean(payMethod).toUpperCase();
  if (!["CASH", "MP"].includes(normalizedPayMethod)) {
    throw createHttpError("Medio de pago inválido.", 400, "INVALID_PAY_METHOD");
  }

  const notice = await SubscriptionExtraSessionNotice.findOne({
    _id: noticeId,
    user: userId,
  });

  if (!notice) {
    throw createHttpError("El aviso de sesiones adicionales no existe.", 404, "NOTICE_NOT_FOUND");
  }

  await refreshNoticePendingOrder(notice);

  if (notice.pendingOrder) {
    throw createHttpError(
      "Ya existe un pago pendiente para estas sesiones adicionales.",
      409,
      "EXTRA_ORDER_ALREADY_PENDING"
    );
  }

  const remaining = Math.max(
    0,
    nonNegativeInt(notice.extraSessionsRequired) -
      nonNegativeInt(notice.extraSessionsPurchased)
  );
  if (remaining <= 0) {
    throw createHttpError(
      "Estas sesiones adicionales ya están cubiertas.",
      409,
      "EXTRA_ALREADY_COVERED"
    );
  }

  const pricing = await buildPricingOption({
    serviceKey: notice.serviceKey,
    basePlanSessions: notice.basePlanSessions,
    payMethod: normalizedPayMethod,
    remaining,
  });

  if (!pricing) {
    throw createHttpError(
      "No existe un plan publicado equivalente para calcular el valor adicional.",
      409,
      "EXTRA_PRICE_NOT_AVAILABLE"
    );
  }

  return {
    notice,
    item: {
      kind: "SUBSCRIPTION_EXTRA",
      serviceKey: notice.serviceKey,
      credits: remaining,
      label: `${remaining} ${remaining === 1 ? "sesión adicional" : "sesiones adicionales"} · ${notice.periodKey}`,
      pricingPlanId: pricing.pricingPlanId,
      subscription: notice.subscription,
      extraSessionNotice: notice._id,
      periodKey: notice.periodKey,
      qty: 1,
      basePrice: pricing.totalPrice,
      price: pricing.totalPrice,
      regularPrice: pricing.totalPrice,
      coveragePrice: null,
      discountAmount: 0,
      discountReason: "",
      discountType: "",
      coverageApplied: false,
    },
  };
}

export async function markExtraSessionOrderPending({ noticeId, orderId, userId }) {
  const result = await SubscriptionExtraSessionNotice.updateOne(
    {
      _id: noticeId,
      user: userId,
      pendingOrder: null,
      status: "pending",
    },
    {
      $set: {
        pendingOrder: orderId,
        status: "order_pending",
        updatedAt: new Date(),
      },
    }
  );

  if (result.modifiedCount !== 1) {
    throw createHttpError(
      "No se pudo reservar el pago de las sesiones adicionales.",
      409,
      "EXTRA_NOTICE_CHANGED"
    );
  }
}

export async function releaseExtraSessionOrder({ noticeId, orderId }) {
  if (!noticeId || !orderId) return;
  await SubscriptionExtraSessionNotice.updateOne(
    { _id: noticeId, pendingOrder: orderId },
    {
      $set: {
        pendingOrder: null,
        status: "pending",
        updatedAt: new Date(),
      },
    }
  );
}

export async function applyExtraSessionsFromOrder({ order, session = null } = {}) {
  if (!order) return { processed: 0, purchasedSessions: 0 };

  const items = (Array.isArray(order.items) ? order.items : []).filter(
    (item) => clean(item?.kind).toUpperCase() === "SUBSCRIPTION_EXTRA"
  );

  let processed = 0;
  let purchasedSessions = 0;

  for (const item of items) {
    const noticeId = idOf(item.extraSessionNotice);
    if (!mongoose.Types.ObjectId.isValid(noticeId)) continue;

    const sessions = nonNegativeInt(item.credits) * Math.max(1, nonNegativeInt(item.qty));
    if (sessions <= 0) continue;

    const options = session ? { session } : {};
    const result = await SubscriptionExtraSessionNotice.updateOne(
      {
        _id: noticeId,
        user: order.user,
        purchasedOrderIds: { $ne: order._id },
      },
      {
        $inc: { extraSessionsPurchased: sessions },
        $addToSet: { purchasedOrderIds: order._id },
        $set: {
          lastPaidOrder: order._id,
          pendingOrder: null,
          calculatedAt: new Date(),
          updatedAt: new Date(),
        },
      },
      options
    );

    if (result.modifiedCount !== 1) continue;

    const noticeQuery = SubscriptionExtraSessionNotice.findById(noticeId);
    if (session) noticeQuery.session(session);
    const notice = await noticeQuery;
    if (notice) {
      notice.status = notice.remainingSessions > 0 ? "pending" : "covered";
      await notice.save({ session: session || undefined });
    }

    processed += 1;
    purchasedSessions += sessions;
  }

  return { processed, purchasedSessions };
}

export function orderContainsOnlySubscriptionExtras(order = {}) {
  const items = Array.isArray(order?.items) ? order.items : [];
  return (
    items.length > 0 &&
    items.every(
      (item) => clean(item?.kind).toUpperCase() === "SUBSCRIPTION_EXTRA"
    )
  );
}

export function isPaidOrderStatus(value) {
  return PAID_ORDER_STATUSES.has(clean(value).toLowerCase());
}
