// scripts/auditSubscriptionDuplicateCreditLots.js
// SOLO LECTURA.
// Detecta ciclos mensuales que ya acreditaron su lote de suscripción y además
// tienen lotes creados por órdenes CREDITS pagadas en el mismo período.
// Esto sirve para encontrar acreditaciones duplicadas del bug histórico.
//
// Uso:
//   node scripts/auditSubscriptionDuplicateCreditLots.js --period=2026-09

import "dotenv/config";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Order from "../src/models/Order.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";

function clean(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function integer(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function idOf(value) {
  return clean(value?._id || value?.id || value);
}

function parseArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? clean(found.slice(prefix.length)) : fallback;
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

  return { start, end: new Date(next.getTime() - 1) };
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
    return [
      {
        credits: integer(order.credits),
        amount: money(order?.totalFinal ?? order?.total ?? order?.price),
        pricingPlanId: "",
      },
    ];
  }

  return [];
}

function summarizeLot(lot) {
  if (!lot) return null;
  return {
    id: idOf(lot),
    serviceKey: clean(lot?.serviceKey).toUpperCase(),
    amount: integer(lot?.amount),
    remaining: integer(lot?.remaining),
    source: clean(lot?.source),
    orderId: idOf(lot?.orderId),
    createdAt: lot?.createdAt || null,
    expiresAt: lot?.expiresAt || null,
  };
}

async function main() {
  const periodKey = parseArg("period", "2026-09");

  if (!process.env.MONGO_URI) {
    throw new Error("Falta MONGO_URI en .env");
  }

  const { start, end } = monthBoundsArgentina(periodKey);

  await mongoose.connect(process.env.MONGO_URI);

  try {
    const cycles = await SubscriptionBillingCycle.find({ periodKey })
      .sort({ serviceKey: 1, user: 1 })
      .lean();

    const rows = [];

    for (const cycle of cycles) {
      const user = await User.findById(cycle.user)
        .select("name lastName fullName email creditLots credits")
        .lean();

      if (!user) continue;

      const serviceKey = clean(cycle.serviceKey).toUpperCase();

      const orders = await Order.find({
        user: cycle.user,
        status: { $in: ["paid", "approved"] },
        $or: [
          { paidAt: { $gte: start, $lte: end } },
          {
            paidAt: null,
            createdAt: { $gte: start, $lte: end },
          },
        ],
      })
        .sort({ paidAt: 1, createdAt: 1 })
        .lean();

      const matchingOrders = [];

      for (const order of orders) {
        const evidence = orderCreditEvidence(order, serviceKey);
        if (!evidence.length) continue;

        matchingOrders.push({
          id: String(order._id),
          status: order.status,
          paidAt: order.paidAt || order.createdAt,
          payMethod: clean(order.payMethod).toUpperCase(),
          total: money(order?.totalFinal ?? order?.total ?? order?.price),
          creditsApplied: Boolean(order.creditsApplied),
          createdByAdmin: Boolean(order.createdByAdmin),
          evidence,
        });
      }

      const orderIds = new Set(matchingOrders.map((order) => order.id));

      const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
      const cycleLotId = idOf(cycle?.creditGrant?.lotId);
      const expectedCycleSource = `subscription_cycle:${String(cycle._id)}:${periodKey}`;

      const cycleLot =
        lots.find((lot) => idOf(lot) === cycleLotId) ||
        lots.find((lot) => clean(lot?.source) === expectedCycleSource) ||
        null;

      const orderLots = lots.filter((lot) => {
        const orderId = idOf(lot?.orderId);
        if (!orderId || !orderIds.has(orderId)) return false;
        return clean(lot?.serviceKey).toUpperCase() === serviceKey;
      });

      if (!cycleLot || !orderLots.length) continue;

      const orderLotsRemaining = orderLots.reduce(
        (sum, lot) => sum + integer(lot?.remaining),
        0
      );

      const samePlanEvidence = matchingOrders.map((order) => ({
        orderId: order.id,
        sameSessions: order.evidence.some(
          (item) =>
            item.credits === integer(cycle?.planSnapshot?.monthlySessions)
        ),
        samePricingPlan: order.evidence.some(
          (item) =>
            item.pricingPlanId &&
            item.pricingPlanId === idOf(cycle?.planSnapshot?.pricingPlan)
        ),
      }));

      rows.push({
        email: user.email || "",
        userId: String(user._id),
        serviceKey,
        cycleId: String(cycle._id),
        subscriptionId: idOf(cycle.subscription),
        subscriptionSessions: integer(cycle?.planSnapshot?.monthlySessions),
        cycleBillingTotal: money(cycle?.billing?.total),
        cycleAmountReceived: money(cycle?.billing?.amountReceived),
        cycleBalanceDue: money(cycle?.billing?.balanceDue),
        cycleBillingStatus: clean(cycle?.billing?.status),
        cyclePlanStatus: clean(cycle?.lifecycle?.planStatus),
        cycleCreditGrant: {
          grantedSessions: integer(cycle?.creditGrant?.grantedSessions),
          invalidatedAt: cycle?.creditGrant?.invalidatedAt || null,
        },
        cycleLot: summarizeLot(cycleLot),
        matchingOrders,
        samePlanEvidence,
        orderLots: orderLots.map(summarizeLot),
        orderLotsRemaining,
        potentialDuplicateRemainingNow: orderLotsRemaining,
        userCreditsCache: integer(user.credits),
      });
    }

    console.log("\n" + "=".repeat(112));
    console.log(`AUDITORÍA LOTES DUPLICADOS · ${periodKey} · SOLO LECTURA`);
    console.log("=".repeat(112));

    for (const row of rows) {
      console.log(
        `\n${row.email} | ${row.serviceKey} | ciclo ${row.subscriptionSessions} sesiones`
      );
      console.log(
        `  Ciclo: billing=${row.cycleBillingStatus} lifecycle=${row.cyclePlanStatus} ` +
          `total=$${row.cycleBillingTotal} recibido=$${row.cycleAmountReceived}`
      );
      console.log(
        `  Lote ciclo: amount=${row.cycleLot?.amount || 0} remaining=${row.cycleLot?.remaining || 0} ` +
          `invalidado=${row.cycleCreditGrant.invalidatedAt ? "SI" : "NO"}`
      );

      for (const order of row.matchingOrders) {
        const ev = order.evidence
          .map(
            (item) =>
              `${item.credits} cr / $${item.amount}` +
              (item.pricingPlanId ? ` / plan=${item.pricingPlanId}` : "")
          )
          .join(" + ");

        console.log(
          `  Order ${order.id}: ${ev} | creditsApplied=${order.creditsApplied ? "SI" : "NO"} | admin=${order.createdByAdmin ? "SI" : "NO"}`
        );
      }

      for (const lot of row.orderLots) {
        console.log(
          `    Lote order ${lot.orderId}: amount=${lot.amount} remaining=${lot.remaining} source=${lot.source}`
        );
      }

      console.log(
        `  >>> POSIBLE DUPLICADO ACTUAL: ${row.potentialDuplicateRemainingNow} créditos restantes en lotes de Order`
      );
    }

    console.log("\n" + "-".repeat(112));
    console.log({
      ciclosAuditados: cycles.length,
      casosConLoteCicloYLotDeOrder: rows.length,
      potencialesCreditosDuplicadosRestantes: rows.reduce(
        (sum, row) => sum + row.potentialDuplicateRemainingNow,
        0
      ),
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
