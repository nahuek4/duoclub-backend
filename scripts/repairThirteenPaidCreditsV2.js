// scripts/repairThirteenPaidCreditsV2.js
//
// DUO CLUB — Reparación controlada de 13 usuarios con Order EP paga en septiembre.
//
// REGLA DE NEGOCIO:
// - La cantidad de sesiones válida para septiembre es la cantidad de créditos
//   de la Order paga específica.
// - Los turnos fijos se reservan igual. Consumen primero esas sesiones.
// - Si sobran sesiones, quedan libres para reservas normales.
// - Si faltan sesiones para cubrir todos los fijos, los fijos excedentes quedan
//   reservados pero "pending" (pendientes de cobertura), sin generar deuda.
// - NO se suma lote del ciclo + lote de Order. Se reconcilian en UN solo
//   entitlement: el lote de la Order.
// - La suscripción recurrente ACTUAL (plan/precio/sesiones futuras) se preserva.
// - El ciclo de septiembre se corrige para reflejar lo realmente comprado en
//   esa Order histórica.
// - La cuenta queda ACTIVE porque existe un pago.
//
// SEGURIDAD:
// - DRY RUN por defecto.
// - Lista cerrada de 13 usuarios + Order IDs.
// - Valida usuario/order/suscripción/ciclo/lotes.
// - Valida ScheduleBlocks.
// - Valida capacidad dinámica por fecha/hora.
// - Valida cupo estructural de turnos fijos.
// - Simula los 13 juntos para no sobreasignar un mismo horario.
// - Backup JSON antes de aplicar.
// - Una transacción por usuario.
// - Si un usuario tiene conflicto, se SALTEA; no bloquea los demás.
//
// USO:
//   node scripts/repairThirteenPaidCreditsV2.js --period=2026-09
//   node scripts/repairThirteenPaidCreditsV2.js --period=2026-09 --apply
//
// Opcional:
//   --only=email@dominio.com

import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Order from "../src/models/Order.js";
import Appointment from "../src/models/Appointment.js";
import FixedSchedule from "../src/models/FixedSchedule.js";
import ScheduleBlock from "../src/models/ScheduleBlock.js";
import CapacityRule from "../src/models/CapacityRule.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import SubscriptionLifecycleNotice from "../src/models/SubscriptionLifecycleNotice.js";

const TZ = "America/Argentina/Buenos_Aires";
const SERVICE_KEY = "EP";

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
].map(([email, orderId, expectedAmount, expectedCredits]) => ({
  email,
  orderId,
  expectedAmount,
  expectedCredits,
}));

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

function idOf(value) {
  return clean(value?._id || value?.id || value);
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function asInt(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseArgs() {
  let periodKey = "2026-09";
  let apply = false;
  let only = "";

  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") {
      apply = true;
    } else if (arg.startsWith("--period=")) {
      periodKey = clean(arg.slice("--period=".length));
    } else if (arg.startsWith("--only=")) {
      only = clean(arg.slice("--only=".length)).toLowerCase();
    }
  }

  if (!/^\d{4}-\d{2}$/.test(periodKey)) {
    throw new Error(`Período inválido: ${periodKey}`);
  }

  return { periodKey, apply, only };
}

function periodBounds(periodKey) {
  const [year, month] = periodKey.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return {
    startYmd: `${periodKey}-01`,
    endYmd: `${periodKey}-${pad2(lastDay)}`,
  };
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
  const dt = new Date(`${clean(dateStr).slice(0, 10)}T12:00:00-03:00`);
  const js = dt.getDay();
  return js === 0 ? 7 : js;
}

function addDaysYmd(dateStr, days) {
  const dt = new Date(`${dateStr}T12:00:00-03:00`);
  dt.setDate(dt.getDate() + Number(days || 0));
  return ymdAR(dt);
}

function dateRange(startYmd, endYmd) {
  const out = [];
  let cursor = startYmd;
  while (cursor <= endYmd) {
    out.push(cursor);
    cursor = addDaysYmd(cursor, 1);
  }
  return out;
}

function isLifecycleCancellation(ap) {
  return (
    clean(ap?.status).toLowerCase() === "cancelled" &&
    /falta de pago|plan mensual/i.test(clean(ap?.cancelReason))
  );
}

function appointmentConsumesSession(ap, simulatedStatus = "") {
  const status = clean(simulatedStatus || ap?.status).toLowerCase();

  if (status === "reserved" || status === "completed") return true;

  if (
    status === "cancelled" &&
    ap?.refundApplied !== true &&
    !isLifecycleCancellation(ap)
  ) {
    return true;
  }

  return false;
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

function extractOrderCreditItem(order) {
  const items = Array.isArray(order?.items) ? order.items : [];

  const matches = items.filter(
    (item) =>
      clean(item?.kind).toUpperCase() === "CREDITS" &&
      clean(item?.serviceKey).toUpperCase() === SERVICE_KEY
  );

  if (matches.length !== 1) {
    return {
      ok: false,
      error: `EXPECTED_ONE_EP_CREDITS_ITEM:${matches.length}`,
    };
  }

  const item = matches[0];
  const qty = Math.max(1, asInt(item?.qty) || 1);
  const credits = asInt(item?.credits) * qty;

  if (!(credits > 0)) {
    return { ok: false, error: "ORDER_CREDITS_INVALID" };
  }

  return {
    ok: true,
    raw: item,
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

function resolveEpCapacity(rules, dateStr, time) {
  const zoneRule = pickCapacityRule(
    rules,
    (item) =>
      clean(item?.targetType).toLowerCase() === "zone" &&
      clean(item?.zone).toUpperCase() === "TRAINING",
    dateStr,
    time
  );

  const serviceRule = pickCapacityRule(
    rules,
    (item) =>
      clean(item?.targetType).toLowerCase() === "service" &&
      clean(item?.serviceKey).toUpperCase() === SERVICE_KEY,
    dateStr,
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

async function loadCapacityRulesForDate(dateStr, session = null) {
  const day = clean(dateStr).slice(0, 10);
  const monthKey = day.slice(0, 7);

  const query = CapacityRule.find({
    active: true,
    $or: [
      { scope: "default" },
      { scope: "month", monthKey },
      { scope: { $in: ["date", "slot"] }, date: day },
    ],
  }).sort({ updatedAt: 1 });

  if (session) query.session(session);
  return query.lean();
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

function dateMatchesBlock(block, dateStr) {
  const day = clean(dateStr).slice(0, 10);
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

function scheduleContainsOccurrence(schedule, dateStr, time) {
  const weekday = weekdayMondayFirst(dateStr);
  const t = clean(time).slice(0, 5);

  return (Array.isArray(schedule?.items) ? schedule.items : []).some(
    (item) =>
      Number(item?.weekday || 0) === weekday &&
      clean(item?.time).slice(0, 5) === t
  );
}

function scheduleIsInDateRange(schedule, dateStr) {
  const day = clean(dateStr).slice(0, 10);
  const start = clean(schedule?.startDate).slice(0, 10);
  const end = clean(schedule?.endDate).slice(0, 10);

  if (start && day < start) return false;
  if (end && day > end) return false;
  return true;
}

function futureScheduleOccurrences(schedule, today, periodEnd) {
  const out = [];

  for (const day of dateRange(today, periodEnd)) {
    if (!scheduleIsInDateRange(schedule, day)) continue;

    const weekday = weekdayMondayFirst(day);

    for (const item of Array.isArray(schedule?.items) ? schedule.items : []) {
      if (Number(item?.weekday || 0) !== weekday) continue;

      out.push({
        fixedScheduleId: String(schedule._id),
        date: day,
        time: clean(item?.time).slice(0, 5),
      });
    }
  }

  return out;
}

function sortAppointmentsForCoverage(a, b) {
  const af = a.fixedScheduleId ? 0 : 1;
  const bf = b.fixedScheduleId ? 0 : 1;
  if (af !== bf) return af - bf;

  const ad = `${clean(a.date)} ${clean(a.time)}`;
  const bd = `${clean(b.date)} ${clean(b.time)}`;
  if (ad !== bd) return ad.localeCompare(bd);

  const ac = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bc = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  return ac - bc;
}

async function resolveCandidateSchedules({
  user,
  cycle,
  allSchedules,
  periodKey,
  today,
}) {
  const futureLifecycle = await Appointment.find({
    user: user._id,
    serviceKey: SERVICE_KEY,
    fixedScheduleId: { $ne: null },
    status: "cancelled",
    date: { $gte: today },
    cancelReason: /falta de pago|plan mensual/i,
  })
    .select("_id fixedScheduleId date time cancelReason")
    .lean();

  let ids = Array.from(
    new Set(
      futureLifecycle
        .map((ap) => idOf(ap.fixedScheduleId))
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    )
  );

  let source = "future_lifecycle_appointments";

  if (!ids.length) {
    ids = Array.from(
      new Set(
        (Array.isArray(cycle?.planSnapshot?.fixedScheduleIds)
          ? cycle.planSnapshot.fixedScheduleIds
          : []
        )
          .map(idOf)
          .filter((id) => mongoose.Types.ObjectId.isValid(id))
      )
    );
    source = "cycle_plan_snapshot";
  }

  if (!ids.length) {
    ids = allSchedules
      .filter(
        (schedule) =>
          schedule.active !== true &&
          clean(schedule.lastAutoReleasedMonthKey) === periodKey
      )
      .map((schedule) => String(schedule._id));

    source = "last_auto_released_month";
  }

  const scheduleById = new Map(
    allSchedules.map((schedule) => [String(schedule._id), schedule])
  );

  const schedules = ids
    .map((id) => scheduleById.get(id))
    .filter(Boolean);

  return {
    source,
    ids: schedules.map((schedule) => String(schedule._id)),
    schedules,
    futureLifecycle,
  };
}

async function buildRow(target, periodKey, bounds, today) {
  const errors = [];
  const warnings = [];

  const user = await User.findOne({
    email: target.email.toLowerCase(),
  });

  if (!user) {
    return {
      target,
      email: target.email,
      errors: [{ type: "USER_NOT_FOUND" }],
      warnings,
      ready: false,
    };
  }

  const [order, subscription] = await Promise.all([
    Order.findById(target.orderId),
    ServiceSubscription.findOne({
      user: user._id,
      serviceKey: SERVICE_KEY,
    }),
  ]);

  if (!order) errors.push({ type: "ORDER_NOT_FOUND" });
  if (!subscription) errors.push({ type: "SUBSCRIPTION_NOT_FOUND" });

  if (errors.length) {
    return {
      target,
      email: target.email,
      user,
      order,
      subscription,
      errors,
      warnings,
      ready: false,
    };
  }

  const cycle = await SubscriptionBillingCycle.findOne({
    subscription: subscription._id,
    periodKey,
  });

  if (!cycle) {
    errors.push({ type: "CYCLE_NOT_FOUND" });
  }

  const item = extractOrderCreditItem(order);

  if (!item.ok) {
    errors.push({ type: item.error });
  }

  const orderAmount = money(
    order.totalFinal ?? order.total ?? order.price
  );

  if (String(order.user) !== String(user._id)) {
    errors.push({ type: "ORDER_USER_MISMATCH" });
  }

  if (!["paid", "approved"].includes(clean(order.status).toLowerCase())) {
    errors.push({
      type: "ORDER_NOT_PAID",
      status: order.status,
    });
  }

  if (orderAmount !== target.expectedAmount) {
    errors.push({
      type: "ORDER_AMOUNT_CHANGED",
      expected: target.expectedAmount,
      actual: orderAmount,
    });
  }

  if (item.ok && item.credits !== target.expectedCredits) {
    errors.push({
      type: "ORDER_CREDITS_CHANGED",
      expected: target.expectedCredits,
      actual: item.credits,
    });
  }

  if (!cycle || !item.ok) {
    return {
      target,
      email: target.email,
      user,
      order,
      subscription,
      cycle,
      item,
      orderAmount,
      errors,
      warnings,
      ready: false,
    };
  }

  const allSchedules = await FixedSchedule.find({
    user: user._id,
    serviceKey: SERVICE_KEY,
  }).sort({ createdAt: 1 });

  const scheduleResolution = await resolveCandidateSchedules({
    user,
    cycle,
    allSchedules,
    periodKey,
    today,
  });

  const candidateScheduleIds = scheduleResolution.ids;

  // V2: no aceptar silenciosamente "0 fijos" si el usuario fue terminado
  // y todavía existen FixedSchedule(s) inactivos que no pudimos vincular.
  const inactiveSchedules = allSchedules.filter(
    (schedule) => schedule.active !== true
  );

  if (
    subscription.status === "terminated_for_non_payment" &&
    candidateScheduleIds.length === 0 &&
    inactiveSchedules.length > 0
  ) {
    errors.push({
      type: "FIXED_SCHEDULE_SOURCE_UNRESOLVED",
      inactiveScheduleIds: inactiveSchedules.map((schedule) =>
        String(schedule._id)
      ),
      inactiveSchedules: inactiveSchedules.map((schedule) => ({
        id: String(schedule._id),
        startDate: schedule.startDate || null,
        endDate: schedule.endDate || null,
        lastAutoReleasedMonthKey:
          schedule.lastAutoReleasedMonthKey || "",
        items: (schedule.items || []).map((item) => ({
          weekday: Number(item.weekday || 0),
          time: clean(item.time).slice(0, 5),
        })),
      })),
    });
  }

  const cycleLotId = idOf(cycle.creditGrant?.lotId);
  const orderLots = (Array.isArray(user.creditLots) ? user.creditLots : []).filter(
    (lot) =>
      idOf(lot?.orderId) === String(order._id) &&
      clean(lot?.serviceKey).toUpperCase() === SERVICE_KEY
  );

  if (orderLots.length !== 1) {
    errors.push({
      type: "EXPECTED_ONE_ORDER_LOT",
      count: orderLots.length,
    });
  }

  const orderLot = orderLots[0] || null;

  if (orderLot) {
    if (asInt(orderLot.amount) !== item.credits) {
      errors.push({
        type: "ORDER_LOT_AMOUNT_CHANGED",
        expected: item.credits,
        actual: asInt(orderLot.amount),
      });
    }
  }

  const cycleLot =
    cycleLotId && user.creditLots?.id
      ? user.creditLots.id(cycleLotId)
      : null;

  if (cycleLotId && !cycleLot) {
    errors.push({
      type: "CYCLE_LOT_NOT_FOUND",
      lotId: cycleLotId,
    });
  }

  // Si ya fue reparado por este criterio, lo tratamos como idempotente.
  const alreadyRepaired =
    subscription.status === "active" &&
    cycle.lifecycle?.planStatus === "active" &&
    cycle.billing?.status === "paid" &&
    String(cycle.billing?.order || "") === String(order._id) &&
    money(cycle.billing?.total) === orderAmount &&
    money(cycle.billing?.amountReceived) === orderAmount &&
    asInt(cycle.creditGrant?.grantedSessions) === item.credits &&
    orderLot &&
    String(cycle.creditGrant?.lotId || "") === String(orderLot._id);

  const linkedLotIds = [cycleLotId, orderLot ? String(orderLot._id) : ""]
    .filter((id) => mongoose.Types.ObjectId.isValid(id));

  const linkedAppointments = linkedLotIds.length
    ? await Appointment.find({
        user: user._id,
        serviceKey: SERVICE_KEY,
        creditLotId: { $in: linkedLotIds },
      }).sort({ date: 1, time: 1, createdAt: 1 })
    : [];

  const fixedAppointments = candidateScheduleIds.length
    ? await Appointment.find({
        user: user._id,
        serviceKey: SERVICE_KEY,
        fixedScheduleId: { $in: candidateScheduleIds },
        date: {
          $gte: bounds.startYmd,
          $lte: bounds.endYmd,
        },
      }).sort({ date: 1, time: 1, createdAt: 1 })
    : [];

  const relevantMap = new Map();

  for (const ap of [...linkedAppointments, ...fixedAppointments]) {
    relevantMap.set(String(ap._id), ap);
  }

  const relevantAppointments = [...relevantMap.values()];

  const futureLifecycleToRestore = relevantAppointments.filter(
    (ap) =>
      clean(ap.date).slice(0, 10) >= today &&
      candidateScheduleIds.includes(String(ap.fixedScheduleId || "")) &&
      isLifecycleCancellation(ap)
  );

  const restoreIds = new Set(
    futureLifecycleToRestore.map((ap) => String(ap._id))
  );

  // Verifica que los appointments futuros del patrón existan.
  const allAppointmentsBySlot = new Set(
    fixedAppointments.map(
      (ap) =>
        `${String(ap.fixedScheduleId)}|${clean(ap.date).slice(0, 10)}|${clean(
          ap.time
        ).slice(0, 5)}`
    )
  );

  const missingFutureOccurrences = [];

  for (const schedule of scheduleResolution.schedules) {
    for (const occ of futureScheduleOccurrences(
      schedule,
      today,
      bounds.endYmd
    )) {
      const key = `${occ.fixedScheduleId}|${occ.date}|${occ.time}`;

      if (!allAppointmentsBySlot.has(key)) {
        missingFutureOccurrences.push(occ);
      }
    }
  }

  if (missingFutureOccurrences.length) {
    errors.push({
      type: "MISSING_FUTURE_FIXED_APPOINTMENTS",
      count: missingFutureOccurrences.length,
      items: missingFutureOccurrences,
    });
  }

  // Simulación de consumo:
  // 1) fijos primero;
  // 2) luego reservas libres/manuales;
  // 3) nunca más sesiones cubiertas que credits de la Order.
  const simulationRows = relevantAppointments
    .map((ap) => {
      const simulatedStatus = restoreIds.has(String(ap._id))
        ? "reserved"
        : clean(ap.status).toLowerCase();

      return {
        ap,
        simulatedStatus,
        consumes: appointmentConsumesSession(ap, simulatedStatus),
      };
    })
    .sort((a, b) => sortAppointmentsForCoverage(a.ap, b.ap));

  const consumptions = simulationRows.filter((row) => row.consumes);
  const covered = consumptions.slice(0, item.credits);
  const uncovered = consumptions.slice(item.credits);

  const coveredIds = new Set(covered.map((row) => String(row.ap._id)));
  const uncoveredIds = new Set(uncovered.map((row) => String(row.ap._id)));

  const uncoveredFixed = uncovered.filter((row) => !!row.ap.fixedScheduleId);
  const uncoveredNonFixed = uncovered.filter((row) => !row.ap.fixedScheduleId);

  if (uncoveredNonFixed.length) {
    warnings.push({
      type: "NON_FIXED_USAGE_EXCEEDS_PURCHASED_CREDITS",
      count: uncoveredNonFixed.length,
      items: uncoveredNonFixed.map((row) => ({
        appointmentId: String(row.ap._id),
        date: row.ap.date,
        time: row.ap.time,
        status: row.simulatedStatus,
      })),
    });
  }

  const fixedConsumptionRows = simulationRows.filter(
    (row) =>
      row.consumes &&
      !!row.ap.fixedScheduleId &&
      candidateScheduleIds.includes(String(row.ap.fixedScheduleId))
  );

  const fixedOccurrencesCount = fixedConsumptionRows.length;
  const coveredFixedOccurrences = Math.min(
    fixedOccurrencesCount,
    item.credits
  );
  const additionalSessionsStillNeeded = Math.max(
    0,
    fixedOccurrencesCount - item.credits
  );
  const freeSessions = Math.max(
    0,
    item.credits - fixedOccurrencesCount
  );

  // Si ya hay dinero en el ledger pero no coincide con esta Order,
  // no pisamos automáticamente.
  const existingPayments = Array.isArray(cycle.billing?.payments)
    ? cycle.billing.payments
    : [];

  const foreignPayments = existingPayments.filter(
    (payment) =>
      idOf(payment?.order) &&
      idOf(payment?.order) !== String(order._id)
  );

  if (foreignPayments.length) {
    errors.push({
      type: "FOREIGN_CYCLE_PAYMENTS_PRESENT",
      count: foreignPayments.length,
    });
  }

  if (
    !alreadyRepaired &&
    (money(cycle.billing?.amountReceived) > 0 ||
      money(cycle.billing?.amountPaid) > 0) &&
    !existingPayments.some(
      (payment) => idOf(payment?.order) === String(order._id)
    )
  ) {
    errors.push({
      type: "CYCLE_ALREADY_HAS_UNATTRIBUTED_PAYMENT",
      amountReceived: money(cycle.billing?.amountReceived),
      amountPaid: money(cycle.billing?.amountPaid),
    });
  }

  return {
    target,
    email: target.email,
    user,
    order,
    subscription,
    cycle,
    item,
    orderAmount,
    orderLot,
    cycleLot,
    cycleLotId,
    scheduleResolution,
    candidateScheduleIds,
    relevantAppointments,
    fixedAppointments,
    futureLifecycleToRestore,
    restoreIds,
    simulationRows,
    coveredIds,
    uncoveredIds,
    uncoveredFixed,
    uncoveredNonFixed,
    fixedOccurrencesCount,
    coveredFixedOccurrences,
    additionalSessionsStillNeeded,
    freeSessions,
    missingFutureOccurrences,
    alreadyRepaired,
    errors,
    warnings,
    ready: errors.length === 0,
  };
}

async function validateBatchFixedCapacity(rows, bounds, today) {
  const activeSchedules = await FixedSchedule.find({
    active: true,
    serviceKey: SERVICE_KEY,
  })
    .select("_id items")
    .lean();

  const activeCountByKey = new Map();

  for (const schedule of activeSchedules) {
    for (const item of Array.isArray(schedule?.items)
      ? schedule.items
      : []) {
      const key = `${Number(item.weekday)}|${clean(item.time).slice(0, 5)}`;
      activeCountByKey.set(
        key,
        (activeCountByKey.get(key) || 0) + 1
      );
    }
  }

  const candidateByKey = new Map();

  for (const row of rows.filter((row) => row.ready && !row.alreadyRepaired)) {
    for (const schedule of row.scheduleResolution.schedules) {
      if (schedule.active === true) continue;

      for (const item of Array.isArray(schedule?.items)
        ? schedule.items
        : []) {
        const key = `${Number(item.weekday)}|${clean(item.time).slice(0, 5)}`;

        if (!candidateByKey.has(key)) {
          candidateByKey.set(key, []);
        }

        candidateByKey.get(key).push({
          email: row.email,
          scheduleId: String(schedule._id),
          weekday: Number(item.weekday),
          time: clean(item.time).slice(0, 5),
        });
      }
    }
  }

  const errors = [];

  for (const [key, candidates] of candidateByKey.entries()) {
    const [weekdayRaw, time] = key.split("|");
    const weekday = Number(weekdayRaw);

    const futureDates = dateRange(today, bounds.endYmd).filter(
      (day) => weekdayMondayFirst(day) === weekday
    );

    let structuralLimit = DEFAULT_ZONE_CAPS.TRAINING;

    for (const date of futureDates) {
      const rules = await loadCapacityRulesForDate(date);
      const cap = resolveEpCapacity(rules, date, time);
      structuralLimit = Math.min(structuralLimit, cap.effectiveLimit);
    }

    const current = activeCountByKey.get(key) || 0;
    const restoring = candidates.length;

    if (current + restoring > structuralLimit) {
      errors.push({
        type: "FIXED_SCHEDULE_BATCH_CAPACITY",
        weekday,
        time,
        currentActiveFixedSlots: current,
        restoringFixedSlots: restoring,
        limit: structuralLimit,
        emails: [...new Set(candidates.map((item) => item.email))],
      });
    }
  }

  return errors;
}

async function validateBatchAppointmentCapacity(rows) {
  const candidates = rows
    .filter((row) => row.ready && !row.alreadyRepaired)
    .flatMap((row) =>
      row.futureLifecycleToRestore.map((ap) => ({
        email: row.email,
        userId: String(row.user._id),
        appointmentId: String(ap._id),
        date: clean(ap.date).slice(0, 10),
        time: clean(ap.time).slice(0, 5),
      }))
    );

  const bySlot = new Map();

  for (const candidate of candidates) {
    const key = `${candidate.date}|${candidate.time}`;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(candidate);
  }

  const errors = [];

  for (const [key, slotCandidates] of bySlot.entries()) {
    const [date, time] = key.split("|");

    const [block, rules, existing] = await Promise.all([
      findActiveBlock({ date, time }),
      loadCapacityRulesForDate(date),
      Appointment.find({
        date,
        time,
        status: "reserved",
      })
        .select("_id user serviceKey")
        .lean(),
    ]);

    if (block) {
      errors.push({
        type: "SCHEDULE_BLOCKED",
        date,
        time,
        blockId: String(block._id),
        reason: clean(block.reason || block.title) || "Agenda bloqueada",
        emails: [...new Set(slotCandidates.map((item) => item.email))],
      });
      continue;
    }

    const cap = resolveEpCapacity(rules, date, time);
    const epReserved = existing.filter(
      (ap) => clean(ap.serviceKey).toUpperCase() === SERVICE_KEY
    );

    for (const candidate of slotCandidates) {
      const sameUserOther = existing.find(
        (ap) =>
          String(ap.user) === candidate.userId &&
          String(ap._id) !== candidate.appointmentId
      );

      if (sameUserOther) {
        errors.push({
          type: "USER_ALREADY_RESERVED_OTHER_APPOINTMENT",
          date,
          time,
          email: candidate.email,
          existingAppointmentId: String(sameUserOther._id),
          targetAppointmentId: candidate.appointmentId,
        });
      }
    }

    if (epReserved.length + slotCandidates.length > cap.effectiveLimit) {
      errors.push({
        type: "APPOINTMENT_BATCH_CAPACITY",
        date,
        time,
        reservedNow: epReserved.length,
        restoring: slotCandidates.length,
        limit: cap.effectiveLimit,
        emails: [...new Set(slotCandidates.map((item) => item.email))],
      });
    }
  }

  return errors;
}

function attachBatchErrors(rows, batchErrors) {
  for (const error of batchErrors) {
    const emails = Array.isArray(error.emails)
      ? error.emails
      : error.email
        ? [error.email]
        : [];

    for (const email of emails) {
      const row = rows.find(
        (candidate) => candidate.email.toLowerCase() === email.toLowerCase()
      );

      if (!row) continue;
      row.errors.push(error);
      row.ready = false;
    }
  }
}

function rowSummary(row) {
  if (!row.user) {
    return {
      email: row.email,
      ready: false,
      errors: row.errors,
    };
  }

  return {
    email: row.email,
    ready: row.ready,
    alreadyRepaired: row.alreadyRepaired,
    order: {
      id: String(row.order?._id || ""),
      amount: row.orderAmount,
      credits: row.item?.credits || 0,
    },
    subscription: row.subscription
      ? {
          id: String(row.subscription._id),
          status: row.subscription.status,
          monthlySessions: asInt(row.subscription.monthlySessions),
          price: money(row.subscription.price),
          regularPrice: money(row.subscription.regularPrice),
          autoRenew: row.subscription.autoRenew !== false,
        }
      : null,
    cycle: row.cycle
      ? {
          id: String(row.cycle._id),
          billingStatus: row.cycle.billing?.status || "",
          billingTotalBefore: money(row.cycle.billing?.total),
          lifecycle: row.cycle.lifecycle?.planStatus || "",
          cycleGrantedBefore: asInt(row.cycle.creditGrant?.grantedSessions),
        }
      : null,
    schedules: {
      source: row.scheduleResolution?.source || "",
      ids: row.candidateScheduleIds || [],
      count: row.candidateScheduleIds?.length || 0,
    },
    appointments: {
      relevant: row.relevantAppointments?.length || 0,
      futureLifecycleRestore: row.futureLifecycleToRestore?.length || 0,
      fixedOccurrences: row.fixedOccurrencesCount || 0,
      coveredConsumptions: row.coveredIds?.size || 0,
      uncoveredFixed: row.uncoveredFixed?.length || 0,
      uncoveredNonFixed: row.uncoveredNonFixed?.length || 0,
    },
    resultPreview: {
      cycleTotalAfter: row.orderAmount || 0,
      sessionsPurchased: row.item?.credits || 0,
      freeSessionsAfterFixed: row.freeSessions || 0,
      fixedSessionsStillPending:
        row.additionalSessionsStillNeeded || 0,
      orderLotRemainingAfter:
        Math.max(
          0,
          (row.item?.credits || 0) -
            (row.coveredIds?.size || 0)
        ),
    },
    warnings: row.warnings || [],
    errors: row.errors || [],
  };
}

function serializable(doc) {
  if (!doc) return null;
  return doc.toObject
    ? doc.toObject({ depopulate: true })
    : doc;
}

function ensureBackupDir() {
  const dir = path.resolve(
    process.cwd(),
    "backups",
    "subscription-repairs"
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function writeBackup(rows, periodKey) {
  const dir = ensureBackupDir();
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  const filepath = path.join(
    dir,
    `before-repair-13-paid-credits-${periodKey}-${stamp}.json`
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    periodKey,
    rows: rows.map((row) => ({
      email: row.email,
      target: row.target,
      user: serializable(row.user),
      order: serializable(row.order),
      subscription: serializable(row.subscription),
      cycle: serializable(row.cycle),
      orderLotId: idOf(row.orderLot),
      cycleLotId: row.cycleLotId || "",
      schedules: (row.scheduleResolution?.schedules || []).map(serializable),
      relevantAppointments: (row.relevantAppointments || []).map(serializable),
      precheck: rowSummary(row),
    })),
  };

  fs.writeFileSync(
    filepath,
    JSON.stringify(payload, null, 2)
  );

  return filepath;
}

function buildCoverageNumbers(row) {
  const purchased = asInt(row.item.credits);
  const fixed = asInt(row.fixedOccurrencesCount);
  const coveredFixed = Math.min(fixed, purchased);
  const uncoveredFixed = Math.max(0, fixed - purchased);
  const free = Math.max(0, purchased - fixed);

  return {
    status:
      uncoveredFixed > 0
        ? "extra_sessions_required"
        : "covered",
    baseSessions: purchased,
    extraSessionsSelected: 0,
    totalSessions: purchased,
    fixedOccurrencesCount: fixed,
    blockedOccurrencesCount: 0,
    coveredFixedOccurrences: coveredFixed,
    uncoveredFixedOccurrences: uncoveredFixed,
    extraSessionsNeeded: uncoveredFixed,
    additionalSessionsStillNeeded: uncoveredFixed,
    freeSessions: free,
    calculatedAt: new Date(),
  };
}

async function applyRow(row, periodKey) {
  const session = await mongoose.startSession();
  let output = null;

  try {
    await session.withTransaction(async () => {
      const [user, order, subscription, cycle] =
        await Promise.all([
          User.findById(row.user._id).session(session),
          Order.findById(row.order._id).session(session),
          ServiceSubscription.findById(
            row.subscription._id
          ).session(session),
          SubscriptionBillingCycle.findById(
            row.cycle._id
          ).session(session),
        ]);

      if (!user) throw new Error("USER_NOT_FOUND");
      if (!order) throw new Error("ORDER_NOT_FOUND");
      if (!subscription) {
        throw new Error("SUBSCRIPTION_NOT_FOUND");
      }
      if (!cycle) throw new Error("CYCLE_NOT_FOUND");

      const item = extractOrderCreditItem(order);

      if (!item.ok) {
        throw new Error(item.error);
      }

      const orderAmount = money(
        order.totalFinal ?? order.total ?? order.price
      );

      if (
        orderAmount !== row.orderAmount ||
        item.credits !== row.item.credits
      ) {
        throw new Error("ORDER_CHANGED_AFTER_PRECHECK");
      }

      const orderLots = (Array.isArray(user.creditLots)
        ? user.creditLots
        : []
      ).filter(
        (lot) =>
          idOf(lot?.orderId) === String(order._id) &&
          clean(lot?.serviceKey).toUpperCase() ===
            SERVICE_KEY
      );

      if (orderLots.length !== 1) {
        throw new Error(
          `EXPECTED_ONE_ORDER_LOT:${orderLots.length}`
        );
      }

      const orderLot = orderLots[0];

      const oldCycleLotId = idOf(
        cycle.creditGrant?.lotId
      );

      const oldCycleLot =
        oldCycleLotId && user.creditLots?.id
          ? user.creditLots.id(oldCycleLotId)
          : null;

      const candidateScheduleIds = row.candidateScheduleIds.filter(
        (id) => mongoose.Types.ObjectId.isValid(id)
      );

      const schedules = candidateScheduleIds.length
        ? await FixedSchedule.find({
            _id: { $in: candidateScheduleIds },
            user: user._id,
            serviceKey: SERVICE_KEY,
          }).session(session)
        : [];

      if (
        schedules.length !== candidateScheduleIds.length
      ) {
        throw new Error(
          "FIXED_SCHEDULE_COUNT_CHANGED"
        );
      }

      for (const schedule of schedules) {
        schedule.active = true;
        schedule.deactivatedAt = null;
        await schedule.save({ session });
      }

      // Restaura exclusivamente los appointments que el lifecycle canceló.
      const restoredAppointments = [];

      for (const apId of row.restoreIds) {
        const ap = await Appointment.findById(apId).session(
          session
        );

        if (!ap) {
          throw new Error(
            `APPOINTMENT_NOT_FOUND:${apId}`
          );
        }

        if (!isLifecycleCancellation(ap)) {
          throw new Error(
            `APPOINTMENT_CHANGED:${apId}`
          );
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

        await ap.save({ session });

        restoredAppointments.push(String(ap._id));
      }

      // Vuelve a leer todos los appointments relevantes ya con los restores.
      const linkedLotIds = [
        oldCycleLotId,
        String(orderLot._id),
      ].filter((id) =>
        mongoose.Types.ObjectId.isValid(id)
      );

      const linkedAppointments = linkedLotIds.length
        ? await Appointment.find({
            user: user._id,
            serviceKey: SERVICE_KEY,
            creditLotId: { $in: linkedLotIds },
          })
            .sort({ date: 1, time: 1, createdAt: 1 })
            .session(session)
        : [];

      const fixedAppointments = candidateScheduleIds.length
        ? await Appointment.find({
            user: user._id,
            serviceKey: SERVICE_KEY,
            fixedScheduleId: {
              $in: candidateScheduleIds,
            },
            date: {
              $gte: `${periodKey}-01`,
              $lte: periodBounds(periodKey).endYmd,
            },
          })
            .sort({ date: 1, time: 1, createdAt: 1 })
            .session(session)
        : [];

      const relevantMap = new Map();

      for (const ap of [
        ...linkedAppointments,
        ...fixedAppointments,
      ]) {
        relevantMap.set(String(ap._id), ap);
      }

      const relevantAppointments = [
        ...relevantMap.values(),
      ];

      const simulationRows = relevantAppointments
        .map((ap) => ({
          ap,
          consumes: appointmentConsumesSession(ap),
        }))
        .sort((a, b) =>
          sortAppointmentsForCoverage(a.ap, b.ap)
        );

      const consumptions = simulationRows.filter(
        (item) => item.consumes
      );

      const covered = consumptions.slice(
        0,
        item.credits
      );

      const uncovered = consumptions.slice(
        item.credits
      );

      const coveredIds = new Set(
        covered.map((item) => String(item.ap._id))
      );

      const uncoveredIds = new Set(
        uncovered.map((item) => String(item.ap._id))
      );

      const now = new Date();

      // Canonicaliza referencias de appointments.
      let coveredAppointments = 0;
      let pendingAppointments = 0;
      let migratedNonConsuming = 0;

      for (const ap of relevantAppointments) {
        const apId = String(ap._id);

        if (coveredIds.has(apId)) {
          ap.creditLotId = orderLot._id;
          ap.creditExpiresAt =
            orderLot.expiresAt || null;

          ap.creditDebitStatus = ap.fixedScheduleId
            ? "monthly_reserved"
            : "debited";

          ap.creditDebitedAt =
            ap.creditDebitedAt ||
            ap.createdAt ||
            order.paidAt ||
            now;

          if (ap.fixedScheduleId) {
            ap.fixedDebitProcessedAt =
              ap.fixedDebitProcessedAt ||
              ap.creditDebitedAt ||
              now;
          }

          ap.fixedDebtAmount = 0;
          coveredAppointments += 1;
          await ap.save({ session });
          continue;
        }

        if (uncoveredIds.has(apId)) {
          // No regalamos sesiones por encima de lo comprado.
          // El appointment sigue existiendo/reservado/completado,
          // pero queda pendiente de cobertura.
          ap.creditLotId = null;
          ap.creditExpiresAt = null;
          ap.creditDebitStatus = "pending";
          ap.creditDebitedAt = null;

          if (ap.fixedScheduleId) {
            ap.fixedDebitProcessedAt = null;
          }

          ap.fixedDebtAmount = 0;
          pendingAppointments += 1;
          await ap.save({ session });
          continue;
        }

        // Cancelaciones con reintegro / appointments que no consumen:
        // los apuntamos al lote canónico si antes dependían de uno de los
        // dos lotes reconciliados. No afectan remaining.
        const currentLotId = idOf(ap.creditLotId);

        if (
          linkedLotIds.includes(currentLotId) &&
          currentLotId !== String(orderLot._id)
        ) {
          ap.creditLotId = orderLot._id;
          ap.creditExpiresAt =
            orderLot.expiresAt || null;
          await ap.save({ session });
          migratedNonConsuming += 1;
        }
      }

      // El lote de la Order pasa a ser la única fuente de estas sesiones.
      orderLot.amount = item.credits;
      orderLot.remaining = Math.max(
        0,
        item.credits - coveredAppointments
      );

      if (
        oldCycleLot &&
        String(oldCycleLot._id) !==
          String(orderLot._id)
      ) {
        oldCycleLot.remaining = 0;
      }

      recalcUserCredits(user, now);

      // Ciclo septiembre = lo que realmente se compró en la Order.
      cycle.planSnapshot.monthlySessions =
        item.credits;
      cycle.planSnapshot.basePrice = orderAmount;
      cycle.planSnapshot.regularPrice =
        orderAmount;
      cycle.planSnapshot.coveragePrice =
        item.coveragePrice;
      cycle.planSnapshot.coverageApplied =
        item.coverageApplied;
      cycle.planSnapshot.coverageReason =
        item.coverageApplied
          ? item.discountReason || "Cobertura"
          : "";
      cycle.planSnapshot.payMethod =
        clean(order.payMethod).toUpperCase() === "MP"
          ? "MP"
          : "CASH";
      cycle.planSnapshot.label =
        item.label || `${item.credits} sesiones`;

      if (
        item.pricingPlanId &&
        mongoose.Types.ObjectId.isValid(
          item.pricingPlanId
        )
      ) {
        cycle.planSnapshot.pricingPlan =
          item.pricingPlanId;
      } else {
        cycle.planSnapshot.pricingPlan = null;
      }

      cycle.planSnapshot.fixedScheduleIds =
        schedules.map((schedule) => schedule._id);

      const fixedConsumptionRows =
        simulationRows.filter(
          (itemRow) =>
            itemRow.consumes &&
            !!itemRow.ap.fixedScheduleId &&
            candidateScheduleIds.includes(
              String(itemRow.ap.fixedScheduleId)
            )
        );

      const fixedOccurrencesCount =
        fixedConsumptionRows.length;

      const coverage = {
        status:
          fixedOccurrencesCount > item.credits
            ? "extra_sessions_required"
            : "covered",
        baseSessions: item.credits,
        extraSessionsSelected: 0,
        totalSessions: item.credits,
        fixedOccurrencesCount,
        blockedOccurrencesCount: 0,
        coveredFixedOccurrences: Math.min(
          fixedOccurrencesCount,
          item.credits
        ),
        uncoveredFixedOccurrences: Math.max(
          0,
          fixedOccurrencesCount - item.credits
        ),
        extraSessionsNeeded: Math.max(
          0,
          fixedOccurrencesCount - item.credits
        ),
        additionalSessionsStillNeeded: Math.max(
          0,
          fixedOccurrencesCount - item.credits
        ),
        freeSessions: Math.max(
          0,
          item.credits - fixedOccurrencesCount
        ),
        calculatedAt: now,
      };

      cycle.coverage.status = coverage.status;
      cycle.coverage.baseSessions =
        coverage.baseSessions;
      cycle.coverage.extraSessionsSelected =
        coverage.extraSessionsSelected;
      cycle.coverage.totalSessions =
        coverage.totalSessions;
      cycle.coverage.fixedOccurrencesCount =
        coverage.fixedOccurrencesCount;
      cycle.coverage.blockedOccurrencesCount =
        coverage.blockedOccurrencesCount;
      cycle.coverage.coveredFixedOccurrences =
        coverage.coveredFixedOccurrences;
      cycle.coverage.uncoveredFixedOccurrences =
        coverage.uncoveredFixedOccurrences;
      cycle.coverage.extraSessionsNeeded =
        coverage.extraSessionsNeeded;
      cycle.coverage.additionalSessionsStillNeeded =
        coverage.additionalSessionsStillNeeded;
      cycle.coverage.freeSessions =
        coverage.freeSessions;
      cycle.coverage.calculatedAt =
        coverage.calculatedAt;

      cycle.billing.status = "paid";
      cycle.billing.amountBase = orderAmount;
      cycle.billing.amountExtras = 0;
      cycle.billing.amountAddOns = 0;
      cycle.billing.total = orderAmount;
      cycle.billing.amountReceived = orderAmount;
      cycle.billing.amountPaid = orderAmount;
      cycle.billing.balanceDue = 0;
      cycle.billing.overpaidAmount = 0;
      cycle.billing.paidAt =
        order.paidAt || now;
      cycle.billing.overdueAt = null;
      cycle.billing.cancelledAt = null;
      cycle.billing.writtenOffAt = null;
      cycle.billing.order = order._id;
      cycle.billing.paymentProvider =
        clean(order.payMethod);
      cycle.billing.paymentId =
        clean(order.mpPaymentId);

      cycle.billing.payments = [
        {
          order: order._id,
          amount: orderAmount,
          appliedAmount: orderAmount,
          excessAmount: 0,
          paidAt: order.paidAt || now,
          paymentProvider: clean(order.payMethod),
          paymentId: clean(order.mpPaymentId),
          note:
            "Reconciliación histórica: Order paga usada como fuente de sesiones del ciclo 2026-09.",
        },
      ];

      cycle.lifecycle.planStatus = "active";
      cycle.lifecycle.suspendedAt = null;
      cycle.lifecycle.terminatedAt = null;
      cycle.lifecycle.terminationReason = "";

      cycle.creditGrant.granted = true;
      cycle.creditGrant.grantedSessions =
        item.credits;
      cycle.creditGrant.grantedAt =
        cycle.creditGrant.grantedAt ||
        order.paidAt ||
        now;
      cycle.creditGrant.lotId = orderLot._id;
      cycle.creditGrant.expiresAt =
        orderLot.expiresAt || null;
      cycle.creditGrant.invalidatedAt = null;
      cycle.creditGrant.invalidationReason = "";

      cycle.notifications.reactivationSentAt =
        cycle.notifications.reactivationSentAt ||
        now;

      await cycle.save({ session });

      // La suscripción recurrente futura se PRESERVA.
      // Solo se reactiva.
      subscription.status = "active";
      subscription.autoRenew = true;
      subscription.suspendedAt = null;
      subscription.suspensionReason = "";
      subscription.terminatedAt = null;
      subscription.terminationReason = "";
      subscription.fixedSlotsProtectedUntil = null;

      const activeSchedules =
        await FixedSchedule.find({
          user: user._id,
          serviceKey: SERVICE_KEY,
          active: true,
        })
          .select("_id")
          .session(session);

      subscription.fixedScheduleIds =
        activeSchedules.map(
          (schedule) => schedule._id
        );

      await subscription.save({ session });

      user.history = Array.isArray(user.history)
        ? user.history
        : [];

      user.history.push({
        action:
          "subscription_historical_paid_order_reconciled",
        title:
          "Pago histórico del plan reconciliado",
        message:
          `Se reconocieron ${item.credits} sesiones de la Order ${String(
            order._id
          )} para ${periodKey}. Los turnos fijos consumen primero; el saldo queda libre.`,
        serviceKey: SERVICE_KEY,
        service: "Entrenamiento Personal",
        serviceName: "Entrenamiento Personal",
        qty: item.credits,
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

      // Marca que la Order histórica ya quedó reconciliada contra el ciclo.
      order.subscriptionCycleApplied = true;
      order.applied = true;
      await order.save({ session });

      output = {
        ok: true,
        email: row.email,
        orderId: String(order._id),
        subscriptionId: String(subscription._id),
        cycleId: String(cycle._id),
        sessionsPurchased: item.credits,
        cycleTotal: orderAmount,
        restoredFixedSchedules:
          schedules.length,
        restoredAppointments:
          restoredAppointments.length,
        coveredAppointments,
        pendingAppointments,
        migratedNonConsuming,
        orderLotId: String(orderLot._id),
        orderLotRemaining:
          Number(orderLot.remaining || 0),
        oldCycleLotId:
          oldCycleLotId || "",
        oldCycleLotRemaining:
          oldCycleLot &&
          String(oldCycleLot._id) !==
            String(orderLot._id)
            ? Number(oldCycleLot.remaining || 0)
            : null,
        userCreditsAfter:
          Number(user.credits || 0),
        fixedOccurrencesCount,
        fixedSessionsStillPending:
          Math.max(
            0,
            fixedOccurrencesCount - item.credits
          ),
        freeSessionsAfterFixed:
          Math.max(
            0,
            item.credits - fixedOccurrencesCount
          ),
        preservedRecurringSubscription: {
          monthlySessions: asInt(
            subscription.monthlySessions
          ),
          price: money(subscription.price),
          regularPrice: money(
            subscription.regularPrice
          ),
          payMethod: clean(
            subscription.payMethod
          ),
        },
      };
    });

    return output;
  } finally {
    await session.endSession();
  }
}

function printRow(row) {
  console.log(`\n${row.email}`);

  if (!row.user) {
    console.log("  READY=NO");
    for (const error of row.errors || []) {
      console.log(`  ERROR ${JSON.stringify(error)}`);
    }
    return;
  }

  console.log(
    `  Order: $${row.orderAmount} / ${row.item?.credits || 0} sesiones | ` +
      `admin=${row.order?.createdByAdmin ? "SI" : "NO"}`
  );

  console.log(
    `  Suscripción recurrente PRESERVADA: ${asInt(
      row.subscription?.monthlySessions
    )} sesiones / $${money(row.subscription?.price)} | ` +
      `status=${row.subscription?.status}`
  );

  console.log(
    `  Ciclo antes: total=$${money(
      row.cycle?.billing?.total
    )} received=$${money(
      row.cycle?.billing?.amountReceived
    )} lifecycle=${row.cycle?.lifecycle?.planStatus || "-"}`
  );

  console.log(
    `  Fijos a reactivar: ${row.candidateScheduleIds?.length || 0} ` +
      `(${row.scheduleResolution?.source || "-"}) | ` +
      `appointments lifecycle a restaurar=${row.futureLifecycleToRestore?.length || 0}`
  );

  console.log(
    `  Simulación créditos: compradas=${row.item?.credits || 0} | ` +
      `consumos cubiertos=${row.coveredIds?.size || 0} | ` +
      `pending fijos=${row.uncoveredFixed?.length || 0} | ` +
      `pending no-fijos=${row.uncoveredNonFixed?.length || 0} | ` +
      `saldo lote=${Math.max(
        0,
        (row.item?.credits || 0) -
          (row.coveredIds?.size || 0)
      )}`
  );

  console.log(
    `  Fijos que consumen sesión=${row.fixedOccurrencesCount || 0} | ` +
      `libres después de fijos=${row.freeSessions || 0} | ` +
      `fijos pendientes=${row.additionalSessionsStillNeeded || 0}`
  );

  if (row.alreadyRepaired) {
    console.log("  ESTADO: YA REPARADO / IDEMPOTENTE");
  } else {
    console.log(
      `  READY=${row.ready ? "SI" : "NO"}`
    );
  }

  for (const warning of row.warnings || []) {
    console.log(
      `  WARNING ${JSON.stringify(warning)}`
    );
  }

  for (const error of row.errors || []) {
    console.log(
      `  ERROR ${JSON.stringify(error)}`
    );
  }
}

async function main() {
  const { periodKey, apply, only } = parseArgs();
  const bounds = periodBounds(periodKey);
  const today = ymdAR();

  if (!process.env.MONGO_URI) {
    throw new Error("Falta MONGO_URI en .env");
  }

  const targets = TARGETS.filter(
    (target) =>
      !only ||
      target.email.toLowerCase() === only
  );

  if (!targets.length) {
    throw new Error(
      `No existe target para --only=${only}`
    );
  }

  await mongoose.connect(process.env.MONGO_URI);

  try {
    console.log(
      "\n" + "=".repeat(118)
    );
    console.log(
      `REPARACIÓN 13 ORDERS PAGAS · ${periodKey} · ${
        apply ? "APPLY" : "DRY RUN"
      }`
    );
    console.log(
      "Regla: créditos de la Order = sesiones válidas; fijos consumen primero; sobrante queda libre."
    );
    console.log(`Hoy AR: ${today}`);
    console.log(
      "=".repeat(118)
    );

    const rows = [];

    for (const target of targets) {
      rows.push(
        await buildRow(
          target,
          periodKey,
          bounds,
          today
        )
      );
    }

    const prelimReady = rows.filter(
      (row) => row.ready && !row.alreadyRepaired
    );

    const [
      fixedCapacityErrors,
      appointmentCapacityErrors,
    ] = await Promise.all([
      validateBatchFixedCapacity(
        prelimReady,
        bounds,
        today
      ),
      validateBatchAppointmentCapacity(
        prelimReady
      ),
    ]);

    attachBatchErrors(rows, [
      ...fixedCapacityErrors,
      ...appointmentCapacityErrors,
    ]);

    for (const row of rows) {
      printRow(row);
    }

    const readyRows = rows.filter(
      (row) => row.ready && !row.alreadyRepaired
    );

    const alreadyRows = rows.filter(
      (row) => row.alreadyRepaired
    );

    const blockedRows = rows.filter(
      (row) => !row.ready && !row.alreadyRepaired
    );

    console.log(
      "\n" + "-".repeat(118)
    );

    console.log({
      periodKey,
      targets: rows.length,
      ready: readyRows.length,
      alreadyRepaired: alreadyRows.length,
      blocked: blockedRows.length,
      sessionsPurchasedTotal: readyRows.reduce(
        (sum, row) =>
          sum + asInt(row.item?.credits),
        0
      ),
      futureAppointmentsToRestore: readyRows.reduce(
        (sum, row) =>
          sum +
          Number(
            row.futureLifecycleToRestore?.length || 0
          ),
        0
      ),
      fixedSchedulesToRestore: readyRows.reduce(
        (sum, row) =>
          sum +
          Number(
            row.candidateScheduleIds?.length || 0
          ),
        0
      ),
      freeSessionsAfterFixedTotal: readyRows.reduce(
        (sum, row) =>
          sum + Number(row.freeSessions || 0),
        0
      ),
      fixedPendingCoverageTotal: readyRows.reduce(
        (sum, row) =>
          sum + Number(row.uncoveredFixed?.length || 0),
        0
      ),
    });

    if (!apply) {
      console.log(
        "\nDRY RUN: NO SE MODIFICÓ NINGÚN DATO."
      );

      if (readyRows.length) {
        console.log(
          `Para aplicar SOLO los READY: node scripts/repairThirteenPaidCreditsV2.js --period=${periodKey} --apply`
        );
      }

      if (blockedRows.length) {
        console.log(
          "Los usuarios BLOCKED se saltearán en APPLY hasta resolver sus errores."
        );
      }

      return;
    }

    if (!readyRows.length) {
      console.log(
        "\nNo hay filas READY para aplicar."
      );
      return;
    }

    const backupPath = await writeBackup(
      readyRows,
      periodKey
    );

    console.log(`\nBackup: ${backupPath}`);

    const results = [];

    for (const row of readyRows) {
      try {
        const result = await applyRow(
          row,
          periodKey
        );

        results.push(result);

        console.log(
          `OK ${row.email}: sesiones=${result.sessionsPurchased} ` +
            `fijos=${result.restoredFixedSchedules} ` +
            `appointments=${result.restoredAppointments} ` +
            `saldoLibreLote=${result.orderLotRemaining} ` +
            `pending=${result.pendingAppointments}`
        );
      } catch (error) {
        results.push({
          ok: false,
          email: row.email,
          error:
            error?.message || String(error),
        });

        console.error(
          `ERROR ${row.email}: ${
            error?.message || error
          }`
        );
      }
    }

    const resultDir = ensureBackupDir();
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");
    const resultPath = path.join(
      resultDir,
      `repair-13-paid-credits-result-${periodKey}-${stamp}.json`
    );

    fs.writeFileSync(
      resultPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          periodKey,
          backupPath,
          results,
        },
        null,
        2
      )
    );

    console.log(
      "\n" + "=".repeat(118)
    );
    console.log(
      "REPARACIÓN TERMINADA"
    );
    console.log(
      `OK: ${results.filter((r) => r?.ok).length}`
    );
    console.log(
      `ERROR: ${results.filter((r) => !r?.ok).length}`
    );
    console.log(
      `Resultado: ${resultPath}`
    );
    console.log(
      "=".repeat(118)
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error(
    "\nREPAIR ERROR:",
    error?.stack || error?.message || error
  );

  try {
    await mongoose.disconnect();
  } catch {}

  process.exit(1);
});
