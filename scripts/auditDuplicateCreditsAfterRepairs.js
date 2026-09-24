// scripts/auditDuplicateCreditsAfterRepairs.js
//
// DUO CLUB — auditoría POST reparación de créditos duplicados.
// SOLO LECTURA.
//
// Objetivo:
// - revisar septiembre 2026 después de reparar los 4 parciales + 13 residuales;
// - detectar usuarios que todavía tengan convivencia entre:
//     * lote generado por el ciclo mensual;
//     * lote(s) generado(s) por Order CREDITS paga;
// - usar la regla de negocio actual:
//     "las sesiones compradas en Orders pagas son válidas; los turnos consumen
//      de ese total y el sobrante queda libre";
// - NO modificar MongoDB.
//
// Uso:
//   node scripts/auditDuplicateCreditsAfterRepairs.js --period=2026-09
//
// Opcional:
//   --service=EP
//   --only=email@dominio.com

import "dotenv/config";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Order from "../src/models/Order.js";
import Appointment from "../src/models/Appointment.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";

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

function asInt(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function parseArgs() {
  let periodKey = "2026-09";
  let serviceKey = "EP";
  let only = "";

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--period=")) {
      periodKey = clean(arg.slice("--period=".length));
    } else if (arg.startsWith("--service=")) {
      serviceKey = clean(arg.slice("--service=".length).toUpperCase());
    } else if (arg.startsWith("--only=")) {
      only = clean(arg.slice("--only=".length).toLowerCase());
    }
  }

  if (!/^\d{4}-\d{2}$/.test(periodKey)) {
    throw new Error(`Período inválido: ${periodKey}`);
  }

  return { periodKey, serviceKey, only };
}

function periodBounds(periodKey) {
  const [year, month] = periodKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return {
    startDate: new Date(`${periodKey}-01T00:00:00-03:00`),
    endDate: new Date(
      `${periodKey}-${String(lastDay).padStart(2, "0")}T23:59:59-03:00`
    ),
    startYmd: `${periodKey}-01`,
    endYmd: `${periodKey}-${String(lastDay).padStart(2, "0")}`,
  };
}

function orderCredits(order, serviceKey) {
  const sk = clean(serviceKey).toUpperCase();
  const items = Array.isArray(order?.items) ? order.items : [];

  let total = 0;

  for (const item of items) {
    if (clean(item?.kind).toUpperCase() !== "CREDITS") continue;
    if (clean(item?.serviceKey).toUpperCase() !== sk) continue;

    const qty = Math.max(1, asInt(item?.qty) || 1);
    total += asInt(item?.credits) * qty;
  }

  if (total > 0) return total;

  if (
    clean(order?.serviceKey).toUpperCase() === sk &&
    asInt(order?.credits) > 0
  ) {
    return asInt(order.credits);
  }

  return 0;
}

function isLifecycleCancellation(ap) {
  return (
    clean(ap?.status).toLowerCase() === "cancelled" &&
    /falta de pago|plan mensual/i.test(clean(ap?.cancelReason))
  );
}

function consumesSession(ap) {
  const status = clean(ap?.status).toLowerCase();

  if (status === "reserved" || status === "completed") {
    return true;
  }

  if (
    status === "cancelled" &&
    ap?.refundApplied !== true &&
    !isLifecycleCancellation(ap)
  ) {
    return true;
  }

  return false;
}

function summarizeAppointments(list) {
  const rows = Array.isArray(list) ? list : [];

  return {
    linked: rows.length,
    reserved: rows.filter((ap) => ap.status === "reserved").length,
    completed: rows.filter((ap) => ap.status === "completed").length,
    cancelled: rows.filter((ap) => ap.status === "cancelled").length,
    refundCancelled: rows.filter(
      (ap) => ap.status === "cancelled" && ap.refundApplied === true
    ).length,
    lifecycleCancelled: rows.filter(isLifecycleCancellation).length,
    nonRefundCancelled: rows.filter(
      (ap) =>
        ap.status === "cancelled" &&
        ap.refundApplied !== true &&
        !isLifecycleCancellation(ap)
    ).length,
    consumes: rows.filter(consumesSession).length,
    fixed: rows.filter((ap) => !!ap.fixedScheduleId).length,
    free: rows.filter((ap) => !ap.fixedScheduleId).length,
  };
}

async function inspectCycle(cycle, serviceKey, bounds) {
  const user = await User.findById(cycle.user);
  if (!user) return null;

  const subscription = await ServiceSubscription.findById(cycle.subscription).lean();

  const orders = await Order.find({
    user: user._id,
    status: { $in: ["paid", "approved"] },
    $or: [
      { paidAt: { $gte: bounds.startDate, $lte: bounds.endDate } },
      {
        paidAt: null,
        createdAt: { $gte: bounds.startDate, $lte: bounds.endDate },
      },
    ],
  })
    .sort({ paidAt: 1, createdAt: 1 })
    .lean();

  const paidCreditOrders = orders
    .map((order) => ({
      order,
      credits: orderCredits(order, serviceKey),
    }))
    .filter((row) => row.credits > 0);

  const orderIds = paidCreditOrders.map((row) => String(row.order._id));

  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
  const cycleLotId = idOf(cycle.creditGrant?.lotId);

  const currentCycleLot =
    cycleLotId && user.creditLots?.id
      ? user.creditLots.id(cycleLotId)
      : lots.find((lot) => idOf(lot) === cycleLotId) || null;

  // Lotes históricos creados por el propio ciclo.
  // La fuente actual es subscription_cycle:<cycleId>:<periodKey>
  const cycleSourcePrefix = `subscription_cycle:${String(cycle._id)}:${cycle.periodKey}`;
  const historicalCycleLots = lots.filter((lot) => {
    const source = clean(lot?.source);
    return (
      clean(lot?.serviceKey).toUpperCase() === serviceKey &&
      (source === cycleSourcePrefix ||
        source.startsWith(`subscription_cycle:${String(cycle._id)}:`))
    );
  });

  const orderLots = lots.filter(
    (lot) =>
      clean(lot?.serviceKey).toUpperCase() === serviceKey &&
      orderIds.includes(idOf(lot?.orderId))
  );

  const candidateLotIds = Array.from(
    new Set(
      [
        ...historicalCycleLots.map(idOf),
        ...orderLots.map(idOf),
        cycleLotId,
      ].filter((id) => mongoose.Types.ObjectId.isValid(id))
    )
  );

  const appointments = candidateLotIds.length
    ? await Appointment.find({
        user: user._id,
        serviceKey,
        creditLotId: { $in: candidateLotIds },
      })
        .select(
          "_id date time status fixedScheduleId creditLotId creditDebitStatus refundApplied cancelReason createdAt"
        )
        .sort({ date: 1, time: 1, createdAt: 1 })
        .lean()
    : [];

  const byLot = new Map();

  for (const lotId of candidateLotIds) {
    byLot.set(
      lotId,
      appointments.filter((ap) => idOf(ap.creditLotId) === lotId)
    );
  }

  const entitlementSessions = paidCreditOrders.reduce(
    (sum, row) => sum + row.credits,
    0
  );

  const uniqueConsumingAppointments = Array.from(
    new Map(
      appointments
        .filter(consumesSession)
        .map((ap) => [String(ap._id), ap])
    ).values()
  );

  const consumedSessions = uniqueConsumingAppointments.length;
  const expectedRemaining = Math.max(
    0,
    entitlementSessions - consumedSessions
  );

  const currentOrderLotsRemaining = orderLots.reduce(
    (sum, lot) => sum + asInt(lot.remaining),
    0
  );

  const currentHistoricalCycleLotsRemaining = historicalCycleLots.reduce(
    (sum, lot) => sum + asInt(lot.remaining),
    0
  );

  const currentRelevantRemaining =
    currentOrderLotsRemaining + currentHistoricalCycleLotsRemaining;

  const cycleGrantPointsToOrderLot = orderLots.some(
    (lot) => idOf(lot) === cycleLotId
  );

  const cycleGrantPointsToHistoricalCycleLot = historicalCycleLots.some(
    (lot) => idOf(lot) === cycleLotId
  );

  const allOrderLotsExact = paidCreditOrders.every((row) => {
    const matching = orderLots.filter(
      (lot) => idOf(lot.orderId) === String(row.order._id)
    );

    return (
      matching.length === 1 &&
      asInt(matching[0].amount) === row.credits
    );
  });

  let classification = "NO_PAID_CREDITS_ORDER";

  if (paidCreditOrders.length > 0) {
    if (
      cycleGrantPointsToOrderLot &&
      currentHistoricalCycleLotsRemaining === 0 &&
      currentRelevantRemaining === expectedRemaining
    ) {
      classification = "ALREADY_CANONICAL";
    } else if (
      allOrderLotsExact &&
      consumedSessions <= entitlementSessions &&
      paidCreditOrders.length >= 1
    ) {
      classification = "SAFE_RECONCILIATION_CANDIDATE";
    } else if (consumedSessions > entitlementSessions) {
      classification = "CONSUMPTION_EXCEEDS_PAID_SESSIONS_REVIEW";
    } else {
      classification = "STRUCTURE_REVIEW";
    }
  }

  const orderRows = paidCreditOrders.map((row) => {
    const orderLotRows = orderLots.filter(
      (lot) => idOf(lot.orderId) === String(row.order._id)
    );

    return {
      id: String(row.order._id),
      credits: row.credits,
      total: money(
        row.order.totalFinal ?? row.order.total ?? row.order.price
      ),
      admin: row.order.createdByAdmin === true,
      paidAt: row.order.paidAt || null,
      lots: orderLotRows.map((lot) => ({
        id: idOf(lot),
        amount: asInt(lot.amount),
        remaining: asInt(lot.remaining),
        source: clean(lot.source),
        stats: summarizeAppointments(byLot.get(idOf(lot)) || []),
      })),
    };
  });

  return {
    email: clean(user.email).toLowerCase(),
    userId: String(user._id),
    subscription: subscription
      ? {
          id: String(subscription._id),
          status: subscription.status,
          monthlySessions: asInt(subscription.monthlySessions),
          price: money(subscription.price),
        }
      : null,
    cycle: {
      id: String(cycle._id),
      billingStatus: cycle.billing?.status || "",
      lifecycleStatus: cycle.lifecycle?.planStatus || "",
      total: money(cycle.billing?.total),
      amountReceived: money(cycle.billing?.amountReceived),
      grantedSessions: asInt(cycle.creditGrant?.grantedSessions),
      lotId: cycleLotId,
      invalidated: !!cycle.creditGrant?.invalidatedAt,
    },
    orders: orderRows,
    historicalCycleLots: historicalCycleLots.map((lot) => ({
      id: idOf(lot),
      amount: asInt(lot.amount),
      remaining: asInt(lot.remaining),
      source: clean(lot.source),
      isCurrentCycleGrant: idOf(lot) === cycleLotId,
      stats: summarizeAppointments(byLot.get(idOf(lot)) || []),
    })),
    entitlementSessions,
    consumedSessions,
    expectedRemaining,
    currentOrderLotsRemaining,
    currentHistoricalCycleLotsRemaining,
    currentRelevantRemaining,
    cycleGrantPointsToOrderLot,
    cycleGrantPointsToHistoricalCycleLot,
    allOrderLotsExact,
    classification,
  };
}

async function main() {
  const { periodKey, serviceKey, only } = parseArgs();
  const bounds = periodBounds(periodKey);

  if (!process.env.MONGO_URI) {
    throw new Error("Falta MONGO_URI en .env");
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const cycles = await SubscriptionBillingCycle.find({
      periodKey,
      serviceKey,
    })
      .sort({ createdAt: 1 })
      .lean();

    console.log("\n" + "=".repeat(126));
    console.log(
      `AUDITORÍA DUPLICADOS POST-REPARACIÓN · ${periodKey} · ${serviceKey} · SOLO LECTURA`
    );
    console.log("=".repeat(126));

    const rows = [];

    for (const cycle of cycles) {
      const row = await inspectCycle(cycle, serviceKey, bounds);
      if (!row) continue;
      if (only && row.email !== only) continue;

      // Mostramos solamente ciclos donde existe al menos una Order CREDITS paga
      // o todavía hay coexistencia de lotes relevantes.
      if (
        row.orders.length === 0 &&
        row.historicalCycleLots.length <= 1
      ) {
        continue;
      }

      rows.push(row);

      console.log(`\n${row.email}`);

      console.log(
        `  Subscription: status=${row.subscription?.status || "-"} ` +
          `plan=${row.subscription?.monthlySessions || 0} / $${row.subscription?.price || 0}`
      );

      console.log(
        `  Cycle: billing=${row.cycle.billingStatus} ` +
          `lifecycle=${row.cycle.lifecycleStatus} ` +
          `total=$${row.cycle.total} received=$${row.cycle.amountReceived} ` +
          `granted=${row.cycle.grantedSessions} lot=${row.cycle.lotId || "-"}`
      );

      for (const order of row.orders) {
        console.log(
          `  Order ${order.id}: ${order.credits} sesiones / $${order.total} admin=${order.admin ? "SI" : "NO"}`
        );

        for (const lot of order.lots) {
          console.log(
            `    Order lot ${lot.id}: amount=${lot.amount} remaining=${lot.remaining} ` +
              `linked=${lot.stats.linked} consumes=${lot.stats.consumes} ` +
              `refundCancel=${lot.stats.refundCancelled} lifecycleCancel=${lot.stats.lifecycleCancelled}`
          );
        }

        if (!order.lots.length) {
          console.log("    Order lot: NO ENCONTRADO");
        }
      }

      for (const lot of row.historicalCycleLots) {
        console.log(
          `  Cycle-source lot ${lot.id}: amount=${lot.amount} remaining=${lot.remaining} ` +
            `currentGrant=${lot.isCurrentCycleGrant ? "SI" : "NO"} ` +
            `linked=${lot.stats.linked} consumes=${lot.stats.consumes} ` +
            `refundCancel=${lot.stats.refundCancelled} lifecycleCancel=${lot.stats.lifecycleCancelled}`
        );
      }

      console.log(
        `  RECONCILIACIÓN: entitlement=${row.entitlementSessions} ` +
          `consumed=${row.consumedSessions} expectedRemaining=${row.expectedRemaining} ` +
          `remainingActual=${row.currentRelevantRemaining}`
      );

      console.log(
        `  CLASIFICACIÓN: ${row.classification}`
      );
    }

    const summary = {
      periodKey,
      serviceKey,
      cyclesRead: cycles.length,
      rowsWithPaidCreditsOrCoexistence: rows.length,
      classifications: rows.reduce((acc, row) => {
        acc[row.classification] =
          Number(acc[row.classification] || 0) + 1;
        return acc;
      }, {}),
      safeCandidates: rows.filter(
        (row) =>
          row.classification === "SAFE_RECONCILIATION_CANDIDATE"
      ).length,
      alreadyCanonical: rows.filter(
        (row) => row.classification === "ALREADY_CANONICAL"
      ).length,
      consumptionReview: rows.filter(
        (row) =>
          row.classification ===
          "CONSUMPTION_EXCEEDS_PAID_SESSIONS_REVIEW"
      ).length,
      structureReview: rows.filter(
        (row) => row.classification === "STRUCTURE_REVIEW"
      ).length,
    };

    console.log("\n" + "-".repeat(126));
    console.log(summary);
    console.log("\nNO SE MODIFICÓ NINGÚN DATO.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(
    "\nAUDIT ERROR:",
    error?.stack || error?.message || error
  );

  try {
    await mongoose.disconnect();
  } catch {}

  process.exit(1);
});
