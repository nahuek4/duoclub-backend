// scripts/repairTwoDuplicateFixedAppointmentsV1.js
//
// DUO CLUB — reparación específica de 2 appointments fijos duplicados.
// DRY RUN por defecto.
//
// Casos:
// 1) m.gabrielag@live.com.ar · 2026-09-02 09:00
// 2) rosanguinetti@hotmail.com · 2026-09-02 14:00
//
// Regla:
// - se conserva el appointment creado primero;
// - el segundo appointment del MISMO user + fecha + hora + fixedSchedule
//   queda CANCELLED + refundApplied + skipped, sin creditLotId;
// - no se borra ningún turno;
// - el lote Order queda canónico;
// - el lote mensual duplicado queda remaining=0;
// - cycle.creditGrant apunta al lote Order;
// - coverage queda reconciliada.
//
// NO toca billing, precios, subscription status, lifecycle ni FixedSchedule.

import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Order from "../src/models/Order.js";
import Appointment from "../src/models/Appointment.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";

const TARGETS = [
  {
    email: "m.gabrielag@live.com.ar",
    serviceKey: "EP",
    periodKey: "2026-09",
    sessionsPaid: 8,
    orderId: "6a97f1f477ad6f1af0e4a86c",
    orderLotId: "6a97f1f477ad6f1af0e4a875",
    canonicalAppointmentId: "6a9645dbbeb2bba3d9ef6f10",
    duplicateAppointmentId: "6a97f20d77ad6f1af0e4aa36",
    date: "2026-09-02",
    time: "09:00",
  },
  {
    email: "rosanguinetti@hotmail.com",
    serviceKey: "EP",
    periodKey: "2026-09",
    sessionsPaid: 12,
    orderId: "6a97f34877ad6f1af0e4b1bc",
    orderLotId: "6a97f34877ad6f1af0e4b1c7",
    canonicalAppointmentId: "6a96459cbeb2bba3d9ef67ae",
    duplicateAppointmentId: "6a97f36977ad6f1af0e4b400",
    date: "2026-09-02",
    time: "14:00",
  },
];

function clean(v) {
  return String(v ?? "").trim();
}

function idOf(v) {
  return clean(v?._id || v?.id || v);
}

function asInt(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function parseArgs() {
  let apply = false;
  let only = "";

  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") apply = true;
    if (arg.startsWith("--only=")) {
      only = clean(arg.slice("--only=".length)).toLowerCase();
    }
  }

  return { apply, only };
}

function isLifecycleCancellation(ap) {
  return (
    clean(ap?.status).toLowerCase() === "cancelled" &&
    /falta de pago|plan mensual/i.test(clean(ap?.cancelReason))
  );
}

function consumesSession(ap) {
  const status = clean(ap?.status).toLowerCase();

  if (status === "reserved" || status === "completed") return true;

  return (
    status === "cancelled" &&
    ap?.refundApplied !== true &&
    !isLifecycleCancellation(ap)
  );
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

async function inspectTarget(target, session = null) {
  const userQ = User.findOne({ email: target.email });
  if (session) userQ.session(session);
  const user = await userQ;

  const errors = [];
  if (!user) return { target, errors: ["USER_NOT_FOUND"], ready: false };

  const subscriptionQ = ServiceSubscription.findOne({
    user: user._id,
    serviceKey: target.serviceKey,
  });
  if (session) subscriptionQ.session(session);

  const cycleQ = SubscriptionBillingCycle.findOne({
    user: user._id,
    serviceKey: target.serviceKey,
    periodKey: target.periodKey,
  });
  if (session) cycleQ.session(session);

  const orderQ = Order.findById(target.orderId);
  if (session) orderQ.session(session);

  const canonicalQ = Appointment.findById(target.canonicalAppointmentId);
  const duplicateQ = Appointment.findById(target.duplicateAppointmentId);
  if (session) {
    canonicalQ.session(session);
    duplicateQ.session(session);
  }

  const [subscription, cycle, order, canonical, duplicate] =
    await Promise.all([
      subscriptionQ,
      cycleQ,
      orderQ,
      canonicalQ,
      duplicateQ,
    ]);

  if (!subscription) errors.push("SUBSCRIPTION_NOT_FOUND");
  if (!cycle) errors.push("CYCLE_NOT_FOUND");
  if (!order) errors.push("ORDER_NOT_FOUND");
  if (!canonical) errors.push("CANONICAL_APPOINTMENT_NOT_FOUND");
  if (!duplicate) errors.push("DUPLICATE_APPOINTMENT_NOT_FOUND");

  if (errors.length) {
    return {
      target, user, subscription, cycle, order, canonical, duplicate,
      errors, ready: false,
    };
  }

  if (subscription.status !== "active") {
    errors.push(`SUBSCRIPTION_NOT_ACTIVE:${subscription.status}`);
  }

  if (cycle.lifecycle?.planStatus !== "active") {
    errors.push(`CYCLE_NOT_ACTIVE:${cycle.lifecycle?.planStatus}`);
  }

  if (!["paid", "approved"].includes(clean(order.status).toLowerCase())) {
    errors.push(`ORDER_NOT_PAID:${order.status}`);
  }

  if (String(order.user) !== String(user._id)) {
    errors.push("ORDER_USER_MISMATCH");
  }

  for (const [label, ap] of [["CANONICAL", canonical], ["DUPLICATE", duplicate]]) {
    if (String(ap.user) !== String(user._id)) errors.push(`${label}_USER_MISMATCH`);
    if (clean(ap.serviceKey).toUpperCase() !== target.serviceKey) {
      errors.push(`${label}_SERVICE_MISMATCH:${ap.serviceKey}`);
    }
    if (clean(ap.date).slice(0, 10) !== target.date) {
      errors.push(`${label}_DATE_MISMATCH:${ap.date}`);
    }
    if (clean(ap.time).slice(0, 5) !== target.time) {
      errors.push(`${label}_TIME_MISMATCH:${ap.time}`);
    }
    if (!ap.fixedScheduleId) errors.push(`${label}_NOT_FIXED`);
  }

  if (
    canonical.fixedScheduleId &&
    duplicate.fixedScheduleId &&
    String(canonical.fixedScheduleId) !== String(duplicate.fixedScheduleId)
  ) {
    errors.push("FIXED_SCHEDULE_MISMATCH");
  }

  const canonicalCreated = canonical.createdAt ? new Date(canonical.createdAt).getTime() : 0;
  const duplicateCreated = duplicate.createdAt ? new Date(duplicate.createdAt).getTime() : 0;
  if (canonicalCreated && duplicateCreated && duplicateCreated <= canonicalCreated) {
    errors.push("EXPECTED_DUPLICATE_TO_BE_CREATED_LATER");
  }

  const orderLot =
    user.creditLots?.id?.(target.orderLotId) ||
    (user.creditLots || []).find((lot) => idOf(lot) === target.orderLotId);

  if (!orderLot) {
    errors.push("ORDER_LOT_NOT_FOUND");
  } else {
    if (idOf(orderLot.orderId) !== target.orderId) {
      errors.push(`ORDER_LOT_ORDER_MISMATCH:${idOf(orderLot.orderId)}`);
    }
    if (asInt(orderLot.amount) !== target.sessionsPaid) {
      errors.push(`ORDER_LOT_AMOUNT_MISMATCH:${asInt(orderLot.amount)}!=${target.sessionsPaid}`);
    }
  }

  const cyclePrefix = `subscription_cycle:${String(cycle._id)}:${target.periodKey}`;
  const cycleLots = (user.creditLots || []).filter((lot) => {
    const source = clean(lot?.source);
    return (
      clean(lot?.serviceKey).toUpperCase() === target.serviceKey &&
      (source === cyclePrefix ||
        source.startsWith(`subscription_cycle:${String(cycle._id)}:`))
    );
  });

  if (!cycleLots.length) errors.push("CYCLE_SOURCE_LOT_NOT_FOUND");

  const relevantLotIds = Array.from(
    new Set(
      [target.orderLotId, ...cycleLots.map(idOf)]
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    )
  );

  const apsQ = Appointment.find({
    user: user._id,
    serviceKey: target.serviceKey,
    creditLotId: { $in: relevantLotIds },
  }).sort({ date: 1, time: 1, createdAt: 1 });
  if (session) apsQ.session(session);
  const relevantAppointments = await apsQ;

  const consumingBefore = relevantAppointments.filter(consumesSession);
  const sameSlot = consumingBefore.filter(
    (ap) =>
      clean(ap.date).slice(0, 10) === target.date &&
      clean(ap.time).slice(0, 5) === target.time
  );

  const alreadyRepaired =
    duplicate.status === "cancelled" &&
    duplicate.refundApplied === true &&
    duplicate.creditDebitStatus === "skipped" &&
    !duplicate.creditLotId &&
    cycle.creditGrant?.lotId &&
    String(cycle.creditGrant.lotId) === target.orderLotId &&
    orderLot &&
    asInt(orderLot.remaining) === 0 &&
    cycleLots.every((lot) => asInt(lot.remaining) === 0);

  if (!alreadyRepaired) {
    if (sameSlot.length !== 2) {
      errors.push(`EXPECTED_TWO_CONSUMING_AT_SLOT:${sameSlot.length}`);
    } else {
      const actual = sameSlot.map((ap) => String(ap._id)).sort();
      const expected = [
        target.canonicalAppointmentId,
        target.duplicateAppointmentId,
      ].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        errors.push("SAME_SLOT_IDS_CHANGED");
      }
    }

    if (consumingBefore.length !== target.sessionsPaid + 1) {
      errors.push(
        `EXPECTED_OVERCONSUMPTION_BY_ONE:${consumingBefore.length}!=${target.sessionsPaid + 1}`
      );
    }
  }

  return {
    target, user, subscription, cycle, order, canonical, duplicate,
    orderLot, cycleLots, relevantAppointments, consumingBefore,
    sameSlot, errors, alreadyRepaired,
    ready: !alreadyRepaired && errors.length === 0,
  };
}

function printState(state) {
  console.log(`\n${state.target.email}`);
  console.log(`  ${state.target.date} ${state.target.time} · pagadas=${state.target.sessionsPaid}`);

  if (state.canonical) {
    console.log(
      `  CONSERVAR ${state.canonical._id}: status=${state.canonical.status} createdAt=${state.canonical.createdAt}`
    );
  }

  if (state.duplicate) {
    console.log(
      `  DUPLICADO ${state.duplicate._id}: status=${state.duplicate.status} createdAt=${state.duplicate.createdAt}`
    );
  }

  if (state.orderLot) {
    console.log(
      `  Order lot ${idOf(state.orderLot)}: amount=${asInt(state.orderLot.amount)} remaining=${asInt(state.orderLot.remaining)}`
    );
  }

  for (const lot of state.cycleLots || []) {
    console.log(
      `  Cycle-source lot ${idOf(lot)}: amount=${asInt(lot.amount)} remaining=${asInt(lot.remaining)}`
    );
  }

  console.log(
    `  consumos actuales=${state.consumingBefore?.length || 0} => después=${state.target.sessionsPaid}`
  );

  if (state.alreadyRepaired) console.log("  ESTADO: YA REPARADO / IDEMPOTENTE");
  else console.log(`  READY=${state.ready ? "SI" : "NO"}`);

  for (const error of state.errors || []) console.log(`    ERROR ${error}`);
}

function ensureBackupDir() {
  const dir = path.resolve(process.cwd(), "backups", "subscription-repairs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function serializable(doc) {
  return doc?.toObject ? doc.toObject({ depopulate: true }) : doc;
}

async function applyTarget(target) {
  const session = await mongoose.startSession();
  let result = null;

  try {
    await session.withTransaction(async () => {
      const state = await inspectTarget(target, session);

      if (state.alreadyRepaired) {
        result = { ok: true, skipped: true, email: target.email, reason: "ALREADY_REPAIRED" };
        return;
      }

      if (!state.ready) {
        const error = new Error("PRECHECK_FAILED_DURING_APPLY");
        error.details = state.errors;
        throw error;
      }

      const {
        user, cycle, duplicate, orderLot, cycleLots, relevantAppointments,
      } = state;

      const now = new Date();

      const validAppointments = relevantAppointments.filter(
        (ap) =>
          String(ap._id) !== target.duplicateAppointmentId &&
          consumesSession(ap)
      );

      for (const ap of validAppointments) {
        ap.creditLotId = orderLot._id;
        ap.creditExpiresAt = orderLot.expiresAt || null;
        await ap.save({ session });
      }

      duplicate.status = "cancelled";
      duplicate.cancelledAt = now;
      duplicate.cancelReason =
        "Duplicado histórico reparado: mismo turno fijo ya materializado.";
      duplicate.refundApplied = true;
      duplicate.refundMode = "duplicate_repair";
      duplicate.refundReason =
        "Appointment duplicado del mismo usuario, fecha, hora y FixedSchedule. No consume sesión.";
      duplicate.creditLotId = null;
      duplicate.creditExpiresAt = null;
      duplicate.creditDebitStatus = "skipped";
      duplicate.creditDebitedAt = null;
      duplicate.fixedDebitProcessedAt = now;
      duplicate.fixedDebtAmount = 0;
      await duplicate.save({ session });

      orderLot.amount = target.sessionsPaid;
      orderLot.remaining = 0;

      for (const lot of cycleLots) {
        if (idOf(lot) !== idOf(orderLot)) lot.remaining = 0;
      }

      cycle.creditGrant.granted = true;
      cycle.creditGrant.grantedSessions = target.sessionsPaid;
      cycle.creditGrant.lotId = orderLot._id;
      cycle.creditGrant.expiresAt = orderLot.expiresAt || null;
      cycle.creditGrant.invalidatedAt = null;
      cycle.creditGrant.invalidationReason = "";

      const validFixed = validAppointments.filter((ap) => !!ap.fixedScheduleId).length;

      cycle.coverage.status = "covered";
      cycle.coverage.baseSessions = target.sessionsPaid;
      cycle.coverage.extraSessionsSelected = 0;
      cycle.coverage.totalSessions = target.sessionsPaid;
      cycle.coverage.fixedOccurrencesCount = validFixed;
      cycle.coverage.coveredFixedOccurrences = Math.min(validFixed, target.sessionsPaid);
      cycle.coverage.uncoveredFixedOccurrences = Math.max(0, validFixed - target.sessionsPaid);
      cycle.coverage.extraSessionsNeeded = Math.max(0, validFixed - target.sessionsPaid);
      cycle.coverage.additionalSessionsStillNeeded = 0;
      cycle.coverage.freeSessions = Math.max(0, target.sessionsPaid - validFixed);
      cycle.coverage.calculatedAt = now;

      await cycle.save({ session });

      recalcUserCredits(user, now);

      user.history = Array.isArray(user.history) ? user.history : [];
      user.history.push({
        action: "duplicate_fixed_appointment_reconciled",
        title: "Turno fijo duplicado reconciliado",
        message:
          `Se neutralizó el appointment duplicado ${target.duplicateAppointmentId} ` +
          `del ${target.date} ${target.time}. Se conservó ${target.canonicalAppointmentId}.`,
        serviceKey: target.serviceKey,
        service: "Entrenamiento Personal",
        serviceName: "Entrenamiento Personal",
        qty: 1,
        createdAt: now,
      });
      await user.save({ session });

      result = {
        ok: true,
        skipped: false,
        email: target.email,
        canonicalAppointmentId: target.canonicalAppointmentId,
        duplicateAppointmentId: target.duplicateAppointmentId,
        sessionsPaid: target.sessionsPaid,
        validConsumptionsAfter: validAppointments.length,
        canonicalLotId: idOf(orderLot),
        orderLotRemaining: Number(orderLot.remaining || 0),
        userCreditsAfter: Number(user.credits || 0),
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
}

async function main() {
  const { apply, only } = parseArgs();

  if (!process.env.MONGO_URI) throw new Error("Falta MONGO_URI en .env");

  await mongoose.connect(process.env.MONGO_URI);

  try {
    console.log("\n" + "=".repeat(120));
    console.log(`REPARAR 2 TURNOS FIJOS DUPLICADOS · ${apply ? "APPLY" : "DRY RUN"}`);
    console.log("=".repeat(120));

    const targets = only ? TARGETS.filter((t) => t.email === only) : TARGETS;
    const states = [];

    for (const target of targets) {
      const state = await inspectTarget(target);
      states.push(state);
      printState(state);
    }

    const ready = states.filter((s) => s.ready);
    const already = states.filter((s) => s.alreadyRepaired);
    const blocked = states.filter((s) => !s.ready && !s.alreadyRepaired);

    console.log("\n" + "-".repeat(120));
    console.log({
      targets: states.length,
      ready: ready.length,
      alreadyRepaired: already.length,
      blocked: blocked.length,
      duplicateAppointmentsToNeutralize: ready.length,
    });

    if (!apply) {
      console.log("\nDRY RUN: NO SE MODIFICÓ NINGÚN DATO.");
      if (ready.length && !blocked.length) {
        console.log("Para aplicar: node scripts/repairTwoDuplicateFixedAppointmentsV1.js --apply");
      }
      return;
    }

    if (blocked.length) {
      throw new Error(`HAY_${blocked.length}_CASOS_BLOQUEADOS_NO_SE_APLICA_NADA`);
    }

    if (!ready.length) {
      console.log("\nNo hay casos pendientes de reparación.");
      return;
    }

    const dir = ensureBackupDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");

    const backupPath = path.join(
      dir,
      `before-repair-two-duplicate-fixed-${stamp}.json`
    );

    fs.writeFileSync(
      backupPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          states: ready.map((state) => ({
            target: state.target,
            user: serializable(state.user),
            subscription: serializable(state.subscription),
            cycle: serializable(state.cycle),
            order: serializable(state.order),
            canonical: serializable(state.canonical),
            duplicate: serializable(state.duplicate),
            relevantAppointments: state.relevantAppointments.map(serializable),
          })),
        },
        null,
        2
      )
    );

    console.log(`\nBackup: ${backupPath}`);

    const results = [];

    for (const state of ready) {
      try {
        const result = await applyTarget(state.target);
        results.push(result);
        console.log(
          `OK ${result.email}: conservado=${result.canonicalAppointmentId} neutralizado=${result.duplicateAppointmentId}`
        );
      } catch (error) {
        results.push({
          ok: false,
          email: state.target.email,
          error: error?.message || String(error),
          details: error?.details || [],
        });
        console.error(`ERROR ${state.target.email}: ${error?.message || error}`);
      }
    }

    const resultPath = path.join(
      dir,
      `repair-two-duplicate-fixed-result-${stamp}.json`
    );

    fs.writeFileSync(
      resultPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          backupPath,
          results,
        },
        null,
        2
      )
    );

    console.log("\n" + "=".repeat(120));
    console.log("REPARACIÓN TERMINADA");
    console.log(`OK: ${results.filter((r) => r.ok).length}`);
    console.log(`ERROR: ${results.filter((r) => !r.ok).length}`);
    console.log(`Resultado: ${resultPath}`);
    console.log("=".repeat(120));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error("\nREPAIR ERROR:", error?.stack || error?.message || error);
  if (error?.details) {
    for (const detail of error.details) console.error(JSON.stringify(detail));
  }
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
