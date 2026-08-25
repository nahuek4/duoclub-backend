// Motor mensual de suscripciones DUO.
// Reglas:
// - 7 días antes: aviso interno de renovación.
// - Día 1: ciclo mensual + sesiones del plan, aunque el pago siga pendiente.
// - Día 11 impago: suspende SOLO el servicio. Conserva horarios fijos hasta día 20.
// - Día 21 impago: libera turnos fijos, invalida saldo del ciclo y termina la suscripción.
// - Pago antes del día 21: reactiva automáticamente si estaba suspendida.
// No genera deuda. La renovación del día 1 envía un mail idempotente al usuario.

import mongoose from "mongoose";

import Appointment from "../../models/Appointment.js";
import FixedSchedule from "../../models/FixedSchedule.js";
import PricingPlan from "../../models/PricingPlan.js";
import ScheduleBlock from "../../models/ScheduleBlock.js";
import ServiceSubscription from "../../models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../../models/SubscriptionBillingCycle.js";
import SubscriptionLifecycleNotice from "../../models/SubscriptionLifecycleNotice.js";
import User from "../../models/User.js";
import { creditExpiryForMonthKey } from "../../utils/creditExpiry.js";
import { sendSubscriptionRenewalEmail } from "../../mail/subscriptionEmails.js";

import {
  calculateServiceMonthCoverage,
  monthRangeFromKey,
} from "./fixedScheduleCoverage.js";
import { projectActiveFixedSchedulesForMonth } from "./subscriptionScheduleProjection.js";

const TZ = "America/Argentina/Buenos_Aires";
const RENEWABLE_STATUSES = ["active", "pending_change"];
const OPERATIONAL_SUBSCRIPTION_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);
const SERVICE_NAME = {
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
  NUT: "Nutrición",
};

function pad2(n) {
  return String(n).padStart(2, "0");
}

function clean(value) {
  return String(value || "").trim();
}

function isOperationalSubscriptionServiceKey(value) {
  return OPERATIONAL_SUBSCRIPTION_SERVICE_KEYS.has(clean(value).toUpperCase());
}

function asInt(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function asMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function arParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

export function monthKeyFromDateArgentina(date = new Date()) {
  const p = arParts(date);
  return `${p.year}-${pad2(p.month)}`;
}

export function addMonthsToMonthKey(monthKey, delta = 1) {
  const [year, month] = clean(monthKey).split("-").map(Number);
  const date = new Date(year, month - 1 + Number(delta || 0), 1, 12, 0, 0, 0);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function localDate(periodKey, day, endOfDay = false) {
  const [year, month] = clean(periodKey).split("-").map(Number);
  const hh = endOfDay ? "23:59:59.999" : "00:00:00.000";
  return new Date(`${year}-${pad2(month)}-${pad2(day)}T${hh}-03:00`);
}

export function periodDates(periodKey) {
  const [year, month] = clean(periodKey).split("-").map(Number);
  const lastDay = new Date(year, month, 0, 12, 0, 0, 0).getDate();
  return {
    start: localDate(periodKey, 1, false),
    end: localDate(periodKey, lastDay, true),
    dueAt: localDate(periodKey, 10, true),
    suspendAt: localDate(periodKey, 11, false),
    fixedSlotsProtectedUntil: localDate(periodKey, 20, true),
    terminateAt: localDate(periodKey, 21, false),
  };
}

export function renewalPreviewDate(periodKey) {
  const { start } = periodDates(periodKey);
  return new Date(start.getTime() - 7 * 24 * 60 * 60 * 1000);
}

function isSameArgentinaYmd(a, b) {
  const pa = arParts(a);
  const pb = arParts(b);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

function recalcCredits(user, now = new Date()) {
  user.credits = (Array.isArray(user.creditLots) ? user.creditLots : []).reduce((sum, lot) => {
    const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return sum;
    return sum + Math.max(0, Number(lot?.remaining || 0));
  }, 0);
}

async function upsertLifecycleNotice({
  userId,
  subscriptionId,
  cycleId = null,
  serviceKey,
  periodKey,
  type,
  title,
  message,
  action = "none",
  actionRequired = false,
  metadata = {},
  session = null,
}) {
  const options = { new: true, upsert: true, setDefaultsOnInsert: true };
  if (session) options.session = session;

  return SubscriptionLifecycleNotice.findOneAndUpdate(
    { user: userId, subscription: subscriptionId, periodKey, type },
    {
      $set: {
        cycle: cycleId,
        serviceKey,
        title,
        message,
        action,
        actionRequired,
        metadata,
      },
      $setOnInsert: { status: "unread" },
    },
    options
  );
}

async function resolvePlanSnapshot(subscription, { session = null } = {}) {
  let plan = null;
  if (subscription.pricingPlan) {
    const query = PricingPlan.findById(subscription.pricingPlan).lean();
    if (session) query.session(session);
    plan = await query;
  }

  const monthlySessions = Math.max(1, asInt(plan?.credits || subscription.monthlySessions));
  const basePrice = asMoney(subscription.price ?? plan?.price);
  const payMethod = clean(subscription.payMethod || plan?.payMethod || "CASH").toUpperCase();

  return {
    pricingPlan: plan?._id || subscription.pricingPlan || null,
    label: clean(plan?.label || plan?.title || `${monthlySessions} sesiones`),
    monthlySessions,
    basePrice,
    regularPrice: asMoney(subscription.regularPrice || basePrice),
    coveragePrice:
      subscription.coveragePrice === null || subscription.coveragePrice === undefined
        ? null
        : asMoney(subscription.coveragePrice),
    coverageApplied: !!subscription.coverageApplied,
    coverageReason: clean(subscription.coverageReason),
    payMethod: payMethod === "MP" ? "MP" : "CASH",
    fixedScheduleIds: Array.isArray(subscription.fixedScheduleIds)
      ? subscription.fixedScheduleIds
      : [],
    addOns: Array.isArray(subscription.addOns) ? subscription.addOns : [],
  };
}

async function applyPendingChange(subscription, periodKey, { session = null, now = new Date() } = {}) {
  const pending = subscription.pendingChange;
  if (!pending || clean(pending.effectivePeriodKey) !== periodKey) {
    return { applied: false, continueRenewal: true };
  }

  const type = clean(pending.type || "change");

  if (type === "cancel") {
    subscription.status = "cancelled";
    subscription.autoRenew = false;
    subscription.cancelledAt = now;
    subscription.cancelReason = clean(pending.reason || "Cancelación programada antes de renovar.");
    subscription.pendingChange = null;
    await subscription.save({ session: session || undefined });
    return { applied: true, type, continueRenewal: false };
  }

  if (type === "suspend") {
    subscription.status = "suspended";
    subscription.suspendedAt = now;
    subscription.suspensionReason = clean(pending.reason || "Suspensión programada antes de renovar.");
    subscription.pendingChange = null;
    await subscription.save({ session: session || undefined });
    return { applied: true, type, continueRenewal: false };
  }

  if (type === "reactivate") {
    subscription.status = "active";
    subscription.suspendedAt = null;
    subscription.suspensionReason = "";
  }

  if (type === "change") {
    if (pending.pricingPlan) subscription.pricingPlan = pending.pricingPlan;
    if (pending.monthlySessions) subscription.monthlySessions = pending.monthlySessions;
    if (pending.price !== null && pending.price !== undefined) subscription.price = pending.price;
    if (pending.payMethod) subscription.payMethod = pending.payMethod;
    if (Array.isArray(pending.fixedScheduleIds) && pending.fixedScheduleIds.length) {
      subscription.fixedScheduleIds = pending.fixedScheduleIds;
    }
    if (Array.isArray(pending.addOns)) subscription.addOns = pending.addOns;
    subscription.autoRenew = pending.autoRenew !== false;
    subscription.status = "active";
  }

  subscription.pendingChange = null;
  await subscription.save({ session: session || undefined });
  return { applied: true, type, continueRenewal: true };
}

async function buildCoverageSnapshot(subscription, periodKey, planSessions) {
  const range = monthRangeFromKey(periodKey);
  const [schedules, blocks] = await Promise.all([
    FixedSchedule.find({
      user: subscription.user,
      serviceKey: subscription.serviceKey,
      active: true,
      startDate: { $lte: range.endYmd },
    }).lean(),
    ScheduleBlock.find({
      active: true,
      dateFrom: { $lte: range.endYmd },
      $or: [
        { indefinite: true },
        { dateTo: { $gte: range.startYmd } },
        { dateTo: "" },
        { dateTo: { $exists: false } },
      ],
    }).lean(),
  ]);

  const projection = projectActiveFixedSchedulesForMonth({
    schedules,
    monthKey: periodKey,
    serviceKey: subscription.serviceKey,
  });

  const coverage = calculateServiceMonthCoverage({
    schedules: projection.projectedSchedules,
    blocks,
    monthKey: periodKey,
    serviceKey: subscription.serviceKey,
    monthlySessions: planSessions,
    extraSessionsSelected: 0,
  });

  return {
    fixedScheduleIds: projection.projectedSchedules.map((s) => s._id).filter(Boolean),
    coverage,
  };
}

async function grantCycleCredits({ user, cycle, subscription, periodKey, session, now }) {
  const source = `subscription_cycle:${String(cycle._id)}:${periodKey}`;
  const expiresAt = creditExpiryForMonthKey(periodKey);
  const existingLot = (Array.isArray(user.creditLots) ? user.creditLots : []).find(
    (lot) => clean(lot?.source) === source
  );

  if (existingLot) {
    cycle.creditGrant.granted = true;
    cycle.creditGrant.grantedSessions = asInt(existingLot.amount);
    cycle.creditGrant.grantedAt = existingLot.createdAt || now;
    cycle.creditGrant.lotId = existingLot._id || null;
    cycle.creditGrant.expiresAt = existingLot.expiresAt || expiresAt;
    return existingLot;
  }

  user.creditLots = Array.isArray(user.creditLots) ? user.creditLots : [];
  user.creditLots.push({
    serviceKey: subscription.serviceKey,
    serviceName: SERVICE_NAME[subscription.serviceKey] || subscription.serviceKey,
    amount: cycle.planSnapshot.monthlySessions,
    remaining: cycle.planSnapshot.monthlySessions,
    expiresAt,
    source,
    orderId: null,
    createdAt: now,
  });

  const lot = user.creditLots[user.creditLots.length - 1];
  recalcCredits(user, now);
  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    action: "subscription_monthly_sessions_granted",
    title: `Plan mensual ${subscription.serviceKey}`,
    message: `Se acreditaron ${cycle.planSnapshot.monthlySessions} sesiones del plan para ${periodKey}.`,
    serviceKey: subscription.serviceKey,
    serviceName: SERVICE_NAME[subscription.serviceKey] || subscription.serviceKey,
    service: SERVICE_NAME[subscription.serviceKey] || subscription.serviceKey,
    qty: cycle.planSnapshot.monthlySessions,
    createdAt: now,
  });
  await user.save({ session });

  cycle.creditGrant.granted = true;
  cycle.creditGrant.grantedSessions = cycle.planSnapshot.monthlySessions;
  cycle.creditGrant.grantedAt = now;
  cycle.creditGrant.lotId = lot?._id || null;
  cycle.creditGrant.expiresAt = expiresAt;
  return lot;
}


async function sendRenewalConfirmationEmailOnce({
  cycleId,
  subscriptionId,
  now = new Date(),
} = {}) {
  if (!cycleId || !subscriptionId) {
    return { ok: false, skipped: true, reason: "MISSING_IDS" };
  }

  // Claim temporal para evitar que dos ticks/envíos concurrentes manden el mismo mail.
  // Si un proceso muere durante el envío, el claim vence a los 15 minutos y puede reintentarse.
  const staleClaimBefore = new Date(now.getTime() - 15 * 60 * 1000);

  const claimedCycle = await SubscriptionBillingCycle.findOneAndUpdate(
    {
      _id: cycleId,
      "notifications.renewalConfirmationSentAt": null,
      $or: [
        { "notifications.renewalConfirmationSendingAt": null },
        { "notifications.renewalConfirmationSendingAt": { $exists: false } },
        { "notifications.renewalConfirmationSendingAt": { $lt: staleClaimBefore } },
      ],
    },
    {
      $set: {
        "notifications.renewalConfirmationSendingAt": now,
        "notifications.renewalConfirmationLastError": "",
      },
    },
    { new: true }
  ).lean();

  if (!claimedCycle) {
    const existing = await SubscriptionBillingCycle.findById(cycleId)
      .select("notifications.renewalConfirmationSentAt notifications.renewalConfirmationSendingAt")
      .lean();

    if (existing?.notifications?.renewalConfirmationSentAt) {
      return { ok: true, skipped: true, reason: "ALREADY_SENT" };
    }

    return { ok: true, skipped: true, reason: "SEND_ALREADY_IN_PROGRESS" };
  }

  try {
    const [subscription, user] = await Promise.all([
      ServiceSubscription.findById(subscriptionId).lean(),
      User.findById(claimedCycle.user).lean(),
    ]);

    if (!subscription) throw new Error("SUBSCRIPTION_NOT_FOUND_FOR_RENEWAL_EMAIL");
    if (!user) throw new Error("USER_NOT_FOUND_FOR_RENEWAL_EMAIL");

    const nextPeriodKey = addMonthsToMonthKey(claimedCycle.periodKey, 1);
    const nextDates = periodDates(nextPeriodKey);

    const mailResult = await sendSubscriptionRenewalEmail({
      user,
      serviceKey: claimedCycle.serviceKey,
      serviceName: SERVICE_NAME[claimedCycle.serviceKey] || claimedCycle.serviceKey,
      periodKey: claimedCycle.periodKey,
      monthlySessions: claimedCycle.planSnapshot?.monthlySessions || 0,
      amount: claimedCycle.billing?.total || claimedCycle.planSnapshot?.basePrice || 0,
      payMethod: claimedCycle.planSnapshot?.payMethod || subscription.payMethod || "CASH",
      dueAt: claimedCycle.billing?.dueAt || periodDates(claimedCycle.periodKey).dueAt,
      nextRenewalAt: nextDates.start,
      billingStatus: claimedCycle.billing?.status || "pending",
      extraSessionsNeeded:
        claimedCycle.coverage?.additionalSessionsStillNeeded ??
        claimedCycle.coverage?.extraSessionsNeeded ??
        0,
    });

    // Los mails .invalid de los scripts de simulación se omiten sin marcar "sent".
    if (mailResult?.skipped) {
      await SubscriptionBillingCycle.updateOne(
        { _id: cycleId, "notifications.renewalConfirmationSentAt": null },
        {
          $set: {
            "notifications.renewalConfirmationSendingAt": null,
            "notifications.renewalConfirmationLastError": clean(mailResult.reason),
          },
        }
      );
      return { ok: true, skipped: true, reason: mailResult.reason };
    }

    const sentAt = new Date();
    await SubscriptionBillingCycle.updateOne(
      { _id: cycleId, "notifications.renewalConfirmationSentAt": null },
      {
        $set: {
          "notifications.renewalConfirmationSentAt": sentAt,
          "notifications.renewalConfirmationSendingAt": null,
          "notifications.renewalConfirmationLastError": "",
        },
      }
    );

    return { ok: true, sent: true, sentAt };
  } catch (error) {
    const message = clean(error?.message || error || "RENEWAL_EMAIL_FAILED").slice(0, 500);

    await SubscriptionBillingCycle.updateOne(
      { _id: cycleId, "notifications.renewalConfirmationSentAt": null },
      {
        $set: {
          "notifications.renewalConfirmationSendingAt": null,
          "notifications.renewalConfirmationLastError": message,
        },
      }
    );

    // El mail nunca puede hacer rollback ni romper la renovación del plan.
    return { ok: false, sent: false, error: message };
  }
}

export async function ensureMonthlyCycleForSubscription({ subscriptionId, periodKey, now = new Date() } = {}) {
  const session = await mongoose.startSession();
  let result = null;

  try {
    await session.withTransaction(async () => {
      const subscription = await ServiceSubscription.findById(subscriptionId).session(session);
      if (!subscription) {
        result = { ok: false, skipped: true, reason: "SUBSCRIPTION_NOT_FOUND" };
        return;
      }

      if (!isOperationalSubscriptionServiceKey(subscription.serviceKey)) {
        result = {
          ok: true,
          skipped: true,
          reason: "SERVICE_RETIRED",
          subscriptionId: String(subscription._id),
          serviceKey: clean(subscription.serviceKey).toUpperCase(),
        };
        return;
      }

      if (!subscription.autoRenew || !RENEWABLE_STATUSES.includes(subscription.status)) {
        result = { ok: true, skipped: true, reason: "NOT_RENEWABLE", subscriptionId: String(subscription._id) };
        return;
      }

      const pendingResult = await applyPendingChange(subscription, periodKey, { session, now });
      if (!pendingResult.continueRenewal) {
        result = {
          ok: true,
          skipped: true,
          reason: `PENDING_${String(pendingResult.type || "CHANGE").toUpperCase()}_APPLIED`,
          subscriptionId: String(subscription._id),
        };
        return;
      }

      const dates = periodDates(periodKey);
      const snapshot = await resolvePlanSnapshot(subscription, { session });
      const user = await User.findById(subscription.user).session(session);
      if (!user) throw new Error("USER_NOT_FOUND");

      let cycle = await SubscriptionBillingCycle.findOne({
        subscription: subscription._id,
        periodKey,
      }).session(session);

      let created = false;
      if (!cycle) {
        // El snapshot de cobertura se calcula fuera de la transacción para no
        // depender de populate ni escribir datos legacy. Si fallara, el ciclo
        // sigue siendo válido con cobertura base y el aviso extra se recalcula
        // después de materializar los turnos.
        cycle = new SubscriptionBillingCycle({
          subscription: subscription._id,
          user: subscription.user,
          serviceKey: subscription.serviceKey,
          periodKey,
          periodStart: dates.start,
          periodEnd: dates.end,
          idempotencyKey: `${String(subscription._id)}:${periodKey}`,
          planSnapshot: snapshot,
          coverage: {
            status: "covered",
            baseSessions: snapshot.monthlySessions,
            extraSessionsSelected: 0,
            totalSessions: snapshot.monthlySessions,
            calculatedAt: now,
          },
          billing: {
            status: "pending",
            amountBase: snapshot.basePrice,
            amountExtras: 0,
            amountAddOns: (snapshot.addOns || []).reduce(
              (sum, item) => sum + asMoney(item?.totalPrice),
              0
            ),
            total: snapshot.basePrice + (snapshot.addOns || []).reduce(
              (sum, item) => sum + asMoney(item?.totalPrice),
              0
            ),
            issuedAt: now,
            dueAt: dates.dueAt,
          },
          lifecycle: {
            planStatus: "active",
            fixedSlotsProtectedUntil: dates.fixedSlotsProtectedUntil,
          },
        });
        created = true;
      }

      if (!cycle.creditGrant?.granted) {
        await grantCycleCredits({ user, cycle, subscription, periodKey, session, now });
      }

      await cycle.save({ session });

      subscription.status = "active";
      subscription.currentPeriodKey = periodKey;
      subscription.currentPeriodStart = dates.start;
      subscription.currentPeriodEnd = dates.end;
      subscription.lastRenewedAt = now;
      subscription.suspendedAt = null;
      subscription.suspensionReason = "";
      subscription.fixedSlotsProtectedUntil = dates.fixedSlotsProtectedUntil;
      await subscription.save({ session });

      await upsertLifecycleNotice({
        userId: subscription.user,
        subscriptionId: subscription._id,
        cycleId: cycle._id,
        serviceKey: subscription.serviceKey,
        periodKey,
        type: "payment_pending",
        title: `Plan ${subscription.serviceKey} renovado`,
        message: `Se renovó tu plan de ${snapshot.monthlySessions} sesiones. El pago vence el día 10.`,
        action: "pay",
        actionRequired: true,
        metadata: {
          monthlySessions: snapshot.monthlySessions,
          amount: cycle.billing.total,
          payMethod: snapshot.payMethod,
          dueAt: dates.dueAt,
        },
        session,
      });

      result = {
        ok: true,
        created,
        subscriptionId: String(subscription._id),
        cycleId: String(cycle._id),
        userId: String(subscription.user),
        serviceKey: subscription.serviceKey,
        periodKey,
        monthlySessions: snapshot.monthlySessions,
        amount: cycle.billing.total,
        billingStatus: cycle.billing.status,
        creditGranted: !!cycle.creditGrant?.granted,
      };
    });

    // Cobertura proyectada se completa fuera de la transacción. Es informativa;
    // la fuente definitiva de sesiones adicionales del mes actual será
    // subscriptionExtraSessions luego de crear los Appointment.
    if (result?.ok && !result?.skipped && result?.cycleId) {
      try {
        const subscription = await ServiceSubscription.findById(result.subscriptionId).lean();
        const coverageState = await buildCoverageSnapshot(
          subscription,
          periodKey,
          result.monthlySessions
        );
        await SubscriptionBillingCycle.updateOne(
          { _id: result.cycleId },
          {
            $set: {
              "planSnapshot.fixedScheduleIds": coverageState.fixedScheduleIds,
              "coverage.status":
                coverageState.coverage.extraSessionsNeeded > 0
                  ? "extra_sessions_required"
                  : "covered",
              "coverage.baseSessions": result.monthlySessions,
              "coverage.fixedOccurrencesCount": coverageState.coverage.fixedOccurrencesCount,
              "coverage.blockedOccurrencesCount": coverageState.coverage.blockedOccurrencesCount,
              "coverage.coveredFixedOccurrences": coverageState.coverage.coveredFixedOccurrences,
              "coverage.uncoveredFixedOccurrences": coverageState.coverage.uncoveredFixedOccurrences,
              "coverage.extraSessionsNeeded": coverageState.coverage.extraSessionsNeeded,
              "coverage.additionalSessionsStillNeeded":
                coverageState.coverage.additionalSessionsStillNeeded,
              "coverage.freeSessions": coverageState.coverage.freeSessions,
              "coverage.occurrences": coverageState.coverage.occurrences,
              "coverage.blockedOccurrences": coverageState.coverage.blockedOccurrences,
              "coverage.calculatedAt": now,
            },
          }
        );
      } catch (error) {
        result.coverageWarning = error?.message || String(error);
      }

      // El mail se envía FUERA de la transacción de renovación.
      // Si SMTP falla, el ciclo/sesiones/plan siguen renovados normalmente.
      result.renewalEmail = await sendRenewalConfirmationEmailOnce({
        cycleId: result.cycleId,
        subscriptionId: result.subscriptionId,
        now,
      });
    }

    return result;
  } finally {
    await session.endSession();
  }
}

export async function createRenewalPreviewNotices({ targetPeriodKey, now = new Date(), force = false } = {}) {
  const previewDate = renewalPreviewDate(targetPeriodKey);
  if (!force && !isSameArgentinaYmd(now, previewDate)) {
    return { ok: true, skipped: true, reason: "NOT_PREVIEW_DATE", targetPeriodKey };
  }

  const subscriptions = await ServiceSubscription.find({
    autoRenew: true,
    status: { $in: RENEWABLE_STATUSES },
    serviceKey: { $in: [...OPERATIONAL_SUBSCRIPTION_SERVICE_KEYS] },
  }).lean();

  let createdOrUpdated = 0;
  for (const subscription of subscriptions) {
    const pending = subscription.pendingChange;
    const pendingForTarget = pending && clean(pending.effectivePeriodKey) === targetPeriodKey;
    const sessions = pendingForTarget && pending.monthlySessions
      ? pending.monthlySessions
      : subscription.monthlySessions;
    const price = pendingForTarget && pending.price !== null && pending.price !== undefined
      ? pending.price
      : subscription.price;

    await upsertLifecycleNotice({
      userId: subscription.user,
      subscriptionId: subscription._id,
      serviceKey: subscription.serviceKey,
      periodKey: targetPeriodKey,
      type: "renewal_preview",
      title: `Próxima renovación ${subscription.serviceKey}`,
      message: `Tu próximo plan incluye ${sessions} sesiones. Podés modificarlo antes de la renovación.`,
      action: "change_plan",
      actionRequired: false,
      metadata: {
        monthlySessions: sessions,
        amount: price,
        payMethod: pendingForTarget && pending.payMethod
          ? pending.payMethod
          : subscription.payMethod,
        pendingChangeType: pendingForTarget ? pending.type : "",
      },
    });
    createdOrUpdated += 1;
  }

  return { ok: true, targetPeriodKey, subscriptions: subscriptions.length, createdOrUpdated };
}

export async function renewPeriodSubscriptions({ periodKey, now = new Date(), force = false } = {}) {
  const p = arParts(now);
  if (!force && p.day !== 1) {
    return { ok: true, skipped: true, reason: "NOT_DAY_1", periodKey };
  }

  const subscriptions = await ServiceSubscription.find({
    autoRenew: true,
    status: { $in: RENEWABLE_STATUSES },
  }).select("_id").lean();

  const out = { ok: true, periodKey, read: subscriptions.length, created: 0, existing: 0, skipped: 0, errors: 0, results: [] };

  for (const item of subscriptions) {
    try {
      const result = await ensureMonthlyCycleForSubscription({
        subscriptionId: item._id,
        periodKey,
        now,
      });
      out.results.push(result);
      if (result?.skipped) out.skipped += 1;
      else if (result?.created) out.created += 1;
      else out.existing += 1;
    } catch (error) {
      out.errors += 1;
      out.results.push({ subscriptionId: String(item._id), error: error?.message || String(error) });
    }
  }

  return out;
}

export async function suspendOverdueSubscriptions({ periodKey, now = new Date(), force = false } = {}) {
  const dates = periodDates(periodKey);
  if (!force && now < dates.suspendAt) {
    return { ok: true, skipped: true, reason: "BEFORE_SUSPENSION_DATE", periodKey };
  }

  const cycles = await SubscriptionBillingCycle.find({
    periodKey,
    "billing.status": { $in: ["pending", "overdue"] },
    "lifecycle.planStatus": "active",
  });

  let suspended = 0;
  for (const cycle of cycles) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const freshCycle = await SubscriptionBillingCycle.findById(cycle._id).session(session);
        if (!freshCycle || !["pending", "overdue"].includes(freshCycle.billing.status)) return;

        const subscription = await ServiceSubscription.findById(freshCycle.subscription).session(session);
        if (!subscription) return;

        freshCycle.billing.status = "overdue";
        freshCycle.billing.overdueAt = freshCycle.billing.overdueAt || now;
        freshCycle.lifecycle.planStatus = "suspended";
        freshCycle.lifecycle.suspendedAt = freshCycle.lifecycle.suspendedAt || now;
        freshCycle.lifecycle.fixedSlotsProtectedUntil = dates.fixedSlotsProtectedUntil;
        await freshCycle.save({ session });

        subscription.status = "suspended";
        subscription.suspendedAt = subscription.suspendedAt || now;
        subscription.suspensionReason = "Pago mensual pendiente después del día 10.";
        subscription.fixedSlotsProtectedUntil = dates.fixedSlotsProtectedUntil;
        await subscription.save({ session });

        await upsertLifecycleNotice({
          userId: subscription.user,
          subscriptionId: subscription._id,
          cycleId: freshCycle._id,
          serviceKey: subscription.serviceKey,
          periodKey,
          type: "suspended",
          title: `Servicio ${subscription.serviceKey} suspendido`,
          message: "El pago del plan está pendiente. Tus horarios fijos se conservan hasta el día 20.",
          action: "pay",
          actionRequired: true,
          metadata: { fixedSlotsProtectedUntil: dates.fixedSlotsProtectedUntil },
          session,
        });
        suspended += 1;
      });
    } finally {
      await session.endSession();
    }
  }

  return { ok: true, periodKey, cycles: cycles.length, suspended };
}

async function invalidateCycleCredits({ cycle, user, now, session }) {
  const lotId = cycle.creditGrant?.lotId;
  if (!lotId) return 0;
  const lot = user.creditLots?.id?.(lotId);
  if (!lot) return 0;
  const removed = Math.max(0, Number(lot.remaining || 0));
  lot.remaining = 0;
  recalcCredits(user, now);
  cycle.creditGrant.invalidatedAt = now;
  cycle.creditGrant.invalidationReason = "Suscripción terminada por falta de pago.";
  await user.save({ session });
  return removed;
}

export async function terminateUnpaidSubscriptions({ periodKey, now = new Date(), force = false } = {}) {
  const dates = periodDates(periodKey);
  if (!force && now < dates.terminateAt) {
    return { ok: true, skipped: true, reason: "BEFORE_TERMINATION_DATE", periodKey };
  }

  const cycles = await SubscriptionBillingCycle.find({
    periodKey,
    "billing.status": { $in: ["pending", "overdue"] },
    "lifecycle.planStatus": { $in: ["active", "suspended"] },
  });

  const today = `${arParts(now).year}-${pad2(arParts(now).month)}-${pad2(arParts(now).day)}`;
  let terminated = 0;
  let fixedSchedulesReleased = 0;
  let appointmentsReleased = 0;
  let invalidatedSessions = 0;

  for (const cycle of cycles) {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const freshCycle = await SubscriptionBillingCycle.findById(cycle._id).session(session);
        if (!freshCycle || freshCycle.billing.status === "paid") return;

        const subscription = await ServiceSubscription.findById(freshCycle.subscription).session(session);
        const user = subscription
          ? await User.findById(subscription.user).session(session)
          : null;
        if (!subscription || !user) return;

        invalidatedSessions += await invalidateCycleCredits({ freshCycle, cycle: freshCycle, user, now, session });

        const scheduleResult = await FixedSchedule.updateMany(
          {
            user: subscription.user,
            serviceKey: subscription.serviceKey,
            active: true,
          },
          {
            $set: {
              active: false,
              deactivatedAt: now,
              lastAutoReleasedMonthKey: periodKey,
            },
          },
          { session }
        );
        fixedSchedulesReleased += Number(scheduleResult.modifiedCount || 0);

        const appointmentResult = await Appointment.updateMany(
          {
            user: subscription.user,
            serviceKey: subscription.serviceKey,
            fixedScheduleId: { $ne: null },
            status: "reserved",
            date: { $gte: today },
          },
          {
            $set: {
              status: "cancelled",
              cancelledAt: now,
              cancelReason: "Turno fijo liberado por falta de pago del plan mensual.",
              refundApplied: false,
              fixedDebtAmount: 0,
              creditDebitStatus: "skipped",
              fixedDebitProcessedAt: now,
            },
          },
          { session }
        );
        appointmentsReleased += Number(appointmentResult.modifiedCount || 0);

        freshCycle.billing.status = "overdue";
        freshCycle.lifecycle.planStatus = "terminated";
        freshCycle.lifecycle.terminatedAt = now;
        freshCycle.lifecycle.terminationReason = "Falta de pago al día 21.";
        await freshCycle.save({ session });

        subscription.status = "terminated_for_non_payment";
        subscription.autoRenew = false;
        subscription.terminatedAt = now;
        subscription.terminationReason = "Falta de pago al día 21.";
        subscription.fixedScheduleIds = [];
        await subscription.save({ session });

        await upsertLifecycleNotice({
          userId: subscription.user,
          subscriptionId: subscription._id,
          cycleId: freshCycle._id,
          serviceKey: subscription.serviceKey,
          periodKey,
          type: "terminated",
          title: `Plan ${subscription.serviceKey} dado de baja`,
          message: "El plan no fue abonado dentro del plazo y se liberaron tus horarios fijos.",
          action: "none",
          actionRequired: false,
          session,
        });
        terminated += 1;
      });
    } finally {
      await session.endSession();
    }
  }

  return {
    ok: true,
    periodKey,
    cycles: cycles.length,
    terminated,
    fixedSchedulesReleased,
    appointmentsReleased,
    invalidatedSessions,
  };
}

async function markSubscriptionCyclePaidCore({
  cycleId,
  paymentProvider = "",
  paymentId = "",
  orderId = null,
  paidAt = new Date(),
  session = null,
} = {}) {
  const cycleQuery = SubscriptionBillingCycle.findById(cycleId);
  if (session) cycleQuery.session(session);
  const cycle = await cycleQuery;
  if (!cycle) throw new Error("SUBSCRIPTION_CYCLE_NOT_FOUND");

  if (cycle.billing.status === "paid") {
    return {
      ok: true,
      alreadyPaid: true,
      cycleId: String(cycle._id),
      subscriptionId: String(cycle.subscription),
      periodKey: cycle.periodKey,
    };
  }

  const subscriptionQuery = ServiceSubscription.findById(cycle.subscription);
  if (session) subscriptionQuery.session(session);
  const subscription = await subscriptionQuery;
  if (!subscription) throw new Error("SUBSCRIPTION_NOT_FOUND");

  cycle.billing.status = "paid";
  cycle.billing.paidAt = paidAt;
  cycle.billing.paymentProvider = clean(paymentProvider);
  cycle.billing.paymentId = clean(paymentId);
  if (orderId) cycle.billing.order = orderId;

  let reactivated = false;
  if (subscription.status === "suspended") {
    subscription.status = "active";
    subscription.suspendedAt = null;
    subscription.suspensionReason = "";
    cycle.lifecycle.planStatus = "active";
    cycle.lifecycle.suspendedAt = null;
    reactivated = true;
  }

  await cycle.save({ session: session || undefined });
  await subscription.save({ session: session || undefined });

  const noticeOptions = session ? { session } : undefined;
  await SubscriptionLifecycleNotice.updateMany(
    {
      user: subscription.user,
      subscription: subscription._id,
      periodKey: cycle.periodKey,
      type: { $in: ["payment_pending", "suspended"] },
    },
    { $set: { status: "resolved", resolvedAt: paidAt } },
    noticeOptions
  );

  if (reactivated) {
    await upsertLifecycleNotice({
      userId: subscription.user,
      subscriptionId: subscription._id,
      cycleId: cycle._id,
      serviceKey: subscription.serviceKey,
      periodKey: cycle.periodKey,
      type: "reactivated",
      title: `Servicio ${subscription.serviceKey} reactivado`,
      message: "El pago fue acreditado y el servicio volvió a estar activo.",
      action: "none",
      actionRequired: false,
      session,
    });
  }

  return {
    ok: true,
    alreadyPaid: false,
    reactivated,
    cycleId: String(cycle._id),
    subscriptionId: String(subscription._id),
    periodKey: cycle.periodKey,
  };
}

export async function markSubscriptionCyclePaid({
  cycleId,
  paymentProvider = "",
  paymentId = "",
  orderId = null,
  paidAt = new Date(),
  session = null,
} = {}) {
  // Permite reutilizar la misma transacción de Order/MP sin abrir una transacción anidada.
  if (session) {
    return markSubscriptionCyclePaidCore({
      cycleId,
      paymentProvider,
      paymentId,
      orderId,
      paidAt,
      session,
    });
  }

  const ownedSession = await mongoose.startSession();
  let output = null;
  try {
    await ownedSession.withTransaction(async () => {
      output = await markSubscriptionCyclePaidCore({
        cycleId,
        paymentProvider,
        paymentId,
        orderId,
        paidAt,
        session: ownedSession,
      });
    });
    return output;
  } finally {
    await ownedSession.endSession();
  }
}

export async function previewSubscriptionLifecycle({ periodKey } = {}) {
  const subscriptions = await ServiceSubscription.find({
    autoRenew: true,
    status: { $in: RENEWABLE_STATUSES },
  })
    .populate("pricingPlan", "serviceKey credits price payMethod active isCustom")
    .lean();

  const rows = [];
  for (const subscription of subscriptions) {
    const pending = subscription.pendingChange;
    const duePending = pending && clean(pending.effectivePeriodKey) === periodKey;
    const effectiveSessions = duePending && pending.monthlySessions
      ? pending.monthlySessions
      : subscription.monthlySessions;
    const effectivePrice = duePending && pending.price !== null && pending.price !== undefined
      ? pending.price
      : subscription.price;

    const existingCycle = await SubscriptionBillingCycle.findOne({
      subscription: subscription._id,
      periodKey,
    }).select("_id billing.status creditGrant.granted").lean();

    rows.push({
      subscriptionId: String(subscription._id),
      userId: String(subscription.user),
      serviceKey: subscription.serviceKey,
      status: subscription.status,
      autoRenew: subscription.autoRenew,
      planSessions: effectiveSessions,
      amount: effectivePrice,
      payMethod: duePending && pending.payMethod ? pending.payMethod : subscription.payMethod,
      pendingChange: duePending ? pending.type : "",
      existingCycle: existingCycle
        ? {
            id: String(existingCycle._id),
            billingStatus: existingCycle.billing?.status,
            creditsGranted: !!existingCycle.creditGrant?.granted,
          }
        : null,
    });
  }

  return {
    periodKey,
    subscriptionsRead: rows.length,
    withoutCycle: rows.filter((row) => !row.existingCycle).length,
    withCycle: rows.filter((row) => !!row.existingCycle).length,
    rows,
  };
}

export async function runSubscriptionLifecycleTick({ now = new Date(), force = false } = {}) {
  const currentPeriodKey = monthKeyFromDateArgentina(now);
  const nextPeriodKey = addMonthsToMonthKey(currentPeriodKey, 1);
  const p = arParts(now);

  const preview = await createRenewalPreviewNotices({
    targetPeriodKey: nextPeriodKey,
    now,
    force,
  });

  const renew = await renewPeriodSubscriptions({
    periodKey: currentPeriodKey,
    now,
    force: false,
  });

  // Importante: `force` NO adelanta suspensión ni baja. Esas transiciones
  // respetan siempre los días 11 y 21 para evitar una baja accidental al
  // ejecutar manualmente el rollover.
  const suspend = await suspendOverdueSubscriptions({
    periodKey: currentPeriodKey,
    now,
    force: false,
  });

  const terminate = await terminateUnpaidSubscriptions({
    periodKey: currentPeriodKey,
    now,
    force: false,
  });

  return { ok: true, currentPeriodKey, nextPeriodKey, preview, renew, suspend, terminate };
}
