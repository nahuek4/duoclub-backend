// scripts/previewSubscriptionRepair.js
// SOLO LECTURA.
// Previsualiza la reparación de suscripciones/turnos fijos dados de baja por el
// lifecycle de falta de pago cuando existe una orden paga compatible.
// NO modifica MongoDB.

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
import CapacityRule from "../src/models/CapacityRule.js";
import ScheduleBlock from "../src/models/ScheduleBlock.js";

import {
  allowedTimesForService,
  capacityGroupForService,
  ensureServiceCatalogLoaded,
  normalizeCatalogServiceKey,
} from "../src/services/serviceCatalogRuntime.js";

const TZ = "America/Argentina/Buenos_Aires";

const DEFAULT_ZONE_CAPS = Object.freeze({
  TRAINING: 11,
  PERFORMANCE: 6,
  NONE: 1,
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

function pad2(value) {
  return String(value).padStart(2, "0");
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

function serviceKey(value) {
  return normalizeCatalogServiceKey(value);
}

function arParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function nowArgentina() {
  const p = arParts();
  return {
    periodKey: `${p.year}-${pad2(p.month)}`,
    ymd: `${p.year}-${pad2(p.month)}-${pad2(p.day)}`,
    time: `${pad2(p.hour)}:${pad2(p.minute)}`,
  };
}

function periodBounds(periodKey) {
  if (!/^\d{4}-\d{2}$/.test(periodKey)) {
    throw new Error(`Período inválido: ${periodKey}. Usá YYYY-MM.`);
  }

  const [year, month] = periodKey.split("-").map(Number);
  const lastDay = new Date(year, month, 0, 12, 0, 0).getDate();

  return {
    startYmd: `${periodKey}-01`,
    endYmd: `${periodKey}-${pad2(lastDay)}`,
    startDate: new Date(`${periodKey}-01T00:00:00-03:00`),
    endDate: new Date(`${periodKey}-${pad2(lastDay)}T23:59:59.999-03:00`),
  };
}

function parseArgs() {
  const now = nowArgentina();
  let selector = "";
  let periodKey = now.periodKey;
  let horizonDays = 62;

  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--period=")) {
      periodKey = clean(arg.slice("--period=".length));
    } else if (arg.startsWith("--horizon-days=")) {
      horizonDays = Math.max(1, Math.min(180, asInt(arg.slice("--horizon-days=".length)) || 62));
    } else if (!arg.startsWith("--") && !selector) {
      selector = clean(arg);
    }
  }

  return { selector, periodKey, horizonDays };
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = clean(ymd).split("-").map(Number);
  const date = new Date(y, m - 1, d, 12, 0, 0, 0);
  date.setDate(date.getDate() + Number(days || 0));
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function weekdayMondayFirst(ymd) {
  const [y, m, d] = clean(ymd).split("-").map(Number);
  const js = new Date(y, m - 1, d, 12, 0, 0, 0).getDay();
  return js === 0 ? 7 : js;
}

function enumerateDates(startYmd, endYmd, weekday) {
  const out = [];
  if (!startYmd || !endYmd || endYmd < startYmd) return out;

  let cursor = startYmd;
  let guard = 0;

  while (cursor <= endYmd && guard < 370) {
    if (weekdayMondayFirst(cursor) === Number(weekday)) out.push(cursor);
    cursor = addDaysYmd(cursor, 1);
    guard += 1;
  }

  return out;
}

function isPastSlot(date, time, now = nowArgentina()) {
  if (date < now.ymd) return true;
  if (date > now.ymd) return false;
  return clean(time).slice(0, 5) <= now.time;
}

function userName(user = {}) {
  return (
    [user?.name, user?.lastName].filter(Boolean).join(" ").trim() ||
    clean(user?.fullName) ||
    clean(user?.email) ||
    idOf(user)
  );
}

function orderItemsForService(order = {}, wantedServiceKey = "") {
  const wanted = serviceKey(wantedServiceKey);
  const items = Array.isArray(order?.items) ? order.items : [];
  const matched = [];

  for (const item of items) {
    const kind = clean(item?.kind).toUpperCase();
    if (!["CREDITS", "SUBSCRIPTION_RENEWAL"].includes(kind)) continue;

    const sk = serviceKey(item?.serviceKey);
    if (!sk || sk !== wanted) continue;

    matched.push({
      kind,
      serviceKey: sk,
      credits: asInt(item?.credits),
      qty: Math.max(1, asInt(item?.qty) || 1),
      pricingPlanId: idOf(item?.pricingPlanId),
      subscription: idOf(item?.subscription),
      subscriptionCycle: idOf(item?.subscriptionCycle),
      periodKey: clean(item?.periodKey),
      price: money(item?.price),
      basePrice: money(item?.basePrice),
      label: clean(item?.label),
    });
  }

  if (!matched.length) {
    const legacySk = serviceKey(order?.serviceKey);
    const legacyCredits = asInt(order?.credits);

    if (legacySk === wanted && legacyCredits > 0) {
      matched.push({
        kind: "LEGACY_CREDITS",
        serviceKey: legacySk,
        credits: legacyCredits,
        qty: 1,
        pricingPlanId: "",
        subscription: "",
        subscriptionCycle: "",
        periodKey: "",
        price: money(order?.price || order?.totalFinal || order?.total),
        basePrice: money(order?.basePrice),
        label: clean(order?.label),
      });
    }
  }

  return matched;
}

function scorePaidOrderMatch({ order, item, subscription, cycle }) {
  const expectedCredits = asInt(
    cycle?.planSnapshot?.monthlySessions || subscription?.monthlySessions
  );
  const expectedMethod = clean(
    cycle?.planSnapshot?.payMethod || subscription?.payMethod
  ).toUpperCase();
  const expectedPlanId = idOf(
    cycle?.planSnapshot?.pricingPlan || subscription?.pricingPlan
  );
  const expectedAmount = money(cycle?.billing?.total || subscription?.price);

  const bootstrapOrderId = idOf(subscription?.bootstrap?.latestPaidOrder?.orderId);
  const bootstrapCredits = asInt(
    subscription?.bootstrap?.paidCredits ||
    subscription?.bootstrap?.latestPaidOrder?.sessions
  );
  const bootstrapMethod = clean(
    subscription?.bootstrap?.paidPayMethod ||
    subscription?.bootstrap?.latestPaidOrder?.payMethod
  ).toUpperCase();
  const bootstrapPricingPlanId = idOf(subscription?.bootstrap?.paidPricingPlanId);

  const orderId = idOf(order);
  const orderMethod = clean(order?.payMethod).toUpperCase();
  const itemAmount = money(item?.price || item?.basePrice);
  const orderAmount = money(order?.totalFinal ?? order?.total ?? order?.price);
  const paidAt = order?.paidAt || order?.createdAt || null;

  const linkedCycleExact =
    item?.kind === "SUBSCRIPTION_RENEWAL" &&
    idOf(item?.subscriptionCycle) === idOf(cycle);

  const linkedSubscriptionExact =
    item?.kind === "SUBSCRIPTION_RENEWAL" &&
    idOf(item?.subscription) === idOf(subscription);

  const cycleBillingOrderExact =
    !!idOf(cycle?.billing?.order) &&
    idOf(cycle?.billing?.order) === orderId;

  const bootstrapOrderExact =
    !!bootstrapOrderId &&
    bootstrapOrderId === orderId;

  const creditsExact =
    expectedCredits > 0 &&
    asInt(item?.credits) === expectedCredits;

  const methodExact =
    !!expectedMethod &&
    orderMethod === expectedMethod;

  const planExact =
    !!expectedPlanId &&
    !!idOf(item?.pricingPlanId) &&
    idOf(item?.pricingPlanId) === expectedPlanId;

  const amountExact =
    expectedAmount > 0 &&
    (itemAmount === expectedAmount || orderAmount === expectedAmount);

  const periodExact =
    !!clean(item?.periodKey) &&
    clean(item?.periodKey) === clean(cycle?.periodKey);

  const bootstrapCreditsExact =
    bootstrapCredits > 0 &&
    asInt(item?.credits) === bootstrapCredits;

  const bootstrapMethodExact =
    !!bootstrapMethod &&
    orderMethod === bootstrapMethod;

  const bootstrapPlanExact =
    !!bootstrapPricingPlanId &&
    !!idOf(item?.pricingPlanId) &&
    idOf(item?.pricingPlanId) === bootstrapPricingPlanId;

  let score = 0;
  if (linkedCycleExact) score += 20;
  if (linkedSubscriptionExact) score += 8;
  if (cycleBillingOrderExact) score += 20;
  if (bootstrapOrderExact) score += 20;
  if (creditsExact) score += 5;
  if (methodExact) score += 4;
  if (planExact) score += 3;
  if (amountExact) score += 2;
  if (periodExact) score += 4;
  if (bootstrapCreditsExact) score += 4;
  if (bootstrapMethodExact) score += 3;
  if (bootstrapPlanExact) score += 3;

  const definitive =
    linkedCycleExact ||
    cycleBillingOrderExact ||
    bootstrapOrderExact;

  const coreCompatible =
    creditsExact &&
    methodExact;

  return {
    score,
    definitive,
    coreCompatible,
    linkedCycleExact,
    linkedSubscriptionExact,
    cycleBillingOrderExact,
    bootstrapOrderExact,
    creditsExact,
    methodExact,
    planExact,
    amountExact,
    periodExact,
    bootstrapCreditsExact,
    bootstrapMethodExact,
    bootstrapPlanExact,
    expected: {
      serviceKey: serviceKey(cycle?.serviceKey || subscription?.serviceKey),
      credits: expectedCredits,
      payMethod: expectedMethod,
      pricingPlanId: expectedPlanId,
      amount: expectedAmount,
      periodKey: clean(cycle?.periodKey),
      bootstrapOrderId,
      bootstrapCredits,
      bootstrapMethod,
      bootstrapPricingPlanId,
    },
    actual: {
      orderId,
      kind: item?.kind,
      credits: asInt(item?.credits),
      payMethod: orderMethod,
      pricingPlanId: idOf(item?.pricingPlanId),
      itemAmount,
      orderAmount,
      periodKey: clean(item?.periodKey),
      paidAt,
    },
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
    return clean(rule.date).slice(0, 10) === day && clean(rule.time).slice(0, 5) === t;
  }

  return false;
}

function pickCapacityRule(rules = [], predicate, dateStr, time) {
  return rules
    .filter((rule) => capacityRuleMatchesSlot(rule, dateStr, time))
    .filter(predicate)
    .sort((a, b) => {
      const ap = CAPACITY_SCOPE_PRIORITY[clean(a?.scope || "default")] ?? -1;
      const bp = CAPACITY_SCOPE_PRIORITY[clean(b?.scope || "default")] ?? -1;

      if (ap !== bp) return bp - ap;

      const au = a?.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bu = b?.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bu - au;
    })[0] || null;
}

function resolveCapacity(rules, sk, date, time) {
  const service = serviceKey(sk);
  const zone = clean(capacityGroupForService(service)).toUpperCase() || "NONE";
  const fallback = Number(DEFAULT_ZONE_CAPS[zone] || 0);

  const zoneRule = pickCapacityRule(
    rules,
    (rule) =>
      clean(rule?.targetType).toLowerCase() === "zone" &&
      clean(rule?.zone).toUpperCase() === zone,
    date,
    time
  );

  const zoneLimit = zoneRule ? Math.max(0, Number(zoneRule.limit || 0)) : fallback;

  const serviceRule = pickCapacityRule(
    rules,
    (rule) =>
      clean(rule?.targetType).toLowerCase() === "service" &&
      serviceKey(rule?.serviceKey) === service,
    date,
    time
  );

  const serviceLimit = serviceRule
    ? Math.max(0, Number(serviceRule.limit || 0))
    : null;

  const effectiveLimit =
    zone === "NONE"
      ? serviceLimit == null
        ? zoneLimit
        : serviceLimit
      : serviceLimit == null
        ? zoneLimit
        : Math.min(zoneLimit, serviceLimit);

  return {
    serviceKey: service,
    zone,
    zoneLimit,
    serviceLimit,
    effectiveLimit,
    zoneRuleId: idOf(zoneRule),
    serviceRuleId: idOf(serviceRule),
  };
}

function dateMatchesScheduleBlock(block, date) {
  const day = clean(date).slice(0, 10);
  if (!day || !block?.dateFrom) return false;
  if (day < clean(block.dateFrom).slice(0, 10)) return false;

  if (!block.indefinite) {
    const to = clean(block.dateTo || block.dateFrom).slice(0, 10);
    if (to && day > to) return false;
  }

  const weekdays = Array.isArray(block.weekdays) ? block.weekdays.map(Number) : [];
  if (weekdays.length && !weekdays.includes(weekdayMondayFirst(day))) return false;

  return true;
}

function timeMatchesScheduleBlock(block, time) {
  if (block?.allDay !== false) return true;

  const t = clean(time).slice(0, 5);
  const from = clean(block?.timeFrom).slice(0, 5);
  const to = clean(block?.timeTo).slice(0, 5);

  if (!from || !to) return true;
  return t >= from && t < to;
}

function blockAppliesToService(block, sk) {
  const wanted = serviceKey(sk);
  if (block?.allServices === true) return true;

  const keys = Array.isArray(block?.serviceKeys)
    ? block.serviceKeys.map(serviceKey).filter(Boolean)
    : [];

  return keys.includes(wanted);
}

async function loadCapacityRulesForDate(date) {
  const monthKey = clean(date).slice(0, 7);

  return CapacityRule.find({
    active: true,
    $or: [
      { scope: "default" },
      { scope: "month", monthKey },
      { scope: { $in: ["date", "slot"] }, date },
    ],
  })
    .sort({ updatedAt: 1 })
    .lean();
}

async function loadBlocksForDate(date) {
  return ScheduleBlock.find({
    active: true,
    dateFrom: { $lte: date },
    $or: [
      { indefinite: true },
      { dateTo: { $gte: date } },
      { dateTo: "" },
      { dateTo: { $exists: false } },
    ],
  })
    .sort({ createdAt: -1 })
    .lean();
}

function activeBlockFor(blocks, date, time, sk) {
  return (
    blocks.find(
      (block) =>
        blockAppliesToService(block, sk) &&
        dateMatchesScheduleBlock(block, date) &&
        timeMatchesScheduleBlock(block, time)
    ) || null
  );
}

function appointmentZone(ap) {
  return clean(capacityGroupForService(serviceKey(ap?.serviceKey || ap?.service))).toUpperCase() || "NONE";
}

function countCurrentReservations(existing, sk) {
  const wanted = serviceKey(sk);
  const zone = clean(capacityGroupForService(wanted)).toUpperCase() || "NONE";

  const serviceReserved = existing.filter(
    (ap) => serviceKey(ap?.serviceKey || ap?.service) === wanted
  ).length;

  const zoneReserved =
    zone === "NONE"
      ? serviceReserved
      : existing.filter((ap) => appointmentZone(ap) === zone).length;

  return { serviceReserved, zoneReserved, zone };
}

async function loadCandidateUsers(selector, periodKey) {
  if (selector) {
    if (mongoose.Types.ObjectId.isValid(selector)) {
      const user = await User.findById(selector).lean();
      return user ? [user] : [];
    }

    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const user = await User.findOne({
      email: { $regex: `^${escaped}$`, $options: "i" },
    }).lean();

    return user ? [user] : [];
  }

  const cycles = await SubscriptionBillingCycle.find({
    periodKey,
    $or: [
      { "billing.status": { $in: ["pending", "overdue"] } },
      { "lifecycle.planStatus": { $in: ["suspended", "terminated"] } },
    ],
  })
    .select("user")
    .lean();

  const ids = [...new Set(cycles.map((row) => String(row.user)).filter(Boolean))];
  if (!ids.length) return [];

  return User.find({ _id: { $in: ids } })
    .sort({ email: 1, name: 1, lastName: 1 })
    .lean();
}

async function findPaidOrdersForUser(userId, bounds) {
  return Order.find({
    user: userId,
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
}

async function findReleasedSchedules(userId, sk, periodKey, cycle) {
  const snapshotIds = (
    Array.isArray(cycle?.planSnapshot?.fixedScheduleIds)
      ? cycle.planSnapshot.fixedScheduleIds
      : []
  ).map(String);

  const query = {
    user: userId,
    serviceKey: serviceKey(sk),
    active: false,
    $or: [
      { lastAutoReleasedMonthKey: periodKey },
      ...(snapshotIds.length
        ? [{ _id: { $in: snapshotIds.filter((id) => mongoose.Types.ObjectId.isValid(id)) } }]
        : []),
    ],
  };

  return FixedSchedule.find(query).sort({ createdAt: 1 }).lean();
}

async function buildServiceCandidate({
  user,
  subscription,
  cycle,
  orders,
  periodKey,
  now,
  horizonDays,
}) {
  const sk = serviceKey(subscription?.serviceKey || cycle?.serviceKey);

  const unpaidCycle = ["pending", "overdue"].includes(
    clean(cycle?.billing?.status).toLowerCase()
  );

  const blockedSubscription = ["suspended", "terminated_for_non_payment"].includes(
    clean(subscription?.status).toLowerCase()
  );

  const matches = [];

  for (const order of orders) {
    for (const item of orderItemsForService(order, sk)) {
      matches.push({
        order,
        item,
        match: scorePaidOrderMatch({ order, item, subscription, cycle }),
      });
    }
  }

  matches.sort((a, b) => {
    if (a.match.definitive !== b.match.definitive) {
      return a.match.definitive ? -1 : 1;
    }
    return b.match.score - a.match.score;
  });

  const definitiveMatches = matches.filter((entry) => entry.match.definitive);
  const coreMatches = matches.filter((entry) => entry.match.coreCompatible);

  const bootstrapMonthMatches =
    clean(subscription?.bootstrap?.monthKey) === periodKey;

  const bootstrapExpectedAmount =
    bootstrapMonthMatches
      ? money(subscription?.bootstrap?.latestPaidOrder?.amount)
      : 0;

  const cycleExpectedAmount = money(cycle?.billing?.total);

  // Para septiembre migrado priorizamos el snapshot histórico de la última
  // orden paga cuando pertenece al mismo período. Esto evita tomar como verdad
  // un billing.total viejo (por ejemplo 70.000 cuando septiembre era 75.000).
  const expectedPlanAmount =
    bootstrapExpectedAmount > 0
      ? bootstrapExpectedAmount
      : cycleExpectedAmount;

  const authoritativeAmountSource =
    bootstrapExpectedAmount > 0
      ? "BOOTSTRAP_LATEST_PAID_ORDER_AMOUNT"
      : "CYCLE_BILLING_TOTAL";

  // Cada orden se cuenta una sola vez. Para imputarla al ciclo debe ser del
  // mismo servicio y compatible con sesiones + medio de pago, o estar
  // vinculada de forma definitiva al ciclo/bootstrap.
  const compatibleByOrder = new Map();

  for (const entry of matches) {
    const compatible =
      entry.match.definitive || entry.match.coreCompatible;

    if (!compatible) continue;

    const orderId = idOf(entry.order);
    if (!orderId) continue;

    const itemAmount = money(entry.item?.price || entry.item?.basePrice);
    const orderAmount = money(
      entry.order?.totalFinal ?? entry.order?.total ?? entry.order?.price
    );

    const candidateAmount = itemAmount > 0 ? itemAmount : orderAmount;
    const existing = compatibleByOrder.get(orderId);

    if (!existing || candidateAmount > existing.amount) {
      compatibleByOrder.set(orderId, {
        orderId,
        paidAt: entry.order?.paidAt || entry.order?.createdAt || null,
        payMethod: clean(entry.order?.payMethod),
        amount: candidateAmount,
        kind: entry.item?.kind || "",
        credits: asInt(entry.item?.credits),
        definitive: Boolean(entry.match.definitive),
        coreCompatible: Boolean(entry.match.coreCompatible),
        score: entry.match.score,
      });
    }
  }

  const compatiblePayments = [...compatibleByOrder.values()].sort(
    (a, b) =>
      new Date(a.paidAt || 0).getTime() -
      new Date(b.paidAt || 0).getTime()
  );

  const amountReceivedForPlan = compatiblePayments.reduce(
    (sum, payment) => sum + money(payment.amount),
    0
  );

  const amountAppliedToPlan =
    expectedPlanAmount > 0
      ? Math.min(expectedPlanAmount, amountReceivedForPlan)
      : 0;

  const balanceDuePreview =
    expectedPlanAmount > 0
      ? Math.max(0, expectedPlanAmount - amountAppliedToPlan)
      : null;

  const excessPreview =
    expectedPlanAmount > 0
      ? Math.max(0, amountReceivedForPlan - expectedPlanAmount)
      : 0;

  const fullyPaidByAccumulation =
    expectedPlanAmount > 0 &&
    amountReceivedForPlan >= expectedPlanAmount;

  const partiallyPaidByAccumulation =
    expectedPlanAmount > 0 &&
    amountReceivedForPlan > 0 &&
    amountReceivedForPlan < expectedPlanAmount;

  let best = definitiveMatches[0] || coreMatches[0] || matches[0] || null;
  const strongPaymentMatch = fullyPaidByAccumulation;

  let paymentMatchReason = "NO_COMPATIBLE_PAID_ORDER";
  if (fullyPaidByAccumulation) {
    paymentMatchReason =
      compatiblePayments.length > 1
        ? "FULLY_PAID_BY_ACCUMULATED_ORDERS"
        : "FULLY_PAID_BY_COMPATIBLE_ORDER";
  } else if (partiallyPaidByAccumulation) {
    paymentMatchReason = "PARTIAL_PAYMENT_ACCUMULATED";
  } else if (expectedPlanAmount <= 0) {
    paymentMatchReason = "EXPECTED_PLAN_AMOUNT_NOT_RESOLVED";
  }

  const schedules = await findReleasedSchedules(
    user._id,
    sk,
    periodKey,
    cycle
  );

  const scheduleIds = schedules.map((schedule) => schedule._id);

  // V2: la evidencia principal para recuperar el mes actual son los appointments
  // que el lifecycle canceló explícitamente por falta de pago.
  // No dependemos de FixedSchedule.startDate/endDate porque esos rangos pueden
  // ser históricos mientras los appointments del rollover ya existen.
  const cancelledByLifecycle = scheduleIds.length
    ? await Appointment.find({
        user: user._id,
        serviceKey: sk,
        fixedScheduleId: { $in: scheduleIds },
        status: "cancelled",
        date: { $gte: now.ymd },
        cancelReason: /falta de pago|plan mensual/i,
      })
        .sort({ date: 1, time: 1 })
        .lean()
    : [];

  const futureCancelled = cancelledByLifecycle.filter(
    (appointment) =>
      !isPastSlot(
        clean(appointment?.date),
        clean(appointment?.time).slice(0, 5),
        now
      )
  );

  const claims = futureCancelled.map((appointment) => ({
    claimId: `${String(user._id)}:${sk}:${String(appointment.fixedScheduleId)}:${appointment.date}:${appointment.time}`,
    userId: String(user._id),
    email: clean(user?.email),
    name: userName(user),
    serviceKey: sk,
    subscriptionId: idOf(subscription),
    cycleId: idOf(cycle),
    fixedScheduleId: idOf(appointment?.fixedScheduleId),
    date: clean(appointment?.date),
    time: clean(appointment?.time).slice(0, 5),
    targetAppointmentId: idOf(appointment),
    action: "RESTORE_CANCELLED_APPOINTMENT",
    strongPaymentMatch,
  }));

  const scheduleRows = schedules.map((schedule) => ({
    fixedScheduleId: String(schedule._id),
    items: (schedule?.items || []).map((item) => ({
      weekday: Number(item?.weekday || 0),
      time: clean(item?.time),
    })),
    startDate: clean(schedule?.startDate),
    endDate: clean(schedule?.endDate),
    months: asInt(schedule?.months),
    lastGeneratedMonthKey: clean(schedule?.lastGeneratedMonthKey),
    lastCustodyMonthKey: clean(schedule?.lastCustodyMonthKey),
    lastAutoReleasedMonthKey: clean(schedule?.lastAutoReleasedMonthKey),
    deactivatedAt: schedule?.deactivatedAt || null,
  }));

  const lotId = idOf(cycle?.creditGrant?.lotId);

  const userCycleLot = lotId
    ? (Array.isArray(user?.creditLots) ? user.creditLots : []).find(
        (lot) => String(lot?._id || "") === lotId
      )
    : null;

  const creditAudit = {
    cycleGranted: Boolean(cycle?.creditGrant?.granted),
    grantedSessions: asInt(cycle?.creditGrant?.grantedSessions),
    lotId,
    invalidatedAt: cycle?.creditGrant?.invalidatedAt || null,
    invalidationReason: clean(cycle?.creditGrant?.invalidationReason),
    lotFoundOnUser: Boolean(userCycleLot),
    lotAmount: asInt(userCycleLot?.amount),
    lotRemainingNow: asInt(userCycleLot?.remaining),
    note:
      cycle?.creditGrant?.invalidatedAt
        ? "El lote fue invalidado por la baja. El APPLY deberá reconstruir solamente el saldo legítimo del ciclo, sin duplicar sesiones ya consumidas."
        : "El lote no figura invalidado en el ciclo.",
  };

  return {
    user: {
      id: String(user._id),
      name: userName(user),
      email: clean(user?.email),
    },
    serviceKey: sk,
    subscription: {
      id: idOf(subscription),
      status: clean(subscription?.status),
      autoRenew: Boolean(subscription?.autoRenew),
      monthlySessions: asInt(subscription?.monthlySessions),
      price: money(subscription?.price),
      payMethod: clean(subscription?.payMethod),
      fixedScheduleIds: (subscription?.fixedScheduleIds || []).map(String),
      bootstrap: {
        latestPaidOrderId: idOf(subscription?.bootstrap?.latestPaidOrder?.orderId),
        latestPaidOrderPaidAt: subscription?.bootstrap?.latestPaidOrder?.paidAt || null,
        latestPaidOrderSessions: asInt(subscription?.bootstrap?.latestPaidOrder?.sessions),
        latestPaidOrderAmount: money(subscription?.bootstrap?.latestPaidOrder?.amount),
        latestPaidOrderPayMethod: clean(subscription?.bootstrap?.latestPaidOrder?.payMethod),
        paidCredits: asInt(subscription?.bootstrap?.paidCredits),
        paidPayMethod: clean(subscription?.bootstrap?.paidPayMethod),
        paidPricingPlanId: idOf(subscription?.bootstrap?.paidPricingPlanId),
        monthKey: clean(subscription?.bootstrap?.monthKey),
      },
      terminatedAt: subscription?.terminatedAt || null,
      terminationReason: clean(subscription?.terminationReason),
      suspendedAt: subscription?.suspendedAt || null,
      suspensionReason: clean(subscription?.suspensionReason),
    },
    cycle: {
      id: idOf(cycle),
      periodKey: clean(cycle?.periodKey),
      billingStatus: clean(cycle?.billing?.status),
      billingTotal: money(cycle?.billing?.total),
      billingOrder: idOf(cycle?.billing?.order),
      lifecycleStatus: clean(cycle?.lifecycle?.planStatus),
      terminatedAt: cycle?.lifecycle?.terminatedAt || null,
      terminationReason: clean(cycle?.lifecycle?.terminationReason),
    },
    unpaidCycle,
    blockedSubscription,
    paymentMatch: {
      strong: strongPaymentMatch,
      reason: paymentMatchReason,
      expectedPlanAmount,
      authoritativeAmountSource,
      cycleBillingTotal: cycleExpectedAmount,
      bootstrapExpectedAmount,
      amountReceivedForPlan,
      amountAppliedToPlan,
      balanceDuePreview,
      excessPreview,
      fullyPaidByAccumulation,
      partiallyPaidByAccumulation,
      compatiblePayments,
      bestEvidence: best
        ? {
            score: best.match.score,
            orderId: idOf(best.order),
            orderPaidAt: best.order?.paidAt || best.order?.createdAt || null,
            orderTotal: money(
              best.order?.totalFinal ?? best.order?.total ?? best.order?.price
            ),
            orderPayMethod: clean(best.order?.payMethod),
            item: best.item,
            checks: best.match,
          }
        : null,
    },
    strongPaymentMatch,
    paymentMatchReason,
    releasedFixedSchedules: scheduleRows,
    lifecycleCancelledFutureAppointments: futureCancelled.map((appointment) => ({
      appointmentId: idOf(appointment),
      fixedScheduleId: idOf(appointment?.fixedScheduleId),
      date: clean(appointment?.date),
      time: clean(appointment?.time),
      cancelReason: clean(appointment?.cancelReason),
      cancelledAt: appointment?.cancelledAt || null,
    })),
    creditAudit,
    claims,
    paymentLedgerPreview: {
      expectedPlanAmount,
      authoritativeAmountSource,
      cycleBillingTotal: cycleExpectedAmount,
      bootstrapExpectedAmount,
      amountReceivedForPlan,
      amountAppliedToPlan,
      balanceDuePreview,
      excessPreview,
      fullyPaid: fullyPaidByAccumulation,
      partial: partiallyPaidByAccumulation,
      compatiblePayments,
      cycleTotalNeedsCorrection:
        expectedPlanAmount > 0 &&
        cycleExpectedAmount > 0 &&
        expectedPlanAmount !== cycleExpectedAmount,
    },
    repairEligibleBase:
      unpaidCycle &&
      blockedSubscription &&
      strongPaymentMatch &&
      schedules.length > 0,
  };
}

async function evaluateClaims(candidates, now) {
  const allClaims = candidates
    .filter((candidate) => candidate.repairEligibleBase)
    .flatMap((candidate) => candidate.claims);

  const slotKeys = [...new Set(allClaims.map((claim) => `${claim.date}|${claim.time}`))];
  const slotStates = new Map();

  for (const slotKey of slotKeys) {
    const [date, time] = slotKey.split("|");

    const [existing, rules, blocks] = await Promise.all([
      Appointment.find({ date, time, status: "reserved" })
        .select("user serviceKey service fixedScheduleId date time status")
        .lean(),
      loadCapacityRulesForDate(date),
      loadBlocksForDate(date),
    ]);

    slotStates.set(slotKey, { date, time, existing, rules, blocks });
  }

  const evaluated = [];

  for (const claim of allClaims) {
    const slotKey = `${claim.date}|${claim.time}`;
    const state = slotStates.get(slotKey);
    const allowedTimes = allowedTimesForService(claim.serviceKey, claim.date);
    const timeAllowed = allowedTimes.includes(claim.time);

    const block = activeBlockFor(
      state.blocks,
      claim.date,
      claim.time,
      claim.serviceKey
    );

    const duplicateUserReservation = state.existing.find(
      (ap) => String(ap?.user || "") === claim.userId
    );

    const capacity = resolveCapacity(
      state.rules,
      claim.serviceKey,
      claim.date,
      claim.time
    );

    const currentCounts = countCurrentReservations(
      state.existing,
      claim.serviceKey
    );

    evaluated.push({
      ...claim,
      timeAllowed,
      blocked: Boolean(block),
      blockId: idOf(block),
      blockReason: clean(block?.reason || block?.title),
      duplicateUserReservationId: idOf(duplicateUserReservation),
      capacity,
      currentCounts,
    });
  }

  // Simulación conjunta: todos los candidatos fuertes intentan volver al mismo tiempo.
  for (const claim of evaluated) {
    const sameSlot = evaluated.filter(
      (other) => other.date === claim.date && other.time === claim.time
    );

    const zoneClaims = sameSlot.filter(
      (other) => other.capacity.zone === claim.capacity.zone
    );

    const serviceClaims = sameSlot.filter(
      (other) => other.serviceKey === claim.serviceKey
    );

    const zoneAfter =
      claim.currentCounts.zoneReserved + zoneClaims.length;

    const serviceAfter =
      claim.currentCounts.serviceReserved + serviceClaims.length;

    const zoneSafe = zoneAfter <= claim.capacity.zoneLimit;
    const serviceSafe =
      claim.capacity.serviceLimit == null ||
      serviceAfter <= claim.capacity.serviceLimit;

    const safe =
      claim.timeAllowed &&
      !claim.blocked &&
      !claim.duplicateUserReservationId &&
      zoneSafe &&
      serviceSafe;

    claim.batchSimulation = {
      claimsSameZoneSlot: zoneClaims.length,
      claimsSameServiceSlot: serviceClaims.length,
      zoneReservedNow: claim.currentCounts.zoneReserved,
      zoneLimit: claim.capacity.zoneLimit,
      zoneAfterRepair: zoneAfter,
      serviceReservedNow: claim.currentCounts.serviceReserved,
      serviceLimit: claim.capacity.serviceLimit,
      serviceAfterRepair: serviceAfter,
      zoneSafe,
      serviceSafe,
      safe,
      reason: !claim.timeAllowed
        ? "HORARIO_NO_HABILITADO"
        : claim.blocked
          ? "AGENDA_BLOQUEADA"
          : claim.duplicateUserReservationId
            ? "USUARIO_YA_TIENE_RESERVA_EN_ESE_HORARIO"
            : !zoneSafe
              ? "SOBRECUPO_DE_ZONA_EN_REPARACION_MASIVA"
              : !serviceSafe
                ? "SOBRECUPO_DEL_SERVICIO_EN_REPARACION_MASIVA"
                : "APTO",
    };
  }

  return evaluated;
}

function compactCandidate(candidate, evaluatedClaims) {
  const claims = evaluatedClaims.filter(
    (claim) =>
      claim.userId === candidate.user.id &&
      claim.serviceKey === candidate.serviceKey &&
      candidate.claims.some((own) => own.claimId === claim.claimId)
  );

  const safeClaims = claims.filter((claim) => claim.batchSimulation?.safe);
  const unsafeClaims = claims.filter((claim) => !claim.batchSimulation?.safe);

  let decision = "NO_AUTO_REPAIR";

  if (candidate.repairEligibleBase) {
    if (!claims.length) {
      decision = "REVIEW_NO_CANCELLED_FUTURE_APPOINTMENTS";
    } else if (!unsafeClaims.length) {
      decision = "READY_FOR_APPLY";
    } else {
      decision = "MANUAL_REVIEW_CAPACITY_CONFLICT";
    }
  } else if (!candidate.strongPaymentMatch) {
    decision = "REVIEW_PAYMENT_MATCH";
  } else if (!candidate.releasedFixedSchedules.length) {
    decision = "REVIEW_NO_RELEASED_FIXED_SCHEDULE";
  }

  return {
    ...candidate,
    claims,
    safeClaimsCount: safeClaims.length,
    unsafeClaimsCount: unsafeClaims.length,
    unsafeClaims: unsafeClaims.map((claim) => ({
      date: claim.date,
      time: claim.time,
      fixedScheduleId: claim.fixedScheduleId,
      targetAppointmentId: claim.targetAppointmentId,
      reason: claim.batchSimulation?.reason,
      zoneReservedNow: claim.batchSimulation?.zoneReservedNow,
      zoneLimit: claim.batchSimulation?.zoneLimit,
      zoneAfterRepair: claim.batchSimulation?.zoneAfterRepair,
      serviceReservedNow: claim.batchSimulation?.serviceReservedNow,
      serviceLimit: claim.batchSimulation?.serviceLimit,
      serviceAfterRepair: claim.batchSimulation?.serviceAfterRepair,
      blockReason: claim.blockReason,
      duplicateUserReservationId: claim.duplicateUserReservationId,
    })),
    decision,
  };
}

async function main() {
  const { selector, periodKey, horizonDays } = parseArgs();
  const uri = process.env.MONGO_URI;

  if (!uri) throw new Error("Falta MONGO_URI en .env");

  const bounds = periodBounds(periodKey);
  const now = nowArgentina();

  await mongoose.connect(uri);

  try {
    await ensureServiceCatalogLoaded({ force: true });

    const users = await loadCandidateUsers(selector, periodKey);

    if (!users.length) {
      console.log("No se encontraron usuarios candidatos.");
      return;
    }

    const candidates = [];

    for (const user of users) {
      const [subscriptions, cycles, orders] = await Promise.all([
        ServiceSubscription.find({
          user: user._id,
          status: { $in: ["suspended", "terminated_for_non_payment"] },
        }).lean(),

        SubscriptionBillingCycle.find({
          user: user._id,
          periodKey,
          $or: [
            { "billing.status": { $in: ["pending", "overdue"] } },
            { "lifecycle.planStatus": { $in: ["suspended", "terminated"] } },
          ],
        }).lean(),

        findPaidOrdersForUser(user._id, bounds),
      ]);

      for (const cycle of cycles) {
        const subscription = subscriptions.find(
          (sub) => String(sub._id) === String(cycle.subscription)
        );

        if (!subscription) continue;

        const candidate = await buildServiceCandidate({
          user,
          subscription,
          cycle,
          orders,
          periodKey,
          now,
          horizonDays,
        });

        candidates.push(candidate);
      }
    }

    const evaluatedClaims = await evaluateClaims(candidates, now);
    const rows = candidates.map((candidate) =>
      compactCandidate(candidate, evaluatedClaims)
    );

    const ready = rows.filter((row) => row.decision === "READY_FOR_APPLY");
    const conflict = rows.filter(
      (row) => row.decision === "MANUAL_REVIEW_CAPACITY_CONFLICT"
    );
    const paymentReview = rows.filter(
      (row) => row.decision === "REVIEW_PAYMENT_MATCH"
    );

    console.log("\n" + "=".repeat(110));
    console.log(`PREVIEW V3 REPARACIÓN SUSCRIPCIONES / TURNOS FIJOS · ${periodKey}`);
    console.log("SOLO LECTURA - NO MODIFICA MONGODB");
    console.log("=".repeat(110));

    for (const row of rows) {
      if (
        !row.strongPaymentMatch &&
        !row.releasedFixedSchedules.length &&
        !row.blockedSubscription
      ) {
        continue;
      }

      console.log(
        `\n${row.user.email || "(sin email)"} | ${row.user.name} | ${row.serviceKey}`
      );
      console.log(
        `  Estado: subscription=${row.subscription.status} | cycle billing=${row.cycle.billingStatus} lifecycle=${row.cycle.lifecycleStatus}`
      );
      console.log(
        `  Pago ciclo: esperado=$${row.paymentLedgerPreview.expectedPlanAmount} | recibido=$${row.paymentLedgerPreview.amountReceivedForPlan} | aplicado=$${row.paymentLedgerPreview.amountAppliedToPlan} | pendiente=$${row.paymentLedgerPreview.balanceDuePreview ?? "-"} | ${row.paymentMatchReason}`
      );
      if (row.paymentLedgerPreview.cycleTotalNeedsCorrection) {
        console.log(
          `  ! billing.total actual=$${row.paymentLedgerPreview.cycleBillingTotal} difiere del histórico esperado=$${row.paymentLedgerPreview.expectedPlanAmount}`
        );
      }
      console.log(
        `  Fijos liberados: ${row.releasedFixedSchedules.length} | ocurrencias futuras analizadas: ${row.claims.length}`
      );
      console.log(
        `  Cupo restauración: ${row.safeClaimsCount} aptas / ${row.unsafeClaimsCount} con conflicto`
      );
      console.log(`  DECISIÓN PREVIEW: ${row.decision}`);

      for (const issue of row.unsafeClaims.slice(0, 8)) {
        console.log(
          `    ! ${issue.date} ${issue.time} -> ${issue.reason}` +
          (issue.blockReason ? ` (${issue.blockReason})` : "")
        );
      }

      if (row.unsafeClaims.length > 8) {
        console.log(`    ... +${row.unsafeClaims.length - 8} conflictos`);
      }

      if (row.creditAudit.invalidatedAt) {
        console.log(
          `  Créditos: lote ${row.creditAudit.lotId || "(sin id)"} invalidado | granted=${row.creditAudit.grantedSessions} | remaining ahora=${row.creditAudit.lotRemainingNow}`
        );
      }
    }

    const summary = {
      periodKey,
      usersAudited: users.length,
      serviceCandidates: rows.length,
      strongPaymentMatches: rows.filter((row) => row.strongPaymentMatch).length,
      partialPayments: rows.filter(
        (row) => row.paymentLedgerPreview?.partial
      ).length,
      cycleTotalsNeedingCorrection: rows.filter(
        (row) => row.paymentLedgerPreview?.cycleTotalNeedsCorrection
      ).length,
      readyForApply: ready.length,
      capacityConflict: conflict.length,
      paymentNeedsReview: paymentReview.length,
      futureClaimsAnalyzed: evaluatedClaims.length,
      futureClaimsSafe: evaluatedClaims.filter(
        (claim) => claim.batchSimulation?.safe
      ).length,
      futureClaimsUnsafe: evaluatedClaims.filter(
        (claim) => !claim.batchSimulation?.safe
      ).length,
    };

    const output = {
      readOnly: true,
      generatedAt: new Date().toISOString(),
      periodKey,
      selector: selector || null,
      horizonDays,
      summary,
      rows,
    };

    const outDir = path.resolve(
      process.cwd(),
      "backups",
      "subscription-audits"
    );

    fs.mkdirSync(outDir, { recursive: true });

    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-");

    const outPath = path.join(
      outDir,
      `repair-preview-v3-${periodKey}-${stamp}.json`
    );

    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf8");

    console.log("\n" + "=".repeat(110));
    console.log("RESUMEN");
    console.log(JSON.stringify(summary, null, 2));
    console.log(`Reporte JSON: ${outPath}`);
    console.log("NO SE MODIFICÓ NINGÚN DATO.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async (error) => {
  console.error("\nPREVIEW ERROR:", error?.stack || error?.message || error);

  try {
    await mongoose.disconnect();
  } catch {}

  process.exit(1);
});
