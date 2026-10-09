import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import Appointment from "../../models/Appointment.js";
import FixedSchedule from "../../models/FixedSchedule.js";
import FixedScheduleRenewal, { FixedScheduleRenewalLock } from "../../models/FixedScheduleRenewal.js";
import ScheduleBlock from "../../models/ScheduleBlock.js";
import CapacityRule from "../../models/CapacityRule.js";
import ServiceSubscription from "../../models/ServiceSubscription.js";
import User from "../../models/User.js";
import { sendFixedScheduleRenewalEmail } from "../../mail/fixedScheduleRenewalEmails.js";
import {
  ensureServiceCatalogLoaded, serviceDefinitionCached, normalizeCatalogServiceKey,
  serviceNameForKey, capacityGroupForService, isWeekdayTimeAllowedForService,
} from "../serviceCatalogRuntime.js";
import { buildFixedOccurrencesForMonth, monthRangeFromKey } from "./fixedScheduleCoverage.js";

// Se decide por configuración explícita, no por el nombre comercial ni por
// ausencia de una suscripción. EP/RF/SYN recurrentes conservan su flujo.
export function isStandaloneFixedService(value) {
  const service = serviceDefinitionCached(value);
  return service?.active === true && service.fixedScheduleEnabled === true &&
    service.recurringPlanEnabled === false;
}

export function capacityAvailable({ rules, appointments, serviceKey, date, time }) {
  const group = capacityGroupForService(serviceKey);
  const priority = { default: 0, month: 1, date: 2, slot: 3 };
  const applicable = rules.filter(rule => rule.active !== false && (
    rule.scope === "default" ||
    (rule.scope === "month" && rule.monthKey === date.slice(0, 7)) ||
    (rule.scope === "date" && rule.date === date) ||
    (rule.scope === "slot" && rule.date === date && rule.time === time)
  )).sort((a, b) => (priority[b.scope] - priority[a.scope]) ||
    (new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)));
  const zoneRule = applicable.find(r => r.targetType === "zone" && r.zone === group);
  const serviceRule = applicable.find(r => r.targetType === "service" &&
    normalizeCatalogServiceKey(r.serviceKey) === serviceKey);
  const zoneLimit = zoneRule ? Math.max(0, Number(zoneRule.limit)) :
    ({ TRAINING: 12, PERFORMANCE: 8 }[group] ?? Infinity);
  const serviceLimit = serviceRule ? Math.max(0, Number(serviceRule.limit)) : Infinity;
  const sameService = appointments.filter(ap =>
    normalizeCatalogServiceKey(ap.serviceKey || ap.service) === serviceKey).length;
  const sameGroup = appointments.filter(ap =>
    capacityGroupForService(ap.serviceKey || ap.service) === group).length;
  return sameService < serviceLimit && (group === "NONE" || sameGroup < zoneLimit);
}

async function generateGroup({ userId, serviceKey, periodKey, now }) {
  const id = `${userId}:${serviceKey}:${periodKey}`;
  // Creación fuera de la transacción: _id resuelve carreras en el primer tick.
  try {
    await FixedScheduleRenewal.updateOne({ _id: id }, {
      $setOnInsert: { user: userId, serviceKey, periodKey },
    }, { upsert: true });
  } catch (error) { if (error?.code !== 11000) throw error; }
  try {
    await FixedScheduleRenewalLock.updateOne({ _id: "generation" }, {
      $setOnInsert: { revision: 0 },
    }, { upsert: true });
  } catch (error) { if (error?.code !== 11000) throw error; }
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = { id, userId: String(userId), serviceKey, created: 0, blocked: 0,
        unresolved: [], appointments: [], ready: false };
      await FixedScheduleRenewalLock.updateOne({ _id: "generation" }, {
        $inc: { revision: 1 },
      }, { session });
      // Serializa los reintentos del mismo usuario/servicio/mes. El snapshot
      // se vuelve a leer si Mongo reintenta la transacción.
      await FixedScheduleRenewal.updateOne({ _id: id }, {
        $inc: { revision: 1 }, $set: { generatedAt: null },
      }, { session });
      const range = monthRangeFromKey(periodKey);
      const user = await User.findById(userId).session(session).lean();
      if (!user) { result.unresolved.push("USER_NOT_FOUND"); return; }
      // No reactivar bajas administrativas ni suscripciones legacy bloqueadas.
      const blockedSubscription = await ServiceSubscription.findOne({ user: userId,
        serviceKey, status: { $in: ["suspended", "cancelled", "terminated_for_non_payment"] },
      }).session(session).lean();
      if (blockedSubscription) { result.unresolved.push("LEGACY_SUBSCRIPTION_BLOCKED"); return; }
      const schedules = await FixedSchedule.find({ user: userId, serviceKey, active: true,
        startDate: { $lte: range.endYmd },
      }).session(session).lean();
      const blocks = await ScheduleBlock.find({ active: true,
        dateFrom: { $lte: range.endYmd },
      }).session(session).lean();
      const rules = await CapacityRule.find({ active: true }).session(session).lean();
      const generated = buildFixedOccurrencesForMonth({
        schedules: schedules.map(s => ({ ...s, endDate: range.endYmd })),
        blocks, monthKey: periodKey, serviceKey,
      });
      result.blocked = generated.blockedOccurrences.length;
      for (const occ of generated.occurrences) {
        const same = await Appointment.findOne({ user: userId, serviceKey,
          fixedScheduleId: { $in: schedules.map(s => s._id) },
          date: occ.date, time: occ.time,
          status: { $in: ["reserved", "completed", "cancelled"] },
        }).session(session).lean();
        if (same) {
          if (same.status !== "cancelled") result.appointments.push(same);
          continue; // Nunca recrear una cancelación ni debitar dos veces.
        }
        if (new Date(`${occ.date}T${occ.time}:00-03:00`) <= now) {
          result.unresolved.push(`MISSED_SLOT:${occ.date}:${occ.time}`);
          continue;
        }
        if (!isWeekdayTimeAllowedForService(serviceKey, occ.weekday, occ.time)) {
          result.unresolved.push(`OUTSIDE_SERVICE_HOURS:${occ.date}:${occ.time}`);
          continue;
        }
        const existing = await Appointment.find({ date: occ.date, time: occ.time,
          status: "reserved",
        }).session(session).lean();
        if (existing.some(ap => String(ap.user) === String(userId)) ||
            !capacityAvailable({ rules, appointments: existing, serviceKey, ...occ })) {
          result.unresolved.push(`SLOT_UNAVAILABLE:${occ.date}:${occ.time}`);
          continue;
        }
        const [ap] = await Appointment.create([{
          user: userId, serviceKey, service: serviceNameForKey(serviceKey),
          date: occ.date, time: occ.time, status: "reserved",
          fixedScheduleId: occ.fixedScheduleId, monthlyRolloverMonthKey: periodKey,
          createdByRole: "admin", assignedManually: true,
          creditDebitStatus: "pending", fixedDebtAmount: 0,
          notes: "Renovación mensual de turno fijo sin plan recurrente.",
        }], { session });
        result.created += 1;
        result.appointments.push(ap.toObject());
      }
      result.ready = result.unresolved.length === 0 && result.appointments.length > 0;
      if (result.ready) await FixedScheduleRenewal.updateOne({ _id: id }, {
        $set: { generatedAt: now, lastError: "" },
      }, { session });
    });
    return result;
  } finally { await session.endSession(); }
}

export async function sendFixedRenewalOnce(result, now = new Date()) {
  if (!result.ready) return { sent: false, skipped: true, reason: "GENERATION_INCOMPLETE_OR_EMPTY" };
  const token = randomUUID();
  const claimed = await FixedScheduleRenewal.findOneAndUpdate({
    _id: result.id, sentAt: null, generatedAt: { $ne: null },
    $or: [{ sendingAt: null }, { sendingAt: { $lt: new Date(now.getTime() - 15 * 60_000) } }],
  }, { $set: { sendingAt: now, sendToken: token } }, { new: true }).lean();
  if (!claimed) return { sent: false, skipped: true, reason: "SENT_OR_IN_PROGRESS" };
  const owned = { _id: result.id, sendToken: token, sentAt: null };
  try {
    const user = await User.findById(claimed.user).lean();
    if (!user) throw new Error("USER_NOT_FOUND");
    const mail = await sendFixedScheduleRenewalEmail({ user,
      serviceName: serviceNameForKey(claimed.serviceKey), periodKey: claimed.periodKey,
      appointments: result.appointments.sort((a, b) =>
        `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)),
    });
    if (!mail?.sent) throw new Error(mail?.reason || "EMAIL_NOT_SENT");
    await FixedScheduleRenewal.updateOne(owned, { $set: {
      sentAt: new Date(), sendingAt: null, sendToken: "", lastError: "",
    } });
    return { sent: true };
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    await FixedScheduleRenewal.updateOne(owned, { $set: {
      sendingAt: null, sendToken: "", lastError: message,
    } });
    return { sent: false, error: message };
  }
}

export async function renewStandaloneFixedSchedules({ periodKey, now = new Date() }) {
  await ensureServiceCatalogLoaded();
  const range = monthRangeFromKey(periodKey);
  const schedules = await FixedSchedule.find({ active: true,
    startDate: { $lte: range.endYmd },
  }).lean();
  const targets = new Map();
  for (const schedule of schedules) {
    const serviceKey = normalizeCatalogServiceKey(schedule.serviceKey || schedule.service);
    if (schedule.user && isStandaloneFixedService(serviceKey)) targets.set(
      `${schedule.user}:${serviceKey}`, { userId: schedule.user, serviceKey });
  }
  const results = [];
  for (const target of targets.values()) {
    try {
      const generated = await generateGroup({ ...target, periodKey, now });
      const email = await sendFixedRenewalOnce(generated, now);
      const { appointments, ...summary } = generated;
      results.push({ ...summary, email, appointmentsCount: appointments.length });
    } catch (error) {
      results.push({ userId: String(target.userId), serviceKey: target.serviceKey,
        error: String(error?.message || error) });
    }
  }
  return { ok: results.every(r => !r.error && !r.unresolved?.length && !r.email?.error), results };
}
