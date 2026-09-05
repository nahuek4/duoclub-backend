// DUO — Reparación individual Juliana Jesus García Bertoli
//
// DRY RUN (no escribe):
//   node scripts/repairJulianaFixedCredits.js
//
// APPLY explícito:
//   node scripts/repairJulianaFixedCredits.js --apply --confirm=JULIANA-2026-09
//
// Objetivo contable:
// - mover el turno NO fijo del 02/09 desde el lote mensual al crédito "refund";
// - liberar así 1 crédito del lote mensual;
// - reservar los 7 créditos mensuales restantes contra los 7 turnos fijos pendientes;
// - saldo libre final EP: 0;
// - el plan mensual de 8 queda cubriendo exactamente los 8 turnos fijos del mes.
//
// El script valida IDs, fuentes, saldos y estados exactos antes de escribir.
// Todo el APPLY corre dentro de una transacción MongoDB.

import "dotenv/config";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Appointment from "../src/models/Appointment.js";

const APPLY = process.argv.includes("--apply");
const CONFIRM = process.argv.find((arg) => arg.startsWith("--confirm="))?.split("=")[1] || "";
const REQUIRED_CONFIRM = "JULIANA-2026-09";

const USER_ID = "6a4d7e48055ae642c1219a3b";
const SERVICE_KEY = "EP";

const CYCLE_LOT_ID = "6a96456abeb2bba3d9ef62e4";
const CYCLE_SOURCE = "subscription_cycle:6a96456abeb2bba3d9ef62e3:2026-09";

const REFUND_LOT_ID = "6a96b28cbeb2bba3d9efd57e";
const REFUND_SOURCE = "refund";

const NON_FIXED_APPOINTMENT_ID = "6a96b2d8beb2bba3d9efd860";

const FIXED_PENDING_IDS = [
  "6a964614beb2bba3d9ef7637",
  "6a964615beb2bba3d9ef763c",
  "6a964615beb2bba3d9ef7641",
  "6a964615beb2bba3d9ef7646",
  "6a964615beb2bba3d9ef764b",
  "6a964615beb2bba3d9ef7650",
  "6a964615beb2bba3d9ef7655",
];

function clean(value) {
  return String(value ?? "").trim();
}

function idOf(value) {
  return clean(value?._id || value);
}

function recalcCredits(user, now = new Date()) {
  user.credits = (Array.isArray(user?.creditLots) ? user.creditLots : []).reduce(
    (sum, lot) => {
      const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
      if (exp && exp <= now) return sum;
      return sum + Math.max(0, Number(lot?.remaining || 0));
    },
    0
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function inspect(session = null) {
  const userQuery = User.findById(USER_ID)
    .select("name lastName email credits creditLots history");
  if (session) userQuery.session(session);
  const user = await userQuery;

  assert(user, "USER_NOT_FOUND");

  const cycleLot = user.creditLots?.find((lot) => idOf(lot?._id) === CYCLE_LOT_ID);
  const refundLot = user.creditLots?.find((lot) => idOf(lot?._id) === REFUND_LOT_ID);

  assert(cycleLot, "CYCLE_LOT_NOT_FOUND");
  assert(refundLot, "REFUND_LOT_NOT_FOUND");
  assert(clean(cycleLot.source) === CYCLE_SOURCE, "CYCLE_SOURCE_CHANGED");
  assert(clean(refundLot.source) === REFUND_SOURCE, "REFUND_SOURCE_CHANGED");
  assert(clean(cycleLot.serviceKey).toUpperCase() === SERVICE_KEY, "CYCLE_SERVICE_CHANGED");
  assert(clean(refundLot.serviceKey).toUpperCase() === SERVICE_KEY, "REFUND_SERVICE_CHANGED");

  const nonFixedQuery = Appointment.findById(NON_FIXED_APPOINTMENT_ID)
    .select("_id user serviceKey date time status fixedScheduleId creditLotId creditExpiresAt creditDebitStatus");
  if (session) nonFixedQuery.session(session);
  const nonFixed = await nonFixedQuery;

  assert(nonFixed, "NON_FIXED_APPOINTMENT_NOT_FOUND");
  assert(idOf(nonFixed.user) === USER_ID, "NON_FIXED_USER_CHANGED");
  assert(clean(nonFixed.serviceKey).toUpperCase() === SERVICE_KEY, "NON_FIXED_SERVICE_CHANGED");
  assert(!nonFixed.fixedScheduleId, "NON_FIXED_BECAME_FIXED");
  assert(clean(nonFixed.status).toLowerCase() === "reserved", "NON_FIXED_STATUS_CHANGED");

  const fixedQuery = Appointment.find({
    _id: { $in: FIXED_PENDING_IDS },
  })
    .select("_id user serviceKey date time status fixedScheduleId creditLotId creditExpiresAt creditDebitStatus fixedDebtAmount")
    .sort({ date: 1, time: 1 });
  if (session) fixedQuery.session(session);
  const fixed = await fixedQuery;

  assert(fixed.length === FIXED_PENDING_IDS.length, "FIXED_PENDING_COUNT_CHANGED");

  return { user, cycleLot, refundLot, nonFixed, fixed };
}

function validateBefore(state) {
  const { user, cycleLot, refundLot, nonFixed, fixed } = state;

  assert(Number(cycleLot.amount || 0) === 8, "CYCLE_AMOUNT_CHANGED");
  assert(Number(cycleLot.remaining || 0) === 6, "CYCLE_REMAINING_CHANGED");
  assert(Number(refundLot.amount || 0) === 1, "REFUND_AMOUNT_CHANGED");
  assert(Number(refundLot.remaining || 0) === 1, "REFUND_REMAINING_CHANGED");
  assert(Number(user.credits || 0) === 7, "USER_CREDITS_CHANGED");

  assert(idOf(nonFixed.creditLotId) === CYCLE_LOT_ID, "NON_FIXED_LOT_CHANGED");

  for (const ap of fixed) {
    assert(idOf(ap.user) === USER_ID, `FIXED_USER_CHANGED:${idOf(ap._id)}`);
    assert(clean(ap.serviceKey).toUpperCase() === SERVICE_KEY, `FIXED_SERVICE_CHANGED:${idOf(ap._id)}`);
    assert(!!ap.fixedScheduleId, `FIXED_SCHEDULE_MISSING:${idOf(ap._id)}`);
    assert(clean(ap.status).toLowerCase() === "reserved", `FIXED_STATUS_CHANGED:${idOf(ap._id)}`);
    assert(!ap.creditLotId, `FIXED_ALREADY_HAS_LOT:${idOf(ap._id)}`);
    assert(
      clean(ap.creditDebitStatus).toLowerCase() === "pending",
      `FIXED_NOT_PENDING:${idOf(ap._id)}`
    );
  }
}

function preview(state) {
  const { user, cycleLot, refundLot, nonFixed, fixed } = state;

  return {
    ok: true,
    mode: APPLY ? "APPLY_READY" : "DRY_RUN",
    writesToDatabase: false,
    user: {
      id: USER_ID,
      name: `${clean(user.name)} ${clean(user.lastName)}`.trim(),
      email: clean(user.email),
      creditsNow: Number(user.credits || 0),
      expectedCreditsAfter: 0,
    },
    cycleLot: {
      id: CYCLE_LOT_ID,
      source: CYCLE_SOURCE,
      remainingNow: Number(cycleLot.remaining || 0),
      afterReassignNonFixed: 7,
      afterReserveFixed: 0,
    },
    refundLot: {
      id: REFUND_LOT_ID,
      source: REFUND_SOURCE,
      remainingNow: Number(refundLot.remaining || 0),
      expectedRemainingAfter: 0,
    },
    reassignNonFixed: {
      appointmentId: idOf(nonFixed._id),
      date: nonFixed.date,
      time: nonFixed.time,
      fromLotId: CYCLE_LOT_ID,
      toLotId: REFUND_LOT_ID,
    },
    fixedToReserve: fixed.map((ap) => ({
      appointmentId: idOf(ap._id),
      date: ap.date,
      time: ap.time,
      lotId: CYCLE_LOT_ID,
    })),
    fixedCount: fixed.length,
  };
}

async function applyRepair() {
  const session = await mongoose.startSession();
  let result = null;

  try {
    await session.withTransaction(async () => {
      const state = await inspect(session);
      validateBefore(state);

      const { user, cycleLot, refundLot, nonFixed, fixed } = state;
      const now = new Date();

      // 1) El turno no fijo pasa a consumir el crédito refund.
      nonFixed.creditLotId = refundLot._id;
      nonFixed.creditExpiresAt = refundLot.expiresAt || null;
      await nonFixed.save({ session });

      // El movimiento entre lotes no cambia el total disponible:
      // devolvemos 1 al lote mensual y consumimos 1 del refund.
      cycleLot.remaining = 7;
      refundLot.remaining = 0;

      // 2) Los 7 turnos fijos pendientes quedan reservados contra el lote mensual.
      for (const ap of fixed) {
        ap.creditLotId = cycleLot._id;
        ap.creditExpiresAt = cycleLot.expiresAt || null;
        ap.creditDebitStatus = "monthly_reserved";
        ap.creditDebitedAt = now;
        ap.fixedDebtAmount = 0;
        await ap.save({ session });
      }

      cycleLot.remaining = 0;

      user.markModified?.("creditLots");
      user.history = Array.isArray(user.history) ? user.history : [];
      user.history.push({
        action: "subscription_fixed_credits_individual_repair",
        title: "Corrección de créditos de turnos fijos EP",
        message:
          "Se reasignó 1 turno no fijo al crédito refund y se reservaron los 7 créditos restantes del ciclo 2026-09 para los 7 turnos fijos pendientes.",
        serviceKey: SERVICE_KEY,
        serviceName: "Entrenamiento Personal",
        service: "Entrenamiento Personal",
        qty: -7,
        createdAt: now,
      });

      recalcCredits(user, now);
      assert(Number(user.credits || 0) === 0, "EXPECTED_FINAL_CREDITS_NOT_ZERO");

      await user.save({ session });

      result = {
        ok: true,
        mode: "APPLY",
        userId: USER_ID,
        nonFixedReassignedToRefund: idOf(nonFixed._id),
        fixedReservedWithCycleLot: fixed.map((ap) => idOf(ap._id)),
        cycleRemainingAfter: Number(cycleLot.remaining || 0),
        refundRemainingAfter: Number(refundLot.remaining || 0),
        userCreditsAfter: Number(user.credits || 0),
      };
    });
  } finally {
    await session.endSession();
  }

  return result;
}

async function verifyAfter() {
  const user = await User.findById(USER_ID)
    .select("credits creditLots")
    .lean();

  const appointments = await Appointment.find({
    _id: { $in: [NON_FIXED_APPOINTMENT_ID, ...FIXED_PENDING_IDS] },
  })
    .select("_id date time fixedScheduleId creditLotId creditDebitStatus")
    .sort({ date: 1, time: 1 })
    .lean();

  const cycleLot = user?.creditLots?.find((lot) => idOf(lot?._id) === CYCLE_LOT_ID);
  const refundLot = user?.creditLots?.find((lot) => idOf(lot?._id) === REFUND_LOT_ID);
  const nonFixed = appointments.find((ap) => idOf(ap._id) === NON_FIXED_APPOINTMENT_ID);
  const fixed = appointments.filter((ap) => FIXED_PENDING_IDS.includes(idOf(ap._id)));

  return {
    userCredits: Number(user?.credits || 0),
    cycleRemaining: Number(cycleLot?.remaining || 0),
    refundRemaining: Number(refundLot?.remaining || 0),
    nonFixedUsesRefund: idOf(nonFixed?.creditLotId) === REFUND_LOT_ID,
    fixedAllUseCycle: fixed.length === 7 && fixed.every(
      (ap) =>
        idOf(ap.creditLotId) === CYCLE_LOT_ID &&
        clean(ap.creditDebitStatus).toLowerCase() === "monthly_reserved"
    ),
  };
}

async function main() {
  assert(clean(process.env.MONGO_URI), "MISSING_MONGO_URI");

  if (APPLY) {
    assert(CONFIRM === REQUIRED_CONFIRM, `CONFIRM_REQUIRED:${REQUIRED_CONFIRM}`);
  }

  await mongoose.connect(process.env.MONGO_URI);

  if (!APPLY) {
    const state = await inspect();
    validateBefore(state);
    console.log(JSON.stringify(preview(state), null, 2));
    return;
  }

  const applied = await applyRepair();
  const verification = await verifyAfter();

  assert(verification.userCredits === 0, "VERIFY_USER_CREDITS_FAILED");
  assert(verification.cycleRemaining === 0, "VERIFY_CYCLE_REMAINING_FAILED");
  assert(verification.refundRemaining === 0, "VERIFY_REFUND_REMAINING_FAILED");
  assert(verification.nonFixedUsesRefund, "VERIFY_NON_FIXED_REFUND_FAILED");
  assert(verification.fixedAllUseCycle, "VERIFY_FIXED_CYCLE_FAILED");

  console.log(JSON.stringify({
    ...applied,
    verification,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      mode: APPLY ? "APPLY" : "DRY_RUN",
      error: error?.message || String(error),
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
