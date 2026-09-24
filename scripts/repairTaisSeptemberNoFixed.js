// scripts/repairTaisSeptemberNoFixed.js
//
// DUO CLUB — reparación específica de Tais B. J. Monaco.
// Regla: la Order paga de 8 sesiones/$75.000 es la fuente de septiembre.
// NO restaura el FixedSchedule viejo porque terminó el 2026-08-12.
// Las 8 sesiones quedan libres.
//
// DRY RUN por defecto.
// Uso:
//   node scripts/repairTaisSeptemberNoFixed.js --period=2026-09
//   node scripts/repairTaisSeptemberNoFixed.js --period=2026-09 --apply

import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Order from "../src/models/Order.js";
import Appointment from "../src/models/Appointment.js";
import FixedSchedule from "../src/models/FixedSchedule.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import SubscriptionLifecycleNotice from "../src/models/SubscriptionLifecycleNotice.js";

const EMAIL = "taisbjmonaco@gmail.com";
const ORDER_ID = "6aa996c9adee6e1cd11d97b3";
const SERVICE_KEY = "EP";
const EXPECTED_AMOUNT = 75000;
const EXPECTED_CREDITS = 8;

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
  let apply = false;

  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") apply = true;
    if (arg.startsWith("--period=")) {
      periodKey = clean(arg.slice("--period=".length));
    }
  }

  if (!/^\d{4}-\d{2}$/.test(periodKey)) {
    throw new Error(`Período inválido: ${periodKey}`);
  }

  return { periodKey, apply };
}

function periodBounds(periodKey) {
  const [year, month] = periodKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    startYmd: `${periodKey}-01`,
    endYmd: `${periodKey}-${String(lastDay).padStart(2, "0")}`,
  };
}

function ymdAR(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function extractOrderItem(order) {
  const items = (Array.isArray(order?.items) ? order.items : []).filter(
    (item) =>
      clean(item?.kind).toUpperCase() === "CREDITS" &&
      clean(item?.serviceKey).toUpperCase() === SERVICE_KEY
  );

  if (items.length !== 1) {
    throw new Error(`EXPECTED_ONE_EP_CREDITS_ITEM:${items.length}`);
  }

  const item = items[0];
  const qty = Math.max(1, asInt(item?.qty) || 1);
  const credits = asInt(item?.credits) * qty;

  return {
    item,
    credits,
    price: money(item?.price),
    pricingPlanId: idOf(item?.pricingPlanId || item?.planId),
    label: clean(item?.label),
    coverageApplied: Boolean(item?.coverageApplied),
    coveragePrice:
      item?.coveragePrice === null || item?.coveragePrice === undefined
        ? null
        : money(item.coveragePrice),
    discountReason: clean(item?.discountReason),
  };
}

function recalcUserCredits(user, now = new Date()) {
  user.credits = (Array.isArray(user?.creditLots) ? user.creditLots : []).reduce(
    (sum, lot) => {
      const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
      if (exp && exp <= now) return sum;
      return sum + Math.max(0, Number(lot?.remaining || 0));
    },
    0
  );
}

async function inspect(periodKey, session = null) {
  const bounds = periodBounds(periodKey);
  const today = ymdAR();

  const userQ = User.findOne({ email: EMAIL });
  if (session) userQ.session(session);
  const user = await userQ;
  if (!user) throw new Error("USER_NOT_FOUND");

  const orderQ = Order.findById(ORDER_ID);
  if (session) orderQ.session(session);
  const order = await orderQ;
  if (!order) throw new Error("ORDER_NOT_FOUND");

  if (String(order.user) !== String(user._id)) {
    throw new Error("ORDER_USER_MISMATCH");
  }

  if (!["paid", "approved"].includes(clean(order.status).toLowerCase())) {
    throw new Error(`ORDER_NOT_PAID:${order.status}`);
  }

  const orderAmount = money(order.totalFinal ?? order.total ?? order.price);
  const orderInfo = extractOrderItem(order);

  if (orderAmount !== EXPECTED_AMOUNT) {
    throw new Error(`ORDER_AMOUNT_CHANGED:${orderAmount}`);
  }

  if (orderInfo.credits !== EXPECTED_CREDITS) {
    throw new Error(`ORDER_CREDITS_CHANGED:${orderInfo.credits}`);
  }

  const subQ = ServiceSubscription.findOne({
    user: user._id,
    serviceKey: SERVICE_KEY,
  });
  if (session) subQ.session(session);
  const subscription = await subQ;
  if (!subscription) throw new Error("SUBSCRIPTION_NOT_FOUND");

  const cycleQ = SubscriptionBillingCycle.findOne({
    subscription: subscription._id,
    periodKey,
  });
  if (session) cycleQ.session(session);
  const cycle = await cycleQ;
  if (!cycle) throw new Error("CYCLE_NOT_FOUND");

  const schedulesQ = FixedSchedule.find({
    user: user._id,
    serviceKey: SERVICE_KEY,
  }).sort({ createdAt: 1 });
  if (session) schedulesQ.session(session);
  const schedules = await schedulesQ;

  const overlappingSchedules = schedules.filter((schedule) => {
    const start = clean(schedule.startDate).slice(0, 10);
    const end = clean(schedule.endDate).slice(0, 10);
    const startsBeforePeriodEnds = !start || start <= bounds.endYmd;
    const endsAfterPeriodStarts = !end || end >= bounds.startYmd;
    return startsBeforePeriodEnds && endsAfterPeriodStarts;
  });

  const activeSchedules = schedules.filter((schedule) => schedule.active === true);

  const futureFixedQ = Appointment.find({
    user: user._id,
    serviceKey: SERVICE_KEY,
    fixedScheduleId: { $ne: null },
    date: { $gte: today },
  })
    .select("_id date time status fixedScheduleId creditLotId")
    .sort({ date: 1, time: 1 });
  if (session) futureFixedQ.session(session);
  const futureFixed = await futureFixedQ;

  const orderLots = (Array.isArray(user.creditLots) ? user.creditLots : []).filter(
    (lot) =>
      idOf(lot?.orderId) === String(order._id) &&
      clean(lot?.serviceKey).toUpperCase() === SERVICE_KEY
  );

  if (orderLots.length !== 1) {
    throw new Error(`EXPECTED_ONE_ORDER_LOT:${orderLots.length}`);
  }

  const orderLot = orderLots[0];

  if (asInt(orderLot.amount) !== EXPECTED_CREDITS) {
    throw new Error(`ORDER_LOT_AMOUNT_CHANGED:${asInt(orderLot.amount)}`);
  }

  const cycleLotId = idOf(cycle.creditGrant?.lotId);
  const cycleLot =
    cycleLotId && user.creditLots?.id ? user.creditLots.id(cycleLotId) : null;

  const linkedOrder = await Appointment.countDocuments({
    user: user._id,
    creditLotId: orderLot._id,
  }).session(session || null);

  const linkedCycle =
    cycleLot && String(cycleLot._id) !== String(orderLot._id)
      ? await Appointment.countDocuments({
          user: user._id,
          creditLotId: cycleLot._id,
        }).session(session || null)
      : 0;

  const errors = [];

  if (activeSchedules.length) {
    errors.push({
      type: "ACTIVE_FIXED_SCHEDULE_PRESENT",
      ids: activeSchedules.map((s) => String(s._id)),
    });
  }

  if (overlappingSchedules.length) {
    errors.push({
      type: "FIXED_SCHEDULE_OVERLAPS_SEPTEMBER",
      schedules: overlappingSchedules.map((s) => ({
        id: String(s._id),
        startDate: s.startDate || null,
        endDate: s.endDate || null,
        active: !!s.active,
        items: (s.items || []).map((item) => ({
          weekday: Number(item.weekday || 0),
          time: clean(item.time).slice(0, 5),
        })),
      })),
    });
  }

  if (futureFixed.some((ap) => ap.status === "reserved")) {
    errors.push({
      type: "FUTURE_FIXED_APPOINTMENT_PRESENT",
      items: futureFixed
        .filter((ap) => ap.status === "reserved")
        .map((ap) => ({
          id: String(ap._id),
          date: ap.date,
          time: ap.time,
          fixedScheduleId: idOf(ap.fixedScheduleId),
        })),
    });
  }

  if (linkedOrder !== 0 || linkedCycle !== 0) {
    errors.push({
      type: "CREDIT_LOTS_HAVE_APPOINTMENT_REFERENCES",
      linkedOrder,
      linkedCycle,
    });
  }

  const alreadyRepaired =
    subscription.status === "active" &&
    cycle.lifecycle?.planStatus === "active" &&
    cycle.billing?.status === "paid" &&
    String(cycle.billing?.order || "") === String(order._id) &&
    money(cycle.billing?.total) === EXPECTED_AMOUNT &&
    money(cycle.billing?.amountReceived) === EXPECTED_AMOUNT &&
    asInt(cycle.creditGrant?.grantedSessions) === EXPECTED_CREDITS &&
    String(cycle.creditGrant?.lotId || "") === String(orderLot._id);

  return {
    user,
    order,
    orderInfo,
    orderAmount,
    subscription,
    cycle,
    schedules,
    activeSchedules,
    overlappingSchedules,
    futureFixed,
    orderLot,
    cycleLot,
    cycleLotId,
    linkedOrder,
    linkedCycle,
    errors,
    alreadyRepaired,
    ready: errors.length === 0,
  };
}

function ensureBackupDir() {
  const dir = path.resolve(process.cwd(), "backups", "subscription-repairs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function serializable(doc) {
  return doc?.toObject ? doc.toObject({ depopulate: true }) : doc;
}

async function writeBackup(state, periodKey) {
  const dir = ensureBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(
    dir,
    `before-repair-tais-${periodKey}-${stamp}.json`
  );

  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        periodKey,
        user: serializable(state.user),
        order: serializable(state.order),
        subscription: serializable(state.subscription),
        cycle: serializable(state.cycle),
        schedules: state.schedules.map(serializable),
        futureFixed: state.futureFixed.map(serializable),
      },
      null,
      2
    )
  );

  return file;
}

async function applyRepair(periodKey) {
  const session = await mongoose.startSession();
  let output = null;

  try {
    await session.withTransaction(async () => {
      const state = await inspect(periodKey, session);

      if (!state.ready) {
        const err = new Error("PRECHECK_FAILED_DURING_APPLY");
        err.details = state.errors;
        throw err;
      }

      const {
        user,
        order,
        orderInfo,
        subscription,
        cycle,
        orderLot,
        cycleLot,
      } = state;

      const now = new Date();

      // Lote canónico: Order de 8 sesiones. No hay consumos vinculados.
      orderLot.amount = EXPECTED_CREDITS;
      orderLot.remaining = EXPECTED_CREDITS;

      if (
        cycleLot &&
        String(cycleLot._id) !== String(orderLot._id)
      ) {
        cycleLot.remaining = 0;
      }

      recalcUserCredits(user, now);

      // Corrige únicamente el ciclo histórico de septiembre.
      cycle.planSnapshot.monthlySessions = EXPECTED_CREDITS;
      cycle.planSnapshot.basePrice = EXPECTED_AMOUNT;
      cycle.planSnapshot.regularPrice = EXPECTED_AMOUNT;
      cycle.planSnapshot.coveragePrice = orderInfo.coveragePrice;
      cycle.planSnapshot.coverageApplied = orderInfo.coverageApplied;
      cycle.planSnapshot.coverageReason = orderInfo.coverageApplied
        ? orderInfo.discountReason || "Cobertura"
        : "";
      cycle.planSnapshot.payMethod =
        clean(order.payMethod).toUpperCase() === "MP" ? "MP" : "CASH";
      cycle.planSnapshot.label =
        orderInfo.label || `${EXPECTED_CREDITS} sesiones`;
      cycle.planSnapshot.fixedScheduleIds = [];

      if (
        orderInfo.pricingPlanId &&
        mongoose.Types.ObjectId.isValid(orderInfo.pricingPlanId)
      ) {
        cycle.planSnapshot.pricingPlan = orderInfo.pricingPlanId;
      } else {
        cycle.planSnapshot.pricingPlan = null;
      }

      cycle.coverage.status = "covered";
      cycle.coverage.baseSessions = EXPECTED_CREDITS;
      cycle.coverage.extraSessionsSelected = 0;
      cycle.coverage.totalSessions = EXPECTED_CREDITS;
      cycle.coverage.fixedOccurrencesCount = 0;
      cycle.coverage.blockedOccurrencesCount = 0;
      cycle.coverage.coveredFixedOccurrences = 0;
      cycle.coverage.uncoveredFixedOccurrences = 0;
      cycle.coverage.extraSessionsNeeded = 0;
      cycle.coverage.additionalSessionsStillNeeded = 0;
      cycle.coverage.freeSessions = EXPECTED_CREDITS;
      cycle.coverage.calculatedAt = now;

      cycle.billing.status = "paid";
      cycle.billing.amountBase = EXPECTED_AMOUNT;
      cycle.billing.amountExtras = 0;
      cycle.billing.amountAddOns = 0;
      cycle.billing.total = EXPECTED_AMOUNT;
      cycle.billing.amountReceived = EXPECTED_AMOUNT;
      cycle.billing.amountPaid = EXPECTED_AMOUNT;
      cycle.billing.balanceDue = 0;
      cycle.billing.overpaidAmount = 0;
      cycle.billing.paidAt = order.paidAt || now;
      cycle.billing.overdueAt = null;
      cycle.billing.cancelledAt = null;
      cycle.billing.writtenOffAt = null;
      cycle.billing.order = order._id;
      cycle.billing.paymentProvider = clean(order.payMethod);
      cycle.billing.paymentId = clean(order.mpPaymentId);
      cycle.billing.payments = [
        {
          order: order._id,
          amount: EXPECTED_AMOUNT,
          appliedAmount: EXPECTED_AMOUNT,
          excessAmount: 0,
          paidAt: order.paidAt || now,
          paymentProvider: clean(order.payMethod),
          paymentId: clean(order.mpPaymentId),
          note:
            "Reconciliación histórica Tais: Order paga 8 sesiones, sin turnos fijos vigentes en septiembre.",
        },
      ];

      cycle.lifecycle.planStatus = "active";
      cycle.lifecycle.suspendedAt = null;
      cycle.lifecycle.terminatedAt = null;
      cycle.lifecycle.terminationReason = "";

      cycle.creditGrant.granted = true;
      cycle.creditGrant.grantedSessions = EXPECTED_CREDITS;
      cycle.creditGrant.grantedAt =
        cycle.creditGrant.grantedAt || order.paidAt || now;
      cycle.creditGrant.lotId = orderLot._id;
      cycle.creditGrant.expiresAt = orderLot.expiresAt || null;
      cycle.creditGrant.invalidatedAt = null;
      cycle.creditGrant.invalidationReason = "";

      await cycle.save({ session });

      // Preserva el plan recurrente actual; solo reactiva.
      subscription.status = "active";
      subscription.autoRenew = true;
      subscription.suspendedAt = null;
      subscription.suspensionReason = "";
      subscription.terminatedAt = null;
      subscription.terminationReason = "";
      subscription.fixedSlotsProtectedUntil = null;
      subscription.fixedScheduleIds = [];

      await subscription.save({ session });

      user.history = Array.isArray(user.history) ? user.history : [];
      user.history.push({
        action: "subscription_historical_paid_order_reconciled",
        title: "Pago histórico del plan reconciliado",
        message:
          "Se reconocieron 8 sesiones de septiembre. No se restauraron turnos fijos porque el único FixedSchedule histórico terminó el 12/08/2026.",
        serviceKey: SERVICE_KEY,
        service: "Entrenamiento Personal",
        serviceName: "Entrenamiento Personal",
        qty: EXPECTED_CREDITS,
        createdAt: now,
      });

      await user.save({ session });

      await SubscriptionLifecycleNotice.updateMany(
        {
          user: user._id,
          subscription: subscription._id,
          periodKey,
          type: { $in: ["suspended", "terminated"] },
        },
        {
          $set: {
            status: "resolved",
            resolvedAt: now,
          },
        },
        { session }
      );

      order.subscriptionCycleApplied = true;
      order.applied = true;
      await order.save({ session });

      output = {
        ok: true,
        email: EMAIL,
        orderId: String(order._id),
        subscriptionId: String(subscription._id),
        cycleId: String(cycle._id),
        sessionsPurchased: EXPECTED_CREDITS,
        freeSessions: EXPECTED_CREDITS,
        restoredFixedSchedules: 0,
        restoredAppointments: 0,
        orderLotId: String(orderLot._id),
        orderLotRemaining: Number(orderLot.remaining || 0),
        userCreditsAfter: Number(user.credits || 0),
      };
    });

    return output;
  } finally {
    await session.endSession();
  }
}

async function main() {
  const { periodKey, apply } = parseArgs();

  if (!process.env.MONGO_URI) {
    throw new Error("Falta MONGO_URI en .env");
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    console.log("\n" + "=".repeat(112));
    console.log(
      `TAIS · SEPTIEMBRE SIN FIJO VIGENTE · ${periodKey} · ${
        apply ? "APPLY" : "DRY RUN"
      }`
    );
    console.log("=".repeat(112));

    const state = await inspect(periodKey);

    console.log(
      `Order: $${state.orderAmount} / ${state.orderInfo.credits} sesiones`
    );
    console.log(
      `Subscription: status=${state.subscription.status} ` +
        `plan=${asInt(state.subscription.monthlySessions)} / $${money(
          state.subscription.price
        )}`
    );
    console.log(
      `Cycle: billing=${state.cycle.billing?.status} ` +
        `lifecycle=${state.cycle.lifecycle?.planStatus} ` +
        `total=$${money(state.cycle.billing?.total)} ` +
        `received=$${money(state.cycle.billing?.amountReceived)}`
    );

    for (const schedule of state.schedules) {
      console.log(
        `FixedSchedule ${String(schedule._id)} ` +
          `active=${schedule.active ? "SI" : "NO"} ` +
          `start=${schedule.startDate || "-"} end=${schedule.endDate || "-"} ` +
          `items=${(schedule.items || [])
            .map((item) => `${item.weekday}@${clean(item.time).slice(0, 5)}`)
            .join(",")}`
      );
    }

    console.log(
      `Future fixed appointments: ${state.futureFixed.length}`
    );
    console.log(
      `Order lot: amount=${asInt(state.orderLot.amount)} ` +
        `remaining=${asInt(state.orderLot.remaining)} linked=${state.linkedOrder}`
    );
    console.log(
      `Cycle lot: ${
        state.cycleLot
          ? `amount=${asInt(state.cycleLot.amount)} remaining=${asInt(
              state.cycleLot.remaining
            )} linked=${state.linkedCycle}`
          : "-"
      }`
    );

    if (state.alreadyRepaired) {
      console.log("\nYA REPARADO / IDEMPOTENTE.");
      return;
    }

    if (!state.ready) {
      console.log("\nPRECHECK FALLÓ. NO SE MODIFICÓ NADA.");
      for (const error of state.errors) {
        console.log(JSON.stringify(error));
      }
      process.exitCode = 2;
      return;
    }

    console.log(
      "\nPRECHECK OK: Tais puede quedar activa con 8 sesiones libres y SIN restaurar el FixedSchedule vencido."
    );

    if (!apply) {
      console.log("DRY RUN: NO SE MODIFICÓ NINGÚN DATO.");
      console.log(
        `Para aplicar: node scripts/repairTaisSeptemberNoFixed.js --period=${periodKey} --apply`
      );
      return;
    }

    const backup = await writeBackup(state, periodKey);
    console.log(`Backup: ${backup}`);

    const result = await applyRepair(periodKey);

    console.log("\nAPPLY OK");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error("\nREPAIR ERROR:", error?.stack || error?.message || error);

  if (error?.details) {
    for (const detail of error.details) {
      console.error(JSON.stringify(detail));
    }
  }

  try {
    await mongoose.disconnect();
  } catch {}

  process.exit(1);
});
