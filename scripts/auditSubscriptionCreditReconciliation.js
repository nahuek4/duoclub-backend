// scripts/auditSubscriptionCreditReconciliation.js
// SOLO LECTURA.
// Segunda auditoría: NO elimina créditos.
// Clasifica lotes creados por órdenes CREDITS que conviven con el lote mensual
// de la suscripción y muestra cuánto fue consumido de cada lote.
//
// Uso:
//   node scripts/auditSubscriptionCreditReconciliation.js --period=2026-09
//   node scripts/auditSubscriptionCreditReconciliation.js --period=2026-09 --only-terminated

import "dotenv/config";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Order from "../src/models/Order.js";
import Appointment from "../src/models/Appointment.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";

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

function integer(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function parseArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? clean(found.slice(prefix.length)) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function monthBoundsArgentina(periodKey) {
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

  const end = new Date(next.getTime() - 1);
  const firstYmd = `${year}-${String(month).padStart(2, "0")}-01`;
  const last = new Date(next.getTime() - 24 * 60 * 60 * 1000);
  const lastYmd = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`;

  return { start, end, firstYmd, lastYmd };
}

function orderCreditEvidence(order, serviceKey) {
  const key = clean(serviceKey).toUpperCase();
  const items = Array.isArray(order?.items) ? order.items : [];

  const matches = items.filter(
    (item) =>
      clean(item?.kind).toUpperCase() === "CREDITS" &&
      clean(item?.serviceKey).toUpperCase() === key &&
      integer(item?.credits) > 0
  );

  if (matches.length) {
    return matches.map((item) => ({
      credits: integer(item?.credits) * Math.max(1, integer(item?.qty) || 1),
      amount:
        money(item?.price) ||
        money(order?.totalFinal ?? order?.total ?? order?.price),
      pricingPlanId: idOf(item?.pricingPlanId),
    }));
  }

  if (
    clean(order?.serviceKey).toUpperCase() === key &&
    integer(order?.credits) > 0
  ) {
    return [{
      credits: integer(order.credits),
      amount: money(order?.totalFinal ?? order?.total ?? order?.price),
      pricingPlanId: "",
    }];
  }

  return [];
}

function summarizeLot(lot) {
  return {
    id: idOf(lot),
    amount: integer(lot?.amount),
    remaining: integer(lot?.remaining),
    consumedByArithmetic: Math.max(
      0,
      integer(lot?.amount) - integer(lot?.remaining)
    ),
    source: clean(lot?.source),
    orderId: idOf(lot?.orderId),
    expiresAt: lot?.expiresAt || null,
  };
}

function classifyOrder({ cycle, order, evidence }) {
  const sessions = integer(cycle?.planSnapshot?.monthlySessions);
  const total = money(cycle?.billing?.total);
  const orderTotal = money(order?.totalFinal ?? order?.total ?? order?.price);

  const sameSessions = evidence.some((item) => item.credits === sessions);
  const sameAmount = total > 0 && orderTotal === total;

  if (sameSessions && sameAmount) return "LIKELY_PLAN_PAYMENT_DUPLICATE";

  if (orderTotal > 0 && total > 0 && orderTotal < total) {
    return "PARTIAL_OR_SPECIAL_PAYMENT_REVIEW";
  }

  if (!sameSessions) return "SESSION_MISMATCH_REVIEW";
  return "AMOUNT_MISMATCH_REVIEW";
}

async function linkedAppointmentStats({ userId, serviceKey, lotIds, firstYmd, lastYmd }) {
  if (!lotIds.length) return [];

  const appointments = await Appointment.find({
    user: userId,
    serviceKey,
    creditLotId: { $in: lotIds },
    date: { $gte: firstYmd, $lte: lastYmd },
  })
    .select(
      "_id date time status serviceKey fixedScheduleId creditLotId creditDebitStatus refundApplied cancelReason"
    )
    .sort({ date: 1, time: 1 })
    .lean();

  const byLot = new Map();

  for (const ap of appointments) {
    const lotId = idOf(ap.creditLotId);
    if (!byLot.has(lotId)) {
      byLot.set(lotId, {
        lotId,
        linked: 0,
        reserved: 0,
        completed: 0,
        cancelled: 0,
        refundedCancelled: 0,
        nonRefundedCancelled: 0,
        fixed: 0,
        samples: [],
      });
    }

    const stat = byLot.get(lotId);
    stat.linked += 1;

    const status = clean(ap.status).toLowerCase();
    if (status === "reserved") stat.reserved += 1;
    else if (status === "completed") stat.completed += 1;
    else if (status === "cancelled") {
      stat.cancelled += 1;
      if (ap.refundApplied === true) stat.refundedCancelled += 1;
      else stat.nonRefundedCancelled += 1;
    }

    if (ap.fixedScheduleId) stat.fixed += 1;

    if (stat.samples.length < 6) {
      stat.samples.push({
        id: String(ap._id),
        date: ap.date,
        time: ap.time,
        status: ap.status,
        fixed: Boolean(ap.fixedScheduleId),
        debitStatus: ap.creditDebitStatus || "",
        refundApplied: ap.refundApplied === true,
      });
    }
  }

  return [...byLot.values()];
}

async function main() {
  const periodKey = parseArg("period", "2026-09");
  const onlyTerminated = hasFlag("only-terminated");

  if (!process.env.MONGO_URI) {
    throw new Error("Falta MONGO_URI en .env");
  }

  const bounds = monthBoundsArgentina(periodKey);

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const cycleFilter = { periodKey };
    if (onlyTerminated) {
      cycleFilter["lifecycle.planStatus"] = "terminated";
    }

    const cycles = await SubscriptionBillingCycle.find(cycleFilter)
      .sort({ serviceKey: 1, user: 1 })
      .lean();

    const rows = [];
    const classCounts = {};

    for (const cycle of cycles) {
      const user = await User.findById(cycle.user)
        .select("name lastName fullName email creditLots credits")
        .lean();

      if (!user) continue;

      const serviceKey = clean(cycle.serviceKey).toUpperCase();
      const cycleLotId = idOf(cycle?.creditGrant?.lotId);
      const lots = Array.isArray(user.creditLots) ? user.creditLots : [];

      const cycleLot = lots.find((lot) => idOf(lot) === cycleLotId) || null;
      if (!cycleLot) continue;

      const orders = await Order.find({
        user: cycle.user,
        status: { $in: ["paid", "approved"] },
        $or: [
          { paidAt: { $gte: bounds.start, $lte: bounds.end } },
          { paidAt: null, createdAt: { $gte: bounds.start, $lte: bounds.end } },
        ],
      })
        .sort({ paidAt: 1, createdAt: 1 })
        .lean();

      const matching = [];

      for (const order of orders) {
        const evidence = orderCreditEvidence(order, serviceKey);
        if (!evidence.length) continue;

        const orderLots = lots.filter(
          (lot) =>
            idOf(lot?.orderId) === String(order._id) &&
            clean(lot?.serviceKey).toUpperCase() === serviceKey
        );

        if (!orderLots.length) continue;

        const classification = classifyOrder({ cycle, order, evidence });
        classCounts[classification] = (classCounts[classification] || 0) + 1;

        matching.push({
          order,
          evidence,
          classification,
          orderLots,
        });
      }

      if (!matching.length) continue;

      const allLotIds = [
        idOf(cycleLot),
        ...matching.flatMap((item) => item.orderLots.map((lot) => idOf(lot))),
      ].filter(Boolean);

      const appointmentStats = await linkedAppointmentStats({
        userId: cycle.user,
        serviceKey,
        lotIds: allLotIds,
        firstYmd: bounds.firstYmd,
        lastYmd: bounds.lastYmd,
      });

      rows.push({
        user,
        cycle,
        cycleLot,
        matching,
        appointmentStats,
      });
    }

    console.log("\n" + "=".repeat(120));
    console.log(
      `RECONCILIACIÓN DE LOTES · ${periodKey} · ${onlyTerminated ? "SOLO TERMINADOS · " : ""}SOLO LECTURA`
    );
    console.log("=".repeat(120));

    for (const row of rows) {
      const cycle = row.cycle;
      const cycleLot = summarizeLot(row.cycleLot);

      console.log(
        `\n${row.user.email || row.user._id} | ${cycle.serviceKey} | ` +
        `plan=${integer(cycle?.planSnapshot?.monthlySessions)} sesiones | ` +
        `billing=${clean(cycle?.billing?.status)} lifecycle=${clean(cycle?.lifecycle?.planStatus)}`
      );

      console.log(
        `  Ciclo dinero: total=$${money(cycle?.billing?.total)} ` +
        `recibido=$${money(cycle?.billing?.amountReceived)} ` +
        `pagado=$${money(cycle?.billing?.amountPaid)} ` +
        `saldo=$${money(cycle?.billing?.balanceDue)}`
      );

      console.log(
        `  Lote ciclo ${cycleLot.id}: amount=${cycleLot.amount} ` +
        `remaining=${cycleLot.remaining} consumed=${cycleLot.consumedByArithmetic} ` +
        `invalidado=${cycle?.creditGrant?.invalidatedAt ? "SI" : "NO"}`
      );

      for (const item of row.matching) {
        const orderId = String(item.order._id);
        const orderTotal = money(
          item.order?.totalFinal ?? item.order?.total ?? item.order?.price
        );
        const evidenceText = item.evidence
          .map((e) => `${e.credits}cr/$${e.amount}`)
          .join(" + ");

        console.log(
          `  Order ${orderId}: ${evidenceText} total=$${orderTotal} ` +
          `admin=${item.order.createdByAdmin ? "SI" : "NO"} ` +
          `creditsApplied=${item.order.creditsApplied ? "SI" : "NO"}`
        );
        console.log(`    CLASIFICACIÓN: ${item.classification}`);

        for (const lot of item.orderLots) {
          const summary = summarizeLot(lot);
          console.log(
            `    Lote order ${summary.id}: amount=${summary.amount} ` +
            `remaining=${summary.remaining} consumed=${summary.consumedByArithmetic} ` +
            `source=${summary.source}`
          );
        }
      }

      console.log("  Turnos vinculados por lote:");
      for (const stat of row.appointmentStats) {
        console.log(
          `    ${stat.lotId}: linked=${stat.linked} reserved=${stat.reserved} ` +
          `completed=${stat.completed} cancelled=${stat.cancelled} ` +
          `refundCancelled=${stat.refundedCancelled} nonRefundCancelled=${stat.nonRefundedCancelled} ` +
          `fixed=${stat.fixed}`
        );
      }

      console.log(
        "  >>> NO SE PROPONE BORRADO AUTOMÁTICO. La siguiente reparación debe reconciliar consumos y lotes, no poner créditos en 0 a ciegas."
      );
    }

    console.log("\n" + "-".repeat(120));
    console.log({
      ciclosRevisados: cycles.length,
      casosConvivenciaLotes: rows.length,
      clasificaciones: classCounts,
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
