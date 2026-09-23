// scripts/auditThirteenPaidRemaining.js
// SOLO LECTURA. No modifica MongoDB.
//
// Revisa los 13 usuarios residuales donde encontramos una Order paga de EP en
// septiembre pero el SubscriptionBillingCycle sigue en $0.
//
// No decide automáticamente que toda Order CREDITS sea un pago del plan.
// Expone la evidencia necesaria para decidir:
// - order exacta / monto / créditos / pricingPlanId
// - ciclo histórico / planSnapshot / billing
// - suscripción actual
// - lote mensual y lote creado por la Order
// - turnos futuros / fixed schedules
// - referencias de creditLotId en appointments
//
// Uso:
//   node scripts/auditThirteenPaidRemaining.js --period=2026-09

import "dotenv/config";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Order from "../src/models/Order.js";
import PricingPlan from "../src/models/PricingPlan.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import FixedSchedule from "../src/models/FixedSchedule.js";
import Appointment from "../src/models/Appointment.js";

const TARGETS = [
  ["constanzaiglesias@outlook.com", "6aa805bbadee6e1cd11d0b2e", 56250, 6],
  ["giandolce7@gmail.com",          "6a994bf43dabc1d5624c9335", 95000, 12],
  ["lamirocio7@gmail.com",          "6aa285ddadee6e1cd11b40c6", 95000, 12],
  ["leonardocollova@gmail.com",     "6a982dd177ad6f1af0e50b06", 75000, 8],
  ["mariasol.najle@gmail.com",      "6a9e951550decbd228d9966e", 75000, 8],
  ["mavirginialagos@gmail.com",     "6aa028fbadee6e1cd119d73a", 95000, 12],
  ["norabattaia@yahoo.com.ar",      "6a97f2aa77ad6f1af0e4acbf", 95000, 12],
  ["roberto.barroso59@gmail.com",   "6aa9aeafadee6e1cd11da811", 95000, 12],
  ["sanchezceleste834@gmail.com",   "6a9a97534aeb9880ebca1d1c", 47500, 6],
  ["szubiri@gmail.com",             "6a958de1beb2bba3d9ef2890", 75000, 8],
  ["taisbjmonaco@gmail.com",        "6aa996c9adee6e1cd11d97b3", 75000, 8],
  ["vidaguren9@hotmail.com",        "6a9ac6564aeb9880ebca4669", 60000, 4],
  ["yamilawynen@gmail.com",         "6a982c0577ad6f1af0e50644", 95000, 12],
].map(([email, orderId, amount, credits]) => ({
  email,
  orderId,
  expectedOrderAmount: amount,
  expectedOrderCredits: credits,
  serviceKey: "EP",
}));

function clean(v) {
  return String(v ?? "").trim();
}

function idOf(v) {
  return clean(v?._id || v?.id || v);
}

function money(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function int(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function parseArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? clean(found.slice(prefix.length)) : fallback;
}

function ymdAR(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getOrderCreditItems(order, serviceKey) {
  const sk = clean(serviceKey).toUpperCase();
  const items = Array.isArray(order?.items) ? order.items : [];

  const matches = items
    .filter(
      (item) =>
        clean(item?.kind).toUpperCase() === "CREDITS" &&
        clean(item?.serviceKey).toUpperCase() === sk
    )
    .map((item) => ({
      kind: "CREDITS",
      serviceKey: sk,
      credits: int(item?.credits) * Math.max(1, int(item?.qty) || 1),
      price: money(item?.price),
      qty: Math.max(1, int(item?.qty) || 1),
      pricingPlanId: idOf(item?.pricingPlanId || item?.planId),
    }));

  if (matches.length) return matches;

  if (clean(order?.serviceKey).toUpperCase() === sk && int(order?.credits) > 0) {
    return [{
      kind: "CREDITS",
      serviceKey: sk,
      credits: int(order.credits),
      price: money(order?.price ?? order?.totalFinal ?? order?.total),
      qty: 1,
      pricingPlanId: idOf(order?.pricingPlanId || order?.planId),
    }];
  }

  return [];
}

function classifyEvidence({
  orderAmount,
  orderCredits,
  cycleSessions,
  cycleTotal,
  currentSessions,
  pricingPlan,
}) {
  const reasons = [];

  if (orderCredits === cycleSessions && orderAmount === cycleTotal) {
    return {
      classification: "EXACT_HISTORICAL_PLAN_MATCH",
      confidence: "high",
      reasons: ["Order coincide exactamente con sesiones y total del ciclo histórico."],
    };
  }

  if (orderCredits === currentSessions && orderCredits !== cycleSessions) {
    reasons.push("Order coincide con las sesiones ACTUALES, no con las del ciclo histórico.");
  }

  if (orderCredits !== cycleSessions) {
    reasons.push(`Sesiones Order=${orderCredits} vs ciclo histórico=${cycleSessions}.`);
  }

  if (orderAmount !== cycleTotal) {
    reasons.push(`Monto Order=$${orderAmount} vs billing.total actual del ciclo=$${cycleTotal}.`);
  }

  if (pricingPlan) {
    const ppCredits = int(pricingPlan.credits);
    const ppPrice = money(pricingPlan.price);
    if (ppCredits === orderCredits && ppPrice === orderAmount) {
      reasons.push("La Order coincide con el PricingPlan referenciado.");
    }
  }

  if (orderCredits < cycleSessions && orderAmount < cycleTotal) {
    return {
      classification: "POSSIBLE_PARTIAL_OR_EXTRA",
      confidence: "review",
      reasons,
    };
  }

  if (orderCredits > cycleSessions || orderAmount > cycleTotal) {
    return {
      classification: "POSSIBLE_PLAN_CHANGE_OR_EXTRA",
      confidence: "review",
      reasons,
    };
  }

  return {
    classification: "REVIEW",
    confidence: "review",
    reasons,
  };
}

async function inspectTarget(target, periodKey, today) {
  const user = await User.findOne({ email: target.email.toLowerCase() }).lean();
  if (!user) return { email: target.email, error: "USER_NOT_FOUND" };

  const order = await Order.findById(target.orderId).lean();
  if (!order) return { email: target.email, error: "ORDER_NOT_FOUND" };

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

  const fixedSchedules = await FixedSchedule.find({
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

  const items = getOrderCreditItems(order, target.serviceKey);
  const firstItem = items[0] || null;
  const pricingPlan = firstItem?.pricingPlanId
    ? await PricingPlan.findById(firstItem.pricingPlanId).lean()
    : null;

  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
  const cycleLotId = idOf(cycle?.creditGrant?.lotId);
  const cycleLot = cycleLotId
    ? lots.find((lot) => idOf(lot) === cycleLotId) || null
    : null;

  const orderLots = lots.filter(
    (lot) =>
      idOf(lot?.orderId) === String(order._id) &&
      clean(lot?.serviceKey).toUpperCase() === target.serviceKey
  );

  const orderAmount = money(order?.totalFinal ?? order?.total ?? order?.price);
  const orderCredits = items.reduce((sum, item) => sum + int(item.credits), 0);
  const cycleSessions = int(
    cycle?.planSnapshot?.monthlySessions ??
      cycle?.creditGrant?.grantedSessions
  );
  const cycleTotal = money(cycle?.billing?.total);
  const currentSessions = int(subscription?.monthlySessions);

  const evidence = classifyEvidence({
    orderAmount,
    orderCredits,
    cycleSessions,
    cycleTotal,
    currentSessions,
    pricingPlan,
  });

  const linkedToCycleLot = cycleLotId
    ? await Appointment.countDocuments({
        user: user._id,
        creditLotId: cycleLotId,
      })
    : 0;

  const linkedToOrderLots = [];
  for (const lot of orderLots) {
    linkedToOrderLots.push({
      lotId: idOf(lot),
      appointmentCount: await Appointment.countDocuments({
        user: user._id,
        creditLotId: lot._id,
      }),
    });
  }

  return {
    email: target.email,
    expected: target,
    userId: String(user._id),
    subscription: subscription
      ? {
          id: String(subscription._id),
          status: subscription.status,
          autoRenew: subscription.autoRenew !== false,
          monthlySessions: currentSessions,
          price: money(subscription.price),
          regularPrice: money(subscription.regularPrice),
          payMethod: subscription.payMethod || "",
          currentPeriodKey: subscription.currentPeriodKey || "",
          fixedScheduleIds: (subscription.fixedScheduleIds || []).map(idOf),
        }
      : null,
    cycle: cycle
      ? {
          id: String(cycle._id),
          billingStatus: cycle.billing?.status || "",
          total: cycleTotal,
          amountReceived: money(cycle.billing?.amountReceived),
          amountPaid: money(cycle.billing?.amountPaid),
          balanceDue: money(cycle.billing?.balanceDue),
          lifecycleStatus: cycle.lifecycle?.planStatus || "",
          terminatedAt: cycle.lifecycle?.terminatedAt || null,
          planSnapshot: {
            monthlySessions: cycleSessions,
            basePrice: money(cycle.planSnapshot?.basePrice),
            regularPrice: money(cycle.planSnapshot?.regularPrice),
            payMethod: cycle.planSnapshot?.payMethod || "",
            pricingPlan: idOf(cycle.planSnapshot?.pricingPlan),
          },
          creditGrant: {
            granted: !!cycle.creditGrant?.granted,
            grantedSessions: int(cycle.creditGrant?.grantedSessions),
            lotId: cycleLotId,
            invalidatedAt: cycle.creditGrant?.invalidatedAt || null,
          },
        }
      : null,
    order: {
      id: String(order._id),
      status: order.status,
      createdByAdmin: order.createdByAdmin === true,
      paidAt: order.paidAt || null,
      createdAt: order.createdAt || null,
      payMethod: order.payMethod || "",
      total: orderAmount,
      kind: order.kind || "",
      subscriptionCycle: idOf(order.subscriptionCycle),
      periodKey: order.periodKey || "",
      creditsApplied: order.creditsApplied === true,
      items,
    },
    pricingPlan: pricingPlan
      ? {
          id: String(pricingPlan._id),
          serviceKey: pricingPlan.serviceKey,
          credits: int(pricingPlan.credits),
          price: money(pricingPlan.price),
          payMethod: pricingPlan.payMethod || "",
          active: pricingPlan.active !== false,
          isCustom: pricingPlan.isCustom === true,
        }
      : null,
    lots: {
      cycleLot: cycleLot
        ? {
            id: idOf(cycleLot),
            amount: int(cycleLot.amount),
            remaining: int(cycleLot.remaining),
            source: cycleLot.source || "",
            linkedAppointments: linkedToCycleLot,
          }
        : null,
      orderLots: orderLots.map((lot) => ({
        id: idOf(lot),
        amount: int(lot.amount),
        remaining: int(lot.remaining),
        source: lot.source || "",
        orderId: idOf(lot.orderId),
        linkedAppointments:
          linkedToOrderLots.find((x) => x.lotId === idOf(lot))?.appointmentCount || 0,
      })),
    },
    fixedSchedules: fixedSchedules.map((schedule) => ({
      id: String(schedule._id),
      active: schedule.active === true,
      items: (schedule.items || []).map((item) => ({
        weekday: Number(item.weekday || 0),
        time: clean(item.time).slice(0, 5),
      })),
      lastAutoReleasedMonthKey: schedule.lastAutoReleasedMonthKey || "",
    })),
    futureAppointments: appointments.map((ap) => ({
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
    evidence,
    hardChecks: {
      orderUserMatches: String(order.user) === String(user._id),
      orderPaid: ["paid", "approved"].includes(clean(order.status).toLowerCase()),
      exactOrderId: String(order._id) === target.orderId,
      exactOrderAmount: orderAmount === target.expectedOrderAmount,
      exactOrderCredits: orderCredits === target.expectedOrderCredits,
      serviceItemPresent: items.length > 0,
    },
  };
}

async function main() {
  const periodKey = parseArg("period", "2026-09");
  const today = ymdAR();

  if (!process.env.MONGO_URI) throw new Error("Falta MONGO_URI en .env");

  await mongoose.connect(process.env.MONGO_URI);

  try {
    console.log("\n" + "=".repeat(124));
    console.log(`AUDITORÍA 13 PAGOS RESIDUALES · ${periodKey} · SOLO LECTURA`);
    console.log(`Hoy AR: ${today}`);
    console.log("=".repeat(124));

    const results = [];

    for (const target of TARGETS) {
      const row = await inspectTarget(target, periodKey, today);
      results.push(row);

      console.log(`\n${row.email}`);

      if (row.error) {
        console.log(`  ERROR: ${row.error}`);
        continue;
      }

      console.log(
        `  Subscription: status=${row.subscription?.status || "-"} ` +
        `autoRenew=${row.subscription?.autoRenew ? "SI" : "NO"} ` +
        `currentPlan=${row.subscription?.monthlySessions || 0} sesiones / $${row.subscription?.price || 0}`
      );

      console.log(
        `  Cycle: billing=${row.cycle?.billingStatus || "-"} ` +
        `lifecycle=${row.cycle?.lifecycleStatus || "-"} ` +
        `histPlan=${row.cycle?.planSnapshot?.monthlySessions || 0} sesiones ` +
        `total=$${row.cycle?.total || 0} received=$${row.cycle?.amountReceived || 0}`
      );

      console.log(
        `  Order ${row.order.id}: status=${row.order.status} ` +
        `total=$${row.order.total} admin=${row.order.createdByAdmin ? "SI" : "NO"} ` +
        `creditsApplied=${row.order.creditsApplied ? "SI" : "NO"} ` +
        `cycleLink=${row.order.subscriptionCycle || "-"} period=${row.order.periodKey || "-"}`
      );

      for (const item of row.order.items) {
        console.log(
          `    CREDITS ${item.credits} / $${item.price} ` +
          `pricingPlan=${item.pricingPlanId || "-"}`
        );
      }

      if (row.pricingPlan) {
        console.log(
          `  PricingPlan: ${row.pricingPlan.credits} sesiones / $${row.pricingPlan.price} ` +
          `${row.pricingPlan.payMethod} active=${row.pricingPlan.active ? "SI" : "NO"}`
        );
      }

      console.log(
        `  Cycle lot: ${
          row.lots.cycleLot
            ? `amount=${row.lots.cycleLot.amount} remaining=${row.lots.cycleLot.remaining} linked=${row.lots.cycleLot.linkedAppointments}`
            : "-"
        }`
      );

      if (row.lots.orderLots.length) {
        for (const lot of row.lots.orderLots) {
          console.log(
            `  Order lot ${lot.id}: amount=${lot.amount} remaining=${lot.remaining} ` +
            `linked=${lot.linkedAppointments} source=${lot.source}`
          );
        }
      } else {
        console.log("  Order lot: NO ENCONTRADO");
      }

      const activeFixed = row.fixedSchedules.filter((x) => x.active).length;
      const inactiveFixed = row.fixedSchedules.length - activeFixed;
      const reservedFuture = row.futureAppointments.filter(
        (x) => x.status === "reserved"
      ).length;
      const cancelledFuture = row.futureAppointments.filter(
        (x) => x.status === "cancelled"
      ).length;

      console.log(
        `  Fijos: active=${activeFixed} inactive=${inactiveFixed} | ` +
        `appointments>=hoy reserved=${reservedFuture} cancelled=${cancelledFuture}`
      );

      console.log(
        `  EVIDENCIA: ${row.evidence.classification} (${row.evidence.confidence})`
      );
      for (const reason of row.evidence.reasons) {
        console.log(`    - ${reason}`);
      }

      console.log(
        `  HARD CHECKS: ${Object.entries(row.hardChecks)
          .map(([k, v]) => `${k}=${v ? "OK" : "NO"}`)
          .join(" | ")}`
      );
    }

    const summary = {
      periodKey,
      targets: results.length,
      found: results.filter((x) => !x.error).length,
      exactHistoricalPlanMatch: results.filter(
        (x) => x?.evidence?.classification === "EXACT_HISTORICAL_PLAN_MATCH"
      ).length,
      possiblePartialOrExtra: results.filter(
        (x) => x?.evidence?.classification === "POSSIBLE_PARTIAL_OR_EXTRA"
      ).length,
      possiblePlanChangeOrExtra: results.filter(
        (x) => x?.evidence?.classification === "POSSIBLE_PLAN_CHANGE_OR_EXTRA"
      ).length,
      review: results.filter(
        (x) => x?.evidence?.classification === "REVIEW"
      ).length,
      terminatedSubscriptions: results.filter(
        (x) => x?.subscription?.status === "terminated_for_non_payment"
      ).length,
      ordersWithDuplicateCreditLot: results.filter(
        (x) => (x?.lots?.orderLots || []).length > 0
      ).length,
    };

    console.log("\n" + "-".repeat(124));
    console.log(summary);
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
