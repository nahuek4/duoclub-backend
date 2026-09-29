// scripts/reconcileCurrentPlanCoverage.js
// DRY-RUN por defecto. Usar --apply únicamente después de revisar la salida.
// Normaliza el pendiente ACTUAL del mes usando Appointment reserved+completed,
// preserva el máximo HISTÓRICO ya detectado y no toca compras/órdenes/créditos.

import "dotenv/config";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Appointment from "../src/models/Appointment.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import SubscriptionExtraSessionNotice from "../src/models/SubscriptionExtraSessionNotice.js";

function clean(value) {
  return String(value ?? "").trim();
}
function asInt(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}
function oid(value) {
  const id = clean(value?._id || value?.id || value);
  return mongoose.Types.ObjectId.isValid(id) ? id : "";
}
function pairKey(userId, serviceKey) {
  return `${clean(userId)}:${clean(serviceKey).toUpperCase()}`;
}
function periodPairKey(userId, serviceKey, periodKey) {
  return `${pairKey(userId, serviceKey)}:${clean(periodKey)}`;
}
function currentMonthKeyArgentina(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  return year && month ? `${year}-${month}` : "";
}
function monthRange(periodKey) {
  const [year, month] = clean(periodKey).split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${year}-${String(month).padStart(2, "0")}-01`,
    end: `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`,
  };
}
function statusPriority(status) {
  const s = clean(status).toLowerCase();
  if (s === "active") return 5;
  if (s === "pending_change") return 4;
  if (s === "suspended") return 3;
  if (s === "cancelled") return 2;
  if (s === "terminated_for_non_payment") return 1;
  return 0;
}
function userName(user, fallback = "") {
  return (
    clean(user?.fullName) ||
    [clean(user?.name), clean(user?.lastName)].filter(Boolean).join(" ") ||
    clean(user?.email) ||
    fallback
  );
}

const apply = process.argv.includes("--apply");
const uri =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL ||
  process.env.MONGODB_URL ||
  process.env.DATABASE_URL ||
  process.env.MONGO;
if (!uri) throw new Error("No encontré URI de Mongo en .env");

const periodKey = currentMonthKeyArgentina();
const range = monthRange(periodKey);
await mongoose.connect(uri);

try {
  const [subscriptions, cycles, notices, counts] = await Promise.all([
    ServiceSubscription.find({})
      .select("user serviceKey monthlySessions status currentPeriodKey createdAt updatedAt")
      .populate("user", "name lastName fullName email")
      .sort({ updatedAt: -1, createdAt: -1 }),
    SubscriptionBillingCycle.find({ periodKey })
      .select("subscription planSnapshot")
      .lean(),
    SubscriptionExtraSessionNotice.find({ periodKey }),
    Appointment.aggregate([
      {
        $match: {
          fixedScheduleId: { $ne: null },
          status: { $in: ["reserved", "completed"] },
          date: { $gte: range.start, $lte: range.end },
        },
      },
      {
        $group: {
          _id: { user: "$user", serviceKey: "$serviceKey" },
          count: { $sum: 1 },
          fixedScheduleIds: { $addToSet: "$fixedScheduleId" },
        },
      },
    ]),
  ]);

  const cycleBySubscription = new Map(
    cycles.map((cycle) => [String(cycle.subscription), cycle])
  );
  const subscriptionsByPair = new Map();
  for (const subscription of subscriptions) {
    const userId = oid(subscription?.user?._id || subscription?.user);
    const serviceKey = clean(subscription?.serviceKey).toUpperCase();
    if (!userId || !serviceKey) continue;
    const key = pairKey(userId, serviceKey);
    const list = subscriptionsByPair.get(key) || [];
    list.push(subscription);
    subscriptionsByPair.set(key, list);
  }
  for (const [key, list] of subscriptionsByPair) {
    list.sort((a, b) => {
      const currentA = clean(a?.currentPeriodKey) === periodKey ? 1 : 0;
      const currentB = clean(b?.currentPeriodKey) === periodKey ? 1 : 0;
      if (currentA !== currentB) return currentB - currentA;
      const pri = statusPriority(b?.status) - statusPriority(a?.status);
      if (pri) return pri;
      return new Date(b?.updatedAt || b?.createdAt || 0) - new Date(a?.updatedAt || a?.createdAt || 0);
    });
  }

  const countByPair = new Map();
  for (const row of counts) {
    countByPair.set(pairKey(row?._id?.user, row?._id?.serviceKey), {
      count: asInt(row?.count),
      fixedScheduleIds: Array.isArray(row?.fixedScheduleIds)
        ? row.fixedScheduleIds.filter(Boolean)
        : [],
    });
  }

  const noticeByPair = new Map();
  for (const notice of notices) {
    noticeByPair.set(pairKey(notice.user, notice.serviceKey), notice);
  }

  const allPairs = new Set([
    ...subscriptionsByPair.keys(),
    ...countByPair.keys(),
    ...noticeByPair.keys(),
  ]);

  const preview = [];
  const writes = [];

  for (const key of allPairs) {
    const pairSubscriptions = subscriptionsByPair.get(key) || [];
    const subscription = pairSubscriptions[0] || null;
    const notice = noticeByPair.get(key) || null;
    const countState = countByPair.get(key) || { count: 0, fixedScheduleIds: [] };

    const [userId, serviceKey] = key.split(":");
    if (!subscription) {
      if (notice) {
        preview.push({
          action: "REVIEW_NO_SUBSCRIPTION",
          user: userId,
          email: "",
          service: serviceKey,
          plan: asInt(notice.basePlanSessions),
          actualFixed: countState.count,
          beforeRequired: asInt(notice.extraSessionsRequired),
          afterRequired: null,
          historicalAfter: Math.max(
            asInt(notice.historicalExtraSessionsRequired),
            asInt(notice.extraSessionsRequired)
          ),
        });
      }
      continue;
    }

    const cycle = cycleBySubscription.get(String(subscription._id));
    const plan = Math.max(
      1,
      asInt(cycle?.planSnapshot?.monthlySessions) || asInt(subscription.monthlySessions)
    );
    const actualFixed = countState.count;
    const expectedRequired = Math.max(0, actualFixed - plan);

    if (!notice && expectedRequired <= 0) continue;

    const beforeRequired = asInt(notice?.extraSessionsRequired);
    const previousHistorical = Math.max(
      asInt(notice?.historicalExtraSessionsRequired),
      beforeRequired
    );
    const historicalAfter = Math.max(previousHistorical, expectedRequired);

    let action = "UNCHANGED";
    if (!notice && expectedRequired > 0) action = "CREATE_NOTICE";
    else if (beforeRequired !== expectedRequired) action = "UPDATE_CURRENT";
    else if (asInt(notice?.historicalExtraSessionsRequired) < previousHistorical)
      action = "BACKFILL_HISTORY";

    if (action === "UNCHANGED") continue;

    preview.push({
      action,
      user: userName(subscription.user, userId),
      email: clean(subscription?.user?.email),
      subscriptionStatus: clean(subscription.status),
      service: serviceKey,
      plan,
      actualFixed,
      beforeRequired,
      afterRequired: expectedRequired,
      purchased: asInt(notice?.extraSessionsPurchased),
      historicalBefore: asInt(notice?.historicalExtraSessionsRequired),
      historicalAfter,
    });

    if (!apply) continue;

    if (!notice) {
      const created = new SubscriptionExtraSessionNotice({
        user: userId,
        subscription: subscription._id,
        serviceKey,
        periodKey,
        fixedScheduleIds: countState.fixedScheduleIds,
        basePlanSessions: plan,
        projectedFixedOccurrences: actualFixed,
        blockedOccurrencesCount: 0,
        extraSessionsRequired: expectedRequired,
        extraSessionsPurchased: 0,
        historicalBasePlanSessions: plan,
        historicalFixedOccurrences: actualFixed,
        historicalExtraSessionsRequired: expectedRequired,
        historicalFirstDetectedAt: new Date(),
        historicalLastChangedAt: new Date(),
        occurrenceSource: "actual_current_month_appointments",
        calculatedAt: new Date(),
        calculatedBy: null,
        source: "manual_refresh",
      });
      await created.save();
      writes.push({ action, noticeId: String(created._id), userId, serviceKey });
      continue;
    }

    // Preservar el contexto del máximo viejo ANTES de sobrescribir el actual.
    const oldPeak = Math.max(
      asInt(notice.historicalExtraSessionsRequired),
      beforeRequired
    );
    if (oldPeak > 0 && !asInt(notice.historicalBasePlanSessions)) {
      notice.historicalBasePlanSessions = asInt(notice.basePlanSessions) || plan;
    }
    if (oldPeak > 0 && !asInt(notice.historicalFixedOccurrences)) {
      notice.historicalFixedOccurrences =
        asInt(notice.projectedFixedOccurrences) ||
        (asInt(notice.basePlanSessions) + oldPeak);
    }
    if (oldPeak > 0 && !notice.historicalFirstDetectedAt) {
      notice.historicalFirstDetectedAt = notice.createdAt || new Date();
    }

    if (expectedRequired > oldPeak) {
      notice.historicalBasePlanSessions = plan;
      notice.historicalFixedOccurrences = actualFixed;
      notice.historicalLastChangedAt = new Date();
    }

    notice.historicalExtraSessionsRequired = historicalAfter;
    notice.subscription = subscription._id;
    notice.fixedScheduleIds = countState.fixedScheduleIds;
    notice.basePlanSessions = plan;
    notice.projectedFixedOccurrences = actualFixed;
    notice.blockedOccurrencesCount = 0;
    notice.extraSessionsRequired = expectedRequired;
    // IMPORTANTE: no tocar extraSessionsPurchased ni order links.
    notice.occurrenceSource = "actual_current_month_appointments";
    notice.calculatedAt = new Date();
    notice.calculatedBy = null;
    notice.source = "manual_refresh";

    await notice.save();
    writes.push({ action, noticeId: String(notice._id), userId, serviceKey });
  }

  console.log(`\nRECONCILIACIÓN COBERTURA ACTUAL ${periodKey}`);
  console.log(apply ? "MODO: APPLY" : "MODO: DRY-RUN (NO MODIFICA DATOS)");
  console.log({
    subscriptions: subscriptions.length,
    notices: notices.length,
    appointmentPairs: counts.length,
    changesProposed: preview.length,
    writesApplied: writes.length,
  });

  if (preview.length) console.table(preview);
  else console.log("No hay cambios propuestos.");

  if (!apply) {
    console.log("\nNO SE MODIFICÓ NINGÚN DATO. Revisá la tabla antes de usar --apply.");
  } else {
    console.log("\nAPPLY terminado. Volvé a correr auditPlanCoverageHistory.js.");
  }
} finally {
  await mongoose.disconnect();
}
