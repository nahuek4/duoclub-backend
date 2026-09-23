// scripts/auditFourPartialCurrentState.js
// SOLO LECTURA. No modifica MongoDB.
//
// Objetivo:
// Ver el estado REAL actual de los 4 pagos parciales históricos sin depender
// del preview V5, que puede dejar de listarlos cuando su estado cambia.
//
// Uso:
//   node scripts/auditFourPartialCurrentState.js --period=2026-09

import "dotenv/config";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import FixedSchedule from "../src/models/FixedSchedule.js";
import Appointment from "../src/models/Appointment.js";
import Order from "../src/models/Order.js";
import SubscriptionLifecycleNotice from "../src/models/SubscriptionLifecycleNotice.js";

const TARGETS = [
  {
    email: "agustinaburs95@gmail.com",
    serviceKey: "EP",
    expectedTotal: 95000,
    expectedReceived: 90000,
  },
  {
    email: "celiaetchepare65@gmail.com",
    serviceKey: "EP",
    expectedTotal: 75000,
    expectedReceived: 70000,
  },
  {
    email: "fedeefron@gmail.com",
    serviceKey: "EP",
    expectedTotal: 95000,
    expectedReceived: 90000,
  },
  {
    email: "mariano.esandi@gmail.com",
    serviceKey: "EP",
    expectedTotal: 75000,
    expectedReceived: 70000,
  },
];

function clean(value) {
  return String(value ?? "").trim();
}

function idOf(value) {
  return clean(value?._id || value?.id || value);
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function parseArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? clean(found.slice(prefix.length)) : fallback;
}

function periodBounds(periodKey) {
  const [year, month] = periodKey.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) {
    throw new Error(`Período inválido: ${periodKey}`);
  }

  const start = new Date(
    `${year}-${String(month).padStart(2, "0")}-01T00:00:00-03:00`
  );

  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;

  const next = new Date(
    `${nextYear}-${String(nextMonth).padStart(2, "0")}-01T00:00:00-03:00`
  );

  return { start, next };
}

function ymdAR(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function orderServiceEvidence(order, serviceKey) {
  const sk = clean(serviceKey).toUpperCase();
  const items = Array.isArray(order?.items) ? order.items : [];

  const matches = items
    .filter((item) => clean(item?.serviceKey).toUpperCase() === sk)
    .map((item) => ({
      kind: clean(item?.kind).toUpperCase(),
      credits: Number(item?.credits || 0),
      price: money(item?.price),
      qty: Number(item?.qty || 1),
      pricingPlanId: idOf(item?.pricingPlanId),
    }));

  if (matches.length) return matches;

  if (clean(order?.serviceKey).toUpperCase() === sk) {
    return [{
      kind: clean(order?.kind).toUpperCase(),
      credits: Number(order?.credits || 0),
      price: money(order?.price ?? order?.totalFinal ?? order?.total),
      qty: 1,
      pricingPlanId: "",
    }];
  }

  return [];
}

async function inspectTarget(target, periodKey, bounds, today) {
  const user = await User.findOne({ email: target.email.toLowerCase() }).lean();

  if (!user) {
    return {
      email: target.email,
      error: "USER_NOT_FOUND",
    };
  }

  const subscription = await ServiceSubscription.findOne({
    user: user._id,
    serviceKey: target.serviceKey,
  }).lean();

  const cycle = subscription
    ? await SubscriptionBillingCycle.findOne({
        subscription: subscription._id,
        periodKey,
      }).lean()
    : null;

  const schedules = await FixedSchedule.find({
    user: user._id,
    serviceKey: target.serviceKey,
  })
    .sort({ createdAt: 1 })
    .lean();

  const appointments = await Appointment.find({
    user: user._id,
    serviceKey: target.serviceKey,
    date: { $gte: today },
  })
    .select(
      "_id date time status fixedScheduleId creditLotId creditDebitStatus cancelReason refundApplied"
    )
    .sort({ date: 1, time: 1 })
    .lean();

  const orders = await Order.find({
    user: user._id,
    status: { $in: ["paid", "approved"] },
    $or: [
      { paidAt: { $gte: bounds.start, $lt: bounds.next } },
      {
        paidAt: null,
        createdAt: { $gte: bounds.start, $lt: bounds.next },
      },
    ],
  })
    .sort({ paidAt: 1, createdAt: 1 })
    .lean();

  const serviceOrders = orders
    .map((order) => ({
      order,
      evidence: orderServiceEvidence(order, target.serviceKey),
    }))
    .filter((item) => item.evidence.length);

  const notices = subscription
    ? await SubscriptionLifecycleNotice.find({
        user: user._id,
        subscription: subscription._id,
        periodKey,
      })
        .sort({ createdAt: 1 })
        .lean()
    : [];

  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
  const cycleLotId = idOf(cycle?.creditGrant?.lotId);
  const cycleLot = cycleLotId
    ? lots.find((lot) => idOf(lot) === cycleLotId) || null
    : null;

  const orderLots = lots
    .filter((lot) => lot?.orderId)
    .filter((lot) => {
      const orderId = idOf(lot.orderId);
      return serviceOrders.some((item) => String(item.order._id) === orderId);
    })
    .map((lot) => ({
      id: idOf(lot),
      orderId: idOf(lot.orderId),
      source: clean(lot.source),
      amount: Number(lot.amount || 0),
      remaining: Number(lot.remaining || 0),
      expiresAt: lot.expiresAt || null,
    }));

  const activeFixed = schedules.filter((schedule) => schedule.active === true);
  const inactiveFixed = schedules.filter((schedule) => schedule.active !== true);
  const subscriptionFixedIds = new Set(
    Array.isArray(subscription?.fixedScheduleIds)
      ? subscription.fixedScheduleIds.map(idOf)
      : []
  );

  const reservedAppointments = appointments.filter(
    (ap) => clean(ap.status).toLowerCase() === "reserved"
  );
  const cancelledAppointments = appointments.filter(
    (ap) => clean(ap.status).toLowerCase() === "cancelled"
  );

  const total = money(cycle?.billing?.total);
  const received = money(cycle?.billing?.amountReceived);
  const paid = money(cycle?.billing?.amountPaid);
  const balance = Number.isFinite(Number(cycle?.billing?.balanceDue))
    ? money(cycle.billing.balanceDue)
    : Math.max(0, total - paid);

  const checks = {
    subscriptionActive: subscription?.status === "active",
    autoRenew: subscription?.autoRenew !== false,
    cycleLifecycleActive: cycle?.lifecycle?.planStatus === "active",
    receivedMatchesExpected: received === target.expectedReceived,
    totalMatchesExpected: total === target.expectedTotal,
    balanceMatchesExpected:
      balance === Math.max(0, target.expectedTotal - target.expectedReceived),
    cycleCreditInvalidationCleared: !cycle?.creditGrant?.invalidatedAt,
  };

  return {
    email: target.email,
    user: {
      id: String(user._id),
      creditsCache: Number(user.credits || 0),
    },
    subscription: subscription
      ? {
          id: String(subscription._id),
          status: subscription.status,
          autoRenew: subscription.autoRenew !== false,
          monthlySessions: Number(subscription.monthlySessions || 0),
          price: money(subscription.price),
          currentPeriodKey: subscription.currentPeriodKey || "",
          suspendedAt: subscription.suspendedAt || null,
          terminatedAt: subscription.terminatedAt || null,
          fixedScheduleIds: [...subscriptionFixedIds],
        }
      : null,
    cycle: cycle
      ? {
          id: String(cycle._id),
          billingStatus: cycle.billing?.status || "",
          total,
          amountReceived: received,
          amountPaid: paid,
          balanceDue: balance,
          payments: (cycle.billing?.payments || []).map((payment) => ({
            order: idOf(payment?.order),
            amount: money(payment?.amount),
            appliedAmount: money(payment?.appliedAmount),
            excessAmount: money(payment?.excessAmount),
            paidAt: payment?.paidAt || null,
            note: payment?.note || "",
          })),
          lifecycleStatus: cycle.lifecycle?.planStatus || "",
          lifecycleTerminatedAt: cycle.lifecycle?.terminatedAt || null,
          creditGrant: {
            granted: !!cycle.creditGrant?.granted,
            grantedSessions: Number(cycle.creditGrant?.grantedSessions || 0),
            lotId: cycleLotId,
            invalidatedAt: cycle.creditGrant?.invalidatedAt || null,
            invalidationReason: cycle.creditGrant?.invalidationReason || "",
          },
        }
      : null,
    cycleLot: cycleLot
      ? {
          id: idOf(cycleLot),
          amount: Number(cycleLot.amount || 0),
          remaining: Number(cycleLot.remaining || 0),
          source: cycleLot.source || "",
          expiresAt: cycleLot.expiresAt || null,
        }
      : null,
    fixedSchedules: schedules.map((schedule) => ({
      id: String(schedule._id),
      active: schedule.active === true,
      referencedBySubscription: subscriptionFixedIds.has(String(schedule._id)),
      items: (schedule.items || []).map((item) => ({
        weekday: Number(item.weekday || 0),
        time: clean(item.time).slice(0, 5),
      })),
      deactivatedAt: schedule.deactivatedAt || null,
      lastAutoReleasedMonthKey: schedule.lastAutoReleasedMonthKey || "",
    })),
    fixedSummary: {
      total: schedules.length,
      active: activeFixed.length,
      inactive: inactiveFixed.length,
    },
    futureAppointments: {
      total: appointments.length,
      reserved: reservedAppointments.length,
      cancelled: cancelledAppointments.length,
      items: appointments.map((ap) => ({
        id: String(ap._id),
        date: ap.date,
        time: ap.time,
        status: ap.status,
        fixedScheduleId: idOf(ap.fixedScheduleId),
        creditLotId: idOf(ap.creditLotId),
        creditDebitStatus: ap.creditDebitStatus || "",
        cancelReason: ap.cancelReason || "",
        refundApplied: ap.refundApplied === true,
      })),
    },
    orders: serviceOrders.map(({ order, evidence }) => ({
      id: String(order._id),
      status: order.status,
      paidAt: order.paidAt || null,
      createdAt: order.createdAt || null,
      total: money(order.totalFinal ?? order.total ?? order.price),
      kind: order.kind || "",
      subscriptionCycle: idOf(order.subscriptionCycle),
      periodKey: order.periodKey || "",
      evidence,
    })),
    orderLots,
    notices: notices.map((notice) => ({
      type: notice.type,
      status: notice.status,
      actionRequired: notice.actionRequired === true,
      createdAt: notice.createdAt || null,
      resolvedAt: notice.resolvedAt || null,
    })),
    checks,
  };
}

async function main() {
  const periodKey = parseArg("period", "2026-09");
  const bounds = periodBounds(periodKey);
  const today = ymdAR();

  if (!process.env.MONGO_URI) {
    throw new Error("Falta MONGO_URI en .env");
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    console.log("\n" + "=".repeat(118));
    console.log(`ESTADO REAL ACTUAL · 4 PAGOS PARCIALES · ${periodKey} · SOLO LECTURA`);
    console.log(`Hoy AR: ${today}`);
    console.log("=".repeat(118));

    const results = [];

    for (const target of TARGETS) {
      const result = await inspectTarget(target, periodKey, bounds, today);
      results.push(result);

      console.log(`\n${result.email}`);

      if (result.error) {
        console.log(`  ERROR: ${result.error}`);
        continue;
      }

      console.log(
        `  Subscription: status=${result.subscription?.status || "-"} ` +
        `autoRenew=${result.subscription?.autoRenew ? "SI" : "NO"} ` +
        `plan=${result.subscription?.monthlySessions || 0} ` +
        `price=$${result.subscription?.price || 0}`
      );

      console.log(
        `  Cycle: billing=${result.cycle?.billingStatus || "-"} ` +
        `lifecycle=${result.cycle?.lifecycleStatus || "-"} ` +
        `total=$${result.cycle?.total || 0} ` +
        `received=$${result.cycle?.amountReceived || 0} ` +
        `paid=$${result.cycle?.amountPaid || 0} ` +
        `balance=$${result.cycle?.balanceDue || 0}`
      );

      console.log(
        `  Cycle credit: invalidated=${result.cycle?.creditGrant?.invalidatedAt ? "SI" : "NO"} ` +
        `lot=${result.cycleLot?.id || "-"} ` +
        `amount=${result.cycleLot?.amount ?? "-"} ` +
        `remaining=${result.cycleLot?.remaining ?? "-"}`
      );

      console.log(
        `  FixedSchedules: total=${result.fixedSummary.total} ` +
        `active=${result.fixedSummary.active} inactive=${result.fixedSummary.inactive}`
      );

      for (const schedule of result.fixedSchedules) {
        console.log(
          `    ${schedule.id} active=${schedule.active ? "SI" : "NO"} ` +
          `subscriptionRef=${schedule.referencedBySubscription ? "SI" : "NO"} ` +
          `items=${schedule.items.map((item) => `${item.weekday}@${item.time}`).join(",") || "-"}`
        );
      }

      console.log(
        `  Appointments >= hoy: total=${result.futureAppointments.total} ` +
        `reserved=${result.futureAppointments.reserved} ` +
        `cancelled=${result.futureAppointments.cancelled}`
      );

      for (const ap of result.futureAppointments.items) {
        console.log(
          `    ${ap.date} ${ap.time} ${ap.status} ` +
          `fixed=${ap.fixedScheduleId || "-"} lot=${ap.creditLotId || "-"} ` +
          `debit=${ap.creditDebitStatus || "-"}`
        );
      }

      console.log(`  Orders septiembre: ${result.orders.length}`);
      for (const order of result.orders) {
        console.log(
          `    ${order.id} $${order.total} kind=${order.kind || "-"} ` +
          `cycle=${order.subscriptionCycle || "-"} period=${order.periodKey || "-"}`
        );
        for (const ev of order.evidence) {
          console.log(
            `      item ${ev.kind || "-"} credits=${ev.credits} price=$${ev.price}`
          );
        }
      }

      console.log(
        `  CHECKS: ${Object.entries(result.checks)
          .map(([key, value]) => `${key}=${value ? "OK" : "NO"}`)
          .join(" | ")}`
      );
    }

    const allBaseActive = results
      .filter((r) => !r.error)
      .every(
        (r) =>
          r.checks.subscriptionActive &&
          r.checks.autoRenew &&
          r.checks.cycleLifecycleActive &&
          r.checks.receivedMatchesExpected &&
          r.checks.totalMatchesExpected &&
          r.checks.balanceMatchesExpected &&
          r.checks.cycleCreditInvalidationCleared
      );

    console.log("\n" + "-".repeat(118));
    console.log({
      periodKey,
      usuarios: results.length,
      estadoBaseCorrectoEnLos4: allBaseActive,
      cuentasActivas: results.filter((r) => r?.checks?.subscriptionActive).length,
      lifecycleActivo: results.filter((r) => r?.checks?.cycleLifecycleActive).length,
      preciosCorrectos: results.filter((r) => r?.checks?.totalMatchesExpected).length,
      pagosCorrectos: results.filter((r) => r?.checks?.receivedMatchesExpected).length,
      saldosCorrectos: results.filter((r) => r?.checks?.balanceMatchesExpected).length,
      invalidacionesDeCreditoLimpias: results.filter(
        (r) => r?.checks?.cycleCreditInvalidationCleared
      ).length,
    });

    console.log("\nNO SE MODIFICÓ NINGÚN DATO.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error("\nAUDIT ERROR:", error?.stack || error?.message || error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
