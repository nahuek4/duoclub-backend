import mongoose from "mongoose";

import PricingPlan from "../../models/PricingPlan.js";
import ServiceSubscription from "../../models/ServiceSubscription.js";
import Appointment from "../../models/Appointment.js";
import User from "../../models/User.js";
import {
  currentMonthKeyArgentina,
  syncExtraSessionNoticeForUserService,
} from "./subscriptionExtraSessions.js";

const RECURRING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN", "NUT"]);
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "pending_change"]);
const PAID_STATUSES = new Set(["paid", "approved"]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeServiceKey(value) {
  const raw = clean(value).toUpperCase();
  if (raw === "AR") return "RA";
  if (raw === "KINEDEPO" || raw === "KINE-DEPO") return "KD";
  return RECURRING_SERVICE_KEYS.has(raw) ? raw : "";
}

function toPositiveInt(value) {
  const n = Math.trunc(Number(value || 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function periodBoundsArgentina(monthKey) {
  const [yearRaw, monthRaw] = clean(monthKey).split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error(`Período inválido: ${monthKey}`);
  }

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    periodKey: `${year}-${pad2(month)}`,
    startYmd: `${year}-${pad2(month)}-01`,
    endYmd: `${year}-${pad2(month)}-${pad2(lastDay)}`,
    startDate: new Date(`${year}-${pad2(month)}-01T00:00:00-03:00`),
    endDate: new Date(`${year}-${pad2(month)}-${pad2(lastDay)}T23:59:59.999-03:00`),
  };
}

function withSession(query, session) {
  if (session) query.session(session);
  return query;
}

function orderCreditItems(order = {}) {
  const items = Array.isArray(order?.items) ? order.items : [];

  if (items.length) {
    return items
      .filter((item) => String(item?.kind || "").toUpperCase() === "CREDITS")
      .map((item) => ({
        serviceKey: normalizeServiceKey(item?.serviceKey),
        credits: toPositiveInt(item?.credits),
        qty: Math.max(1, toPositiveInt(item?.qty) || 1),
        pricingPlanId: clean(item?.pricingPlanId || item?.planId),
        price: money(item?.price),
        basePrice: money(item?.basePrice),
        coveragePrice:
          item?.coveragePrice === null || item?.coveragePrice === undefined
            ? null
            : money(item?.coveragePrice),
        coverageApplied: Boolean(item?.coverageApplied),
        discountReason: clean(item?.discountReason),
      }))
      .filter((item) => item.serviceKey && item.credits > 0 && item.qty === 1);
  }

  const serviceKey = normalizeServiceKey(order?.serviceKey);
  const credits = toPositiveInt(order?.credits);
  if (!serviceKey || !credits || order?.createdByAdmin || order?.publicPaymentLink) return [];

  return [
    {
      serviceKey,
      credits,
      qty: 1,
      pricingPlanId: "",
      price: money(order?.price || order?.totalFinal || order?.total),
      basePrice: money(order?.basePrice || order?.price || order?.totalFinal || order?.total),
      coveragePrice: null,
      coverageApplied: false,
      discountReason: "",
    },
  ];
}

async function resolvePublishedPlan({ item, payMethod, session = null }) {
  const serviceKey = normalizeServiceKey(item?.serviceKey);
  const credits = toPositiveInt(item?.credits);
  const pm = clean(payMethod).toUpperCase();

  if (!serviceKey || !credits || !["CASH", "MP"].includes(pm)) return null;

  if (mongoose.Types.ObjectId.isValid(item?.pricingPlanId)) {
    const plan = await withSession(
      PricingPlan.findOne({
        _id: item.pricingPlanId,
        active: true,
        isCustom: { $ne: true },
        serviceKey,
        credits,
        payMethod: pm,
      }),
      session
    );
    if (plan) return plan;
  }

  const plans = await withSession(
    PricingPlan.find({
      active: true,
      isCustom: { $ne: true },
      serviceKey,
      credits,
      payMethod: pm,
    }).sort({ updatedAt: -1, createdAt: -1 }),
    session
  );

  return plans.length === 1 ? plans[0] : null;
}

export async function activateSubscriptionsFromPaidOrder({ order, session = null, now = new Date() } = {}) {
  if (!order?._id || !order?.user) return { ok: true, activated: [], skipped: "ORDER_WITHOUT_USER" };

  const status = clean(order?.status).toLowerCase();
  if (!PAID_STATUSES.has(status)) {
    return { ok: true, activated: [], skipped: "ORDER_NOT_PAID" };
  }

  const payMethod = clean(order?.payMethod).toUpperCase();
  const items = orderCreditItems(order);
  const activated = [];

  for (const item of items) {
    const plan = await resolvePublishedPlan({ item, payMethod, session });
    if (!plan) continue;

    let subscription = await withSession(
      ServiceSubscription.findOne({ user: order.user, serviceKey: item.serviceKey }),
      session
    );

    const currentKey = currentMonthKeyArgentina(now);
    const existingKey = clean(subscription?.currentPeriodKey);
    const periodKey = existingKey && existingKey > currentKey ? existingKey : currentKey;
    const bounds = periodBoundsArgentina(periodKey);

    if (!subscription) {
      subscription = new ServiceSubscription({
        user: order.user,
        serviceKey: item.serviceKey,
        serviceName: item.serviceKey,
        monthlySessions: plan.credits,
        price: item.price || plan.price,
        regularPrice: plan.price,
        payMethod,
      });
    }

    subscription.pricingPlan = plan._id;
    subscription.status = "active";
    subscription.autoRenew = true;
    subscription.monthlySessions = plan.credits;
    subscription.price = item.price || plan.price;
    subscription.regularPrice = plan.price;
    subscription.coveragePrice = item.coverageApplied ? item.coveragePrice : null;
    subscription.coverageApplied = Boolean(item.coverageApplied);
    subscription.coverageReason = item.coverageApplied ? item.discountReason || "Cobertura" : "";
    subscription.payMethod = payMethod;
    subscription.currentPeriodKey = bounds.periodKey;
    subscription.currentPeriodStart = bounds.startDate;
    subscription.currentPeriodEnd = bounds.endDate;
    subscription.lastRenewedAt = now;
    subscription.pendingChange = null;
    subscription.suspendedAt = null;
    subscription.suspensionReason = "";
    subscription.cancelledAt = null;
    subscription.cancelReason = "";
    subscription.terminatedAt = null;
    subscription.terminationReason = "";

    await subscription.save({ session: session || undefined });

    activated.push({
      serviceKey: item.serviceKey,
      pricingPlanId: String(plan._id),
      subscriptionId: String(subscription._id),
      monthlySessions: Number(plan.credits || 0),
      periodKey: bounds.periodKey,
      payMethod,
    });
  }

  return { ok: true, activated };
}

function activeCreditLots(user, serviceKey, now = new Date()) {
  const lots = Array.isArray(user?.creditLots) ? user.creditLots : [];
  return lots
    .filter((lot) => {
      const lotServiceKey = normalizeServiceKey(lot?.serviceKey || lot?.service || lot?.serviceName);
      const remaining = Number(lot?.remaining || 0);
      const expiresAt = lot?.expiresAt ? new Date(lot.expiresAt) : null;
      return lotServiceKey === serviceKey && remaining > 0 && (!expiresAt || expiresAt > now);
    })
    .sort((a, b) => {
      const aExp = a?.expiresAt ? new Date(a.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
      const bExp = b?.expiresAt ? new Date(b.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (aExp !== bExp) return aExp - bExp;
      return new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime();
    });
}

function recalcCredits(user, now = new Date()) {
  const lots = Array.isArray(user?.creditLots) ? user.creditLots : [];
  user.credits = lots.reduce((total, lot) => {
    const expiresAt = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (expiresAt && expiresAt <= now) return total;
    return total + Math.max(0, Number(lot?.remaining || 0));
  }, 0);
}

export async function reconcilePendingFixedAppointmentsForUserService({
  userId,
  serviceKey,
  now = new Date(),
} = {}) {
  const sk = normalizeServiceKey(serviceKey);
  if (!mongoose.Types.ObjectId.isValid(clean(userId)) || !sk) {
    return { ok: false, error: "INVALID_USER_OR_SERVICE" };
  }

  const subscription = await ServiceSubscription.findOne({
    user: userId,
    serviceKey: sk,
    status: { $in: [...ACTIVE_SUBSCRIPTION_STATUSES] },
  }).sort({ updatedAt: -1 });

  if (!subscription) return { ok: true, skipped: true, reason: "SUBSCRIPTION_NOT_FOUND" };

  const periodKey = clean(subscription.currentPeriodKey) || currentMonthKeyArgentina(now);
  const bounds = periodBoundsArgentina(periodKey);
  const user = await User.findById(userId);
  if (!user) return { ok: false, error: "USER_NOT_FOUND" };

  const appointments = await Appointment.find({
    user: userId,
    fixedScheduleId: { $ne: null },
    serviceKey: sk,
    status: "reserved",
    date: { $gte: bounds.startYmd, $lte: bounds.endYmd },
    $or: [
      { creditDebitStatus: { $in: ["", "pending"] } },
      { creditDebitStatus: { $exists: false } },
    ],
  }).sort({ date: 1, time: 1 });

  let covered = 0;
  for (const appointment of appointments) {
    const lot = activeCreditLots(user, sk, now)[0] || null;
    if (!lot) break;

    lot.remaining = Math.max(0, Number(lot.remaining || 0) - 1);
    appointment.creditLotId = lot._id || null;
    appointment.creditExpiresAt = lot.expiresAt || null;
    appointment.creditDebitStatus = "monthly_reserved";
    appointment.creditDebitedAt = now;
    appointment.fixedDebitProcessedAt = now;
    appointment.fixedDebtAmount = 0;
    await appointment.save();
    covered += 1;
  }

  recalcCredits(user, now);
  await user.save();

  return {
    ok: true,
    serviceKey: sk,
    periodKey,
    pendingAppointmentsRead: appointments.length,
    covered,
    remainingCredits: Number(user.credits || 0),
  };
}

export async function finalizePaidPlanOrder({ order, activated = null, now = new Date() } = {}) {
  if (!order?._id || !order?.user) return { ok: true, results: [] };

  let activatedRows = Array.isArray(activated) ? activated : null;
  if (!activatedRows) {
    const activation = await activateSubscriptionsFromPaidOrder({ order, now });
    activatedRows = activation.activated || [];
  }

  const results = [];
  for (const row of activatedRows) {
    const reconciliation = await reconcilePendingFixedAppointmentsForUserService({
      userId: order.user,
      serviceKey: row.serviceKey,
      now,
    });

    let notice = null;
    try {
      notice = await syncExtraSessionNoticeForUserService({
        userId: order.user,
        serviceKey: row.serviceKey,
        source: "plan_purchase_paid",
        now,
      });
    } catch (error) {
      notice = { ok: false, error: error?.message || String(error) };
    }

    results.push({ ...row, reconciliation, notice });
  }

  return { ok: true, results };
}

export function paidOrderPublishedPlanServiceKeys(order = {}) {
  return new Set(orderCreditItems(order).map((item) => item.serviceKey).filter(Boolean));
}
