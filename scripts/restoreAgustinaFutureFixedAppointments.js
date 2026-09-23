// scripts/restoreAgustinaFutureFixedAppointments.js
// DRY RUN por defecto. --apply para escribir.
// Repara SOLO los appointments futuros de Agustina Burs que quedaron cancelados
// por el lifecycle de falta de pago, siempre que:
// - la suscripción y el ciclo ya estén activos;
// - el FixedSchedule actual esté activo;
// - los appointments sigan siendo exactamente los mismos documentos;
// - no haya otro turno del usuario en el mismo horario;
// - no exista ScheduleBlock vigente;
// - la capacidad ACTUAL permita recuperar TODOS los turnos.
//
// También recalcula el lote mensual del ciclo después de restaurar, porque la
// reparación de la cuenta había devuelto esos turnos cancelados al saldo del lote.
//
// Uso:
//   node scripts/restoreAgustinaFutureFixedAppointments.js --period=2026-09
//   node scripts/restoreAgustinaFutureFixedAppointments.js --period=2026-09 --apply

import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import FixedSchedule from "../src/models/FixedSchedule.js";
import Appointment from "../src/models/Appointment.js";
import CapacityRule from "../src/models/CapacityRule.js";
import ScheduleBlock from "../src/models/ScheduleBlock.js";

const EMAIL = "agustinaburs95@gmail.com";
const SERVICE_KEY = "EP";
const EXPECTED_TOTAL = 95000;
const EXPECTED_RECEIVED = 90000;
const TZ = "America/Argentina/Buenos_Aires";

const DEFAULT_ZONE_CAPS = Object.freeze({
  TRAINING: 11,
  PERFORMANCE: 6,
});

const CAPACITY_SCOPE_PRIORITY = Object.freeze({
  default: 0,
  month: 1,
  date: 2,
  slot: 3,
});

function clean(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function idOf(value) {
  return clean(value?._id || value?.id || value);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? clean(found.slice(prefix.length)) : fallback;
}

function ymdAR(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function weekdayMondayFirst(dateStr) {
  const dt = new Date(`${dateStr}T12:00:00-03:00`);
  const js = dt.getDay(); // 0 dom, 1 lun...
  return js === 0 ? 7 : js;
}

function schedulePatternHasSlot(schedule, date, time) {
  const weekday = weekdayMondayFirst(date);
  const t = clean(time).slice(0, 5);

  return (Array.isArray(schedule?.items) ? schedule.items : []).some(
    (item) =>
      Number(item?.weekday || 0) === weekday &&
      clean(item?.time).slice(0, 5) === t
  );
}

function capacityRuleMatchesSlot(rule, dateStr, time) {
  if (!rule || rule.active === false) return false;

  const scope = clean(rule.scope || "default").toLowerCase();
  const day = clean(dateStr).slice(0, 10);
  const monthKey = day.slice(0, 7);
  const t = clean(time).slice(0, 5);

  if (scope === "default") return true;
  if (scope === "month") return clean(rule.monthKey) === monthKey;
  if (scope === "date") return clean(rule.date).slice(0, 10) === day;
  if (scope === "slot") {
    return (
      clean(rule.date).slice(0, 10) === day &&
      clean(rule.time).slice(0, 5) === t
    );
  }

  return false;
}

function pickCapacityRule(rules, predicate, dateStr, time) {
  return (Array.isArray(rules) ? rules : [])
    .filter((rule) => capacityRuleMatchesSlot(rule, dateStr, time))
    .filter((rule) => predicate(rule))
    .sort((a, b) => {
      const ap =
        CAPACITY_SCOPE_PRIORITY[clean(a?.scope || "default").toLowerCase()] ?? -1;
      const bp =
        CAPACITY_SCOPE_PRIORITY[clean(b?.scope || "default").toLowerCase()] ?? -1;

      if (ap !== bp) return bp - ap;

      const au = a?.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bu = b?.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bu - au;
    })[0] || null;
}

function resolveEpCapacity(rules, date, time) {
  const zoneRule = pickCapacityRule(
    rules,
    (item) =>
      clean(item?.targetType).toLowerCase() === "zone" &&
      clean(item?.zone).toUpperCase() === "TRAINING",
    date,
    time
  );

  const serviceRule = pickCapacityRule(
    rules,
    (item) =>
      clean(item?.targetType).toLowerCase() === "service" &&
      clean(item?.serviceKey).toUpperCase() === "EP",
    date,
    time
  );

  const zoneLimit = zoneRule
    ? Math.max(0, Number(zoneRule.limit || 0))
    : DEFAULT_ZONE_CAPS.TRAINING;

  const serviceLimit = serviceRule
    ? Math.max(0, Number(serviceRule.limit || 0))
    : null;

  return {
    zoneLimit,
    serviceLimit,
    effectiveLimit:
      serviceLimit === null ? zoneLimit : Math.min(zoneLimit, serviceLimit),
    zoneRuleId: idOf(zoneRule),
    serviceRuleId: idOf(serviceRule),
  };
}

function timeInsideBlock(block, time) {
  if (!block) return false;
  if (block.allDay) return true;

  const t = clean(time).slice(0, 5);
  const from = clean(block.timeFrom).slice(0, 5);
  const to = clean(block.timeTo).slice(0, 5);

  if (!from || !to) return true;
  return t >= from && t < to;
}

function dateMatchesBlock(block, date) {
  const day = clean(date).slice(0, 10);
  if (!day || !block?.dateFrom) return false;

  if (day < clean(block.dateFrom).slice(0, 10)) return false;

  if (!block.indefinite) {
    const to = clean(block.dateTo || block.dateFrom).slice(0, 10);
    if (to && day > to) return false;
  }

  const weekdays = Array.isArray(block.weekdays)
    ? block.weekdays.map(Number)
    : [];

  if (weekdays.length && !weekdays.includes(weekdayMondayFirst(day))) {
    return false;
  }

  return true;
}

async function findActiveBlock({ date, time, session = null }) {
  const query = ScheduleBlock.find({
    active: true,
    dateFrom: { $lte: date },
    $and: [
      {
        $or: [{ serviceKeys: SERVICE_KEY }, { allServices: true }],
      },
      {
        $or: [
          { indefinite: true },
          { dateTo: { $gte: date } },
          { dateTo: "" },
          { dateTo: { $exists: false } },
        ],
      },
    ],
  }).sort({ createdAt: -1 });

  if (session) query.session(session);
  const candidates = await query.lean();

  return (
    candidates.find(
      (block) =>
        dateMatchesBlock(block, date) &&
        timeInsideBlock(block, time)
    ) || null
  );
}

function isLifecycleCancellation(ap) {
  return (
    clean(ap?.status).toLowerCase() === "cancelled" &&
    /falta de pago|plan mensual/i.test(clean(ap?.cancelReason))
  );
}

function recalcUserCredits(user, now = new Date()) {
  user.credits = (Array.isArray(user?.creditLots) ? user.creditLots : []).reduce(
    (sum, lot) => {
      const expiresAt = lot?.expiresAt ? new Date(lot.expiresAt) : null;
      if (expiresAt && expiresAt <= now) return sum;
      return sum + Math.max(0, Number(lot?.remaining || 0));
    },
    0
  );
}

async function recalcCycleLot({ user, cycle, session, now }) {
  const lotId = cycle?.creditGrant?.lotId;
  if (!lotId) {
    return { skipped: true, reason: "NO_CYCLE_LOT" };
  }

  const lot = user.creditLots?.id?.(lotId);
  if (!lot) {
    throw new Error(`CYCLE_CREDIT_LOT_NOT_FOUND:${String(lotId)}`);
  }

  const linkedAppointments = await Appointment.find({
    user: user._id,
    creditLotId: lot._id,
  }).session(session);

  let consumed = 0;

  for (const ap of linkedAppointments) {
    const status = clean(ap.status).toLowerCase();

    if (status === "reserved" || status === "completed") {
      consumed += 1;
      continue;
    }

    if (
      status === "cancelled" &&
      ap.refundApplied !== true &&
      !isLifecycleCancellation(ap)
    ) {
      consumed += 1;
    }
  }

  const amount = Math.max(
    0,
    Number(lot.amount || cycle.creditGrant?.grantedSessions || 0)
  );

  lot.remaining = Math.max(0, amount - consumed);

  cycle.creditGrant.invalidatedAt = null;
  cycle.creditGrant.invalidationReason = "";

  recalcUserCredits(user, now);

  return {
    lotId: String(lot._id),
    amount,
    consumed,
    remaining: Number(lot.remaining || 0),
  };
}

async function loadState({ periodKey, session = null }) {
  const userQuery = User.findOne({ email: EMAIL });
  if (session) userQuery.session(session);
  const user = await userQuery;
  if (!user) throw new Error("USER_NOT_FOUND");

  const subscriptionQuery = ServiceSubscription.findOne({
    user: user._id,
    serviceKey: SERVICE_KEY,
  });
  if (session) subscriptionQuery.session(session);
  const subscription = await subscriptionQuery;
  if (!subscription) throw new Error("SUBSCRIPTION_NOT_FOUND");

  const cycleQuery = SubscriptionBillingCycle.findOne({
    subscription: subscription._id,
    periodKey,
  });
  if (session) cycleQuery.session(session);
  const cycle = await cycleQuery;
  if (!cycle) throw new Error("CYCLE_NOT_FOUND");

  const scheduleQuery = FixedSchedule.findOne({
    user: user._id,
    serviceKey: SERVICE_KEY,
    active: true,
  }).sort({ updatedAt: -1 });
  if (session) scheduleQuery.session(session);
  const schedule = await scheduleQuery;
  if (!schedule) throw new Error("ACTIVE_FIXED_SCHEDULE_NOT_FOUND");

  const today = ymdAR();

  const appointmentQuery = Appointment.find({
    user: user._id,
    serviceKey: SERVICE_KEY,
    fixedScheduleId: schedule._id,
    date: { $gte: today },
  }).sort({ date: 1, time: 1 });
  if (session) appointmentQuery.session(session);
  const appointments = await appointmentQuery;

  return {
    user,
    subscription,
    cycle,
    schedule,
    appointments,
    today,
  };
}

async function precheck({ periodKey, session = null }) {
  const state = await loadState({ periodKey, session });

  const {
    user,
    subscription,
    cycle,
    schedule,
    appointments,
  } = state;

  const errors = [];
  const rows = [];

  if (subscription.status !== "active") {
    errors.push({
      type: "SUBSCRIPTION_NOT_ACTIVE",
      status: subscription.status,
    });
  }

  if (subscription.autoRenew === false) {
    errors.push({ type: "AUTO_RENEW_DISABLED" });
  }

  if (cycle.lifecycle?.planStatus !== "active") {
    errors.push({
      type: "CYCLE_LIFECYCLE_NOT_ACTIVE",
      status: cycle.lifecycle?.planStatus,
    });
  }

  if (money(cycle.billing?.total) !== EXPECTED_TOTAL) {
    errors.push({
      type: "CYCLE_TOTAL_CHANGED",
      expected: EXPECTED_TOTAL,
      actual: money(cycle.billing?.total),
    });
  }

  if (money(cycle.billing?.amountReceived) !== EXPECTED_RECEIVED) {
    errors.push({
      type: "CYCLE_RECEIVED_CHANGED",
      expected: EXPECTED_RECEIVED,
      actual: money(cycle.billing?.amountReceived),
    });
  }

  const candidates = appointments.filter(isLifecycleCancellation);

  if (!candidates.length) {
    errors.push({ type: "NO_LIFECYCLE_CANCELLED_APPOINTMENTS" });
  }

  for (const ap of candidates) {
    const date = clean(ap.date).slice(0, 10);
    const time = clean(ap.time).slice(0, 5);

    const row = {
      appointmentId: String(ap._id),
      date,
      time,
      creditLotId: idOf(ap.creditLotId),
      patternMatches: schedulePatternHasSlot(schedule, date, time),
      blocked: false,
      blockReason: "",
      reservedNow: 0,
      effectiveLimit: 0,
      serviceLimit: null,
      zoneLimit: 0,
      sameUserConflictId: "",
      safe: false,
    };

    if (!row.patternMatches) {
      errors.push({
        type: "APPOINTMENT_NOT_IN_ACTIVE_FIXED_PATTERN",
        appointmentId: row.appointmentId,
        date,
        time,
      });
      rows.push(row);
      continue;
    }

    const block = await findActiveBlock({ date, time, session });
    if (block) {
      row.blocked = true;
      row.blockReason =
        clean(block.reason || block.title) || "Agenda bloqueada";
      errors.push({
        type: "SCHEDULE_BLOCKED",
        appointmentId: row.appointmentId,
        date,
        time,
        reason: row.blockReason,
      });
      rows.push(row);
      continue;
    }

    const rulesQuery = CapacityRule.find({
      active: true,
      $or: [
        { scope: "default" },
        { scope: "month", monthKey: date.slice(0, 7) },
        { scope: { $in: ["date", "slot"] }, date },
      ],
    }).sort({ updatedAt: 1 });

    if (session) rulesQuery.session(session);
    const rules = await rulesQuery.lean();

    const capacity = resolveEpCapacity(rules, date, time);
    row.zoneLimit = capacity.zoneLimit;
    row.serviceLimit = capacity.serviceLimit;
    row.effectiveLimit = capacity.effectiveLimit;

    const reservedQuery = Appointment.find({
      date,
      time,
      status: "reserved",
    }).select("_id user serviceKey");
    if (session) reservedQuery.session(session);
    const reserved = await reservedQuery.lean();

    const epReserved = reserved.filter(
      (item) => clean(item.serviceKey).toUpperCase() === SERVICE_KEY
    );

    row.reservedNow = epReserved.length;

    const sameUserConflict = reserved.find(
      (item) =>
        String(item.user) === String(user._id) &&
        String(item._id) !== String(ap._id)
    );

    if (sameUserConflict) {
      row.sameUserConflictId = String(sameUserConflict._id);
      errors.push({
        type: "USER_ALREADY_RESERVED_OTHER_APPOINTMENT",
        appointmentId: row.appointmentId,
        date,
        time,
        conflictAppointmentId: row.sameUserConflictId,
      });
      rows.push(row);
      continue;
    }

    if (!(capacity.effectiveLimit > 0)) {
      errors.push({
        type: "CAPACITY_ZERO",
        appointmentId: row.appointmentId,
        date,
        time,
      });
      rows.push(row);
      continue;
    }

    if (epReserved.length + 1 > capacity.effectiveLimit) {
      errors.push({
        type: "CAPACITY_FULL",
        appointmentId: row.appointmentId,
        date,
        time,
        reservedNow: epReserved.length,
        limit: capacity.effectiveLimit,
      });
      rows.push(row);
      continue;
    }

    row.safe = true;
    rows.push(row);
  }

  return { state, candidates, rows, errors };
}

function serializable(doc) {
  if (!doc) return null;
  return doc.toObject ? doc.toObject({ depopulate: true }) : doc;
}

function ensureBackupDir() {
  const dir = path.resolve(
    "backups",
    "subscription-repairs"
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function writeBackup({ periodKey, state, candidates }) {
  const dir = ensureBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filepath = path.join(
    dir,
    `before-agustina-fixed-restore-${periodKey}-${stamp}.json`
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    periodKey,
    email: EMAIL,
    user: serializable(state.user),
    subscription: serializable(state.subscription),
    cycle: serializable(state.cycle),
    fixedSchedule: serializable(state.schedule),
    appointments: candidates.map(serializable),
  };

  fs.writeFileSync(filepath, JSON.stringify(payload, null, 2));
  return filepath;
}

async function applyRepair({ periodKey }) {
  const session = await mongoose.startSession();
  let output = null;

  try {
    await session.withTransaction(async () => {
      const check = await precheck({ periodKey, session });

      if (check.errors.length) {
        const err = new Error("PRECHECK_CHANGED_DURING_APPLY");
        err.details = check.errors;
        throw err;
      }

      const {
        user,
        subscription,
        cycle,
        schedule,
      } = check.state;

      const now = new Date();
      const restored = [];

      for (const row of check.rows) {
        const ap = await Appointment.findById(row.appointmentId).session(session);

        if (!ap || !isLifecycleCancellation(ap)) {
          throw new Error(`APPOINTMENT_CHANGED:${row.appointmentId}`);
        }

        if (String(ap.fixedScheduleId) !== String(schedule._id)) {
          throw new Error(`FIXED_SCHEDULE_CHANGED:${row.appointmentId}`);
        }

        ap.status = "reserved";
        ap.cancelledAt = null;
        ap.cancelledBy = null;
        ap.cancelledByRole = "";
        ap.cancelledByUser = null;
        ap.cancelReason = "";
        ap.refundApplied = false;
        ap.refundMode = "";
        ap.refundReason = "";
        ap.fixedDebtAmount = 0;

        if (ap.creditLotId) {
          ap.creditDebitStatus = "monthly_reserved";
          ap.fixedDebitProcessedAt = ap.creditDebitedAt || now;
        } else {
          ap.creditDebitStatus = "pending";
          ap.creditDebitedAt = null;
          ap.fixedDebitProcessedAt = null;
        }

        await ap.save({ session });

        restored.push({
          appointmentId: String(ap._id),
          date: ap.date,
          time: ap.time,
          creditLotId: idOf(ap.creditLotId),
          creditDebitStatus: ap.creditDebitStatus,
        });
      }

      const lotResult = await recalcCycleLot({
        user,
        cycle,
        session,
        now,
      });

      user.history = Array.isArray(user.history) ? user.history : [];
      user.history.push({
        action: "subscription_fixed_appointments_restored",
        title: "Turnos fijos restaurados",
        message:
          `Se restauraron ${restored.length} turnos futuros del plan EP después de corregir la baja por falta de pago.`,
        serviceKey: SERVICE_KEY,
        service: "Entrenamiento Personal",
        serviceName: "Entrenamiento Personal",
        qty: 0,
        createdAt: now,
      });

      await user.save({ session });
      await cycle.save({ session });

      // No tocamos plan/precio/autoRenew/fijos: ya están correctos.
      output = {
        ok: true,
        email: EMAIL,
        subscriptionId: String(subscription._id),
        cycleId: String(cycle._id),
        fixedScheduleId: String(schedule._id),
        restored,
        cycleLot: lotResult,
        userCreditsAfter: Number(user.credits || 0),
      };
    });

    return output;
  } finally {
    await session.endSession();
  }
}

async function main() {
  const periodKey = parseArg("period", "2026-09");
  const apply = hasFlag("apply");

  if (!process.env.MONGO_URI) {
    throw new Error("Falta MONGO_URI en .env");
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    console.log("\n" + "=".repeat(112));
    console.log(
      `AGUSTINA · RESTAURAR TURNOS FIJOS FUTUROS · ${periodKey} · ${
        apply ? "APPLY" : "DRY RUN"
      }`
    );
    console.log("=".repeat(112));

    const check = await precheck({ periodKey });

    console.log(
      `Subscription=${check.state.subscription.status} | ` +
      `cycle=${check.state.cycle.lifecycle?.planStatus} | ` +
      `billing=${check.state.cycle.billing?.status} | ` +
      `saldo=$${money(check.state.cycle.billing?.balanceDue)}`
    );
    console.log(
      `FixedSchedule=${String(check.state.schedule._id)} active=${check.state.schedule.active ? "SI" : "NO"}`
    );

    for (const row of check.rows) {
      console.log(
        `${row.date} ${row.time} | reservedNow=${row.reservedNow} ` +
        `limit=${row.effectiveLimit} | blocked=${row.blocked ? "SI" : "NO"} ` +
        `pattern=${row.patternMatches ? "OK" : "NO"} | SAFE=${row.safe ? "SI" : "NO"}`
      );
    }

    if (check.errors.length) {
      console.log("\nPRECHECK FALLÓ. NO SE MODIFICA NADA.");
      for (const error of check.errors) {
        console.log(JSON.stringify(error));
      }
      process.exitCode = 2;
      return;
    }

    console.log(
      `\nPRECHECK OK: ${check.candidates.length} turnos pueden restaurarse sin superar capacidad.`
    );

    if (!apply) {
      console.log("DRY RUN: no se modificó ningún dato.");
      console.log(
        `Para aplicar: node scripts/restoreAgustinaFutureFixedAppointments.js --period=${periodKey} --apply`
      );
      return;
    }

    const backupPath = await writeBackup({
      periodKey,
      state: check.state,
      candidates: check.candidates,
    });

    console.log(`Backup: ${backupPath}`);

    const result = await applyRepair({ periodKey });

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
