// backend/src/jobs/fixedScheduleBilling.js
import mongoose from "mongoose";
import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import FixedSchedule from "../models/FixedSchedule.js";
import { fireAndForget } from "../mail.js";
import { sendAdminFixedScheduleDebtSummaryEmail } from "../mail/creditsEmails.js";

const TZ = "America/Argentina/Buenos_Aires";
const FIXED_SERVICE_KEYS = ["EP", "RA", "RF", "KD"];
const SERVICE_KEY_TO_NAME = {
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
};

let schedulerStarted = false;
let schedulerTimer = null;
let weeklySummaryTimer = null;

function pad2(n) { return String(n).padStart(2, "0"); }
function normalizeServiceKey(value) {
  const sk = String(value || "").toUpperCase().trim();
  if (sk === "AR") return "RA";
  if (sk === "KINEDEPO" || sk === "KINE-DEPO") return "KD";
  return FIXED_SERVICE_KEYS.includes(sk) ? sk : "";
}
function arParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { year: Number(map.year), month: Number(map.month), day: Number(map.day), hour: Number(map.hour), minute: Number(map.minute), second: Number(map.second) };
}
function ymdFromParts(p) { return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`; }
function hmFromParts(p) { return `${pad2(p.hour)}:${pad2(p.minute)}`; }
function monthKeyFromParts(p) { return `${p.year}-${pad2(p.month)}`; }
function slotDue(date, time, now = new Date()) {
  const p = arParts(now);
  const today = ymdFromParts(p);
  const currentHm = hmFromParts(p);
  const d = String(date || "").slice(0,10);
  const t = String(time || "").slice(0,5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{2}:\d{2}$/.test(t)) return false;
  if (d < today) return true;
  if (d > today) return false;
  return t <= currentHm;
}
function activeLots(user, serviceKey) {
  const now = new Date();
  const sk = normalizeServiceKey(serviceKey);
  return (Array.isArray(user?.creditLots) ? user.creditLots : [])
    .filter((l) => normalizeServiceKey(l?.serviceKey || l?.service || l?.serviceName) === sk)
    .filter((l) => Number(l?.remaining || 0) > 0)
    .filter((l) => !l?.expiresAt || new Date(l.expiresAt) > now)
    .sort((a,b) => {
      const ae = a?.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
      const be = b?.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
      if (ae !== be) return ae - be;
      return new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime();
    });
}
function recalcCredits(user) {
  const now = new Date();
  user.credits = (Array.isArray(user?.creditLots) ? user.creditLots : []).reduce((acc, lot) => {
    const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return acc;
    return acc + Math.max(0, Number(lot?.remaining || 0));
  }, 0);
}
function ensureDebt(user) {
  user.fixedScheduleDebt = user.fixedScheduleDebt || {};
  for (const k of FIXED_SERVICE_KEYS) {
    const n = Number(user.fixedScheduleDebt?.[k] || 0);
    user.fixedScheduleDebt[k] = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  }
}
function serviceName(sk) { return SERVICE_KEY_TO_NAME[sk] || sk; }

async function processAppointment(apId, now = new Date()) {
  const session = await mongoose.startSession();
  try {
    let result = null;
    await session.withTransaction(async () => {
      const ap = await Appointment.findOne({ _id: apId, fixedDebitProcessedAt: null }).session(session);
      if (!ap) return;
      if (!ap.fixedScheduleId) return;
      if (String(ap.status || "") === "cancelled") {
        ap.fixedDebitProcessedAt = now;
        ap.creditDebitStatus = "skipped";
        await ap.save({ session });
        result = { ok: true, skipped: true, reason: "CANCELLED" };
        return;
      }
      if (!slotDue(ap.date, ap.time, now)) return;

      const sk = normalizeServiceKey(ap.serviceKey || ap.service);
      if (!sk) {
        ap.fixedDebitProcessedAt = now;
        ap.creditDebitStatus = "skipped";
        await ap.save({ session });
        result = { ok: false, skipped: true, reason: "INVALID_SERVICE" };
        return;
      }

      const user = await User.findById(ap.user).session(session);
      if (!user) throw new Error("USER_NOT_FOUND");
      ensureDebt(user);
      user.history = Array.isArray(user.history) ? user.history : [];

      const lot = activeLots(user, sk)[0] || null;
      if (lot) {
        lot.remaining = Math.max(0, Number(lot.remaining || 0) - 1);
        ap.creditLotId = lot._id || ap.creditLotId || null;
        ap.creditExpiresAt = lot.expiresAt || ap.creditExpiresAt || null;
        ap.creditDebitStatus = "debited";
        ap.creditDebitedAt = now;
        ap.fixedDebtAmount = 0;
        user.history.push({
          action: "fixed_schedule_credit_debited",
          title: `Turno fijo debitado ${sk}`,
          message: `Se debitó 1 crédito por turno fijo de ${serviceName(sk)} (${ap.date} ${ap.time} hs).`,
          date: ap.date,
          time: ap.time,
          serviceKey: sk,
          serviceName: serviceName(sk),
          service: serviceName(sk),
          qty: -1,
          createdAt: now,
        });
        result = { ok: true, status: "debited", serviceKey: sk };
      } else {
        user.fixedScheduleDebt[sk] = Math.max(0, Number(user.fixedScheduleDebt[sk] || 0)) + 1;
        user.markModified?.("fixedScheduleDebt");
        ap.creditDebitStatus = "debt";
        ap.creditDebitedAt = null;
        ap.fixedDebtAmount = 1;
        user.history.push({
          action: "fixed_schedule_debt_created",
          title: `Deuda por turno fijo ${sk}`,
          message: `El turno fijo de ${serviceName(sk)} (${ap.date} ${ap.time} hs) llegó sin crédito disponible. Se generó deuda de 1 sesión.`,
          date: ap.date,
          time: ap.time,
          serviceKey: sk,
          serviceName: serviceName(sk),
          service: serviceName(sk),
          qty: -1,
          createdAt: now,
        });
        result = { ok: true, status: "debt", serviceKey: sk };
      }

      ap.status = "completed";
      ap.completedAt = ap.completedAt || now;
      ap.fixedDebitProcessedAt = now;
      recalcCredits(user);
      await user.save({ session });
      await ap.save({ session });
    });
    return result || { ok: true, skipped: true, reason: "NOT_FOUND_OR_NOT_DUE" };
  } finally {
    await session.endSession();
  }
}

export async function runFixedScheduleBillingTick({ limit = 300 } = {}) {
  const now = new Date();
  const p = arParts(now);
  const today = ymdFromParts(p);
  const candidates = await Appointment.find({
    fixedScheduleId: { $ne: null },
    fixedDebitProcessedAt: null,
    status: { $in: ["reserved", "completed", "cancelled"] },
    date: { $lte: today },
  }).sort({ date: 1, time: 1 }).limit(limit).select("_id date time status").lean();

  let checked = 0, debited = 0, debt = 0, skipped = 0;
  for (const ap of candidates) {
    if (!slotDue(ap.date, ap.time, now)) continue;
    checked += 1;
    try {
      const r = await processAppointment(ap._id, now);
      if (r?.status === "debited") debited += 1;
      else if (r?.status === "debt") debt += 1;
      else skipped += 1;
    } catch (e) {
      skipped += 1;
      console.log("[FIXED BILLING] appointment error", { apId: String(ap._id), error: e?.message || e });
    }
  }
  const out = { ok: true, checked, debited, debt, skipped, today };
  console.log("[FIXED BILLING] tick", out);
  return out;
}

export async function releaseUnpaidFixedSchedules({ now = new Date(), force = false } = {}) {
  const p = arParts(now);
  if (!force && p.day < 8) return { ok: true, skipped: true, reason: "GRACE_WEEK", day: p.day };

  const monthKey = monthKeyFromParts(p);
  const today = ymdFromParts(p);
  const debtUsers = await User.find({
    $or: FIXED_SERVICE_KEYS.map((k) => ({ [`fixedScheduleDebt.${k}`]: { $gt: 0 } })),
  }).select("_id fixedScheduleDebt history monthlyAutomation");

  let schedulesPaused = 0, appointmentsCancelled = 0, usersTouched = 0;
  for (const user of debtUsers) {
    user.monthlyAutomation = user.monthlyAutomation || {};
    if (!force && user.monthlyAutomation.lastFixedDebtReleaseMonthKey === monthKey) continue;

    const schedules = await FixedSchedule.find({ user: user._id, active: true });
    const scheduleIds = schedules.map((s) => s._id);
    if (scheduleIds.length) {
      const upd = await Appointment.updateMany({
        user: user._id,
        fixedScheduleId: { $in: scheduleIds },
        status: "reserved",
        date: { $gte: today },
      }, {
        $set: {
          status: "cancelled",
          cancelledAt: now,
          cancelReason: "Liberado automáticamente por deuda de turnos fijos al finalizar la primera semana del mes.",
          refundApplied: false,
          refundMode: "none",
          creditDebitStatus: "skipped",
          fixedDebitProcessedAt: now,
        },
      });
      appointmentsCancelled += Number(upd?.modifiedCount || 0);
    }

    for (const schedule of schedules) {
      schedule.active = false;
      schedule.deactivatedAt = now;
      schedule.notes = schedule.notes
        ? `${schedule.notes}\nPausado automáticamente por deuda de turnos fijos (${monthKey}).`
        : `Pausado automáticamente por deuda de turnos fijos (${monthKey}).`;
      await schedule.save();
      schedulesPaused += 1;
    }

    user.history = Array.isArray(user.history) ? user.history : [];
    user.history.push({
      action: "fixed_schedule_auto_released_unpaid",
      title: "Turnos fijos liberados por deuda",
      message: "Al iniciar la segunda semana del mes seguía habiendo sesiones adeudadas. Se liberaron los próximos turnos fijos reservados.",
      createdAt: now,
    });
    user.monthlyAutomation.lastFixedDebtReleaseMonthKey = monthKey;
    await user.save();
    usersTouched += 1;
  }
  const out = { ok: true, monthKey, usersTouched, schedulesPaused, appointmentsCancelled };
  console.log("[FIXED BILLING] release unpaid", out);
  return out;
}

export async function sendWeeklyFixedDebtSummary({ force = false, now = new Date() } = {}) {
  const p = arParts(now);
  const configuredDow = Math.max(0, Math.min(6, Number(process.env.FIXED_DEBT_SUMMARY_DOW ?? 1))); // JS Sunday=0, Monday=1
  const configuredHour = Math.max(0, Math.min(23, Number(process.env.FIXED_DEBT_SUMMARY_HOUR ?? 9)));
  const jsDow = new Date(now.toLocaleString("en-US", { timeZone: TZ })).getDay();
  if (!force && (jsDow !== configuredDow || p.hour !== configuredHour)) {
    return { ok: true, skipped: true, reason: "OUTSIDE_SUMMARY_WINDOW" };
  }
  const monthKey = monthKeyFromParts(p);
  const users = await User.find({
    $or: FIXED_SERVICE_KEYS.map((k) => ({ [`fixedScheduleDebt.${k}`]: { $gt: 0 } })),
  }).select("name lastName email fixedScheduleDebt notifications").lean();

  const rows = users.map((u) => ({
    userId: String(u._id),
    name: `${u.name || ""} ${u.lastName || ""}`.trim() || u.email || "Usuario",
    email: u.email || "-",
    debt: Object.fromEntries(FIXED_SERVICE_KEYS.map((k) => [k, Math.max(0, Number(u?.fixedScheduleDebt?.[k] || 0))])),
  })).filter((r) => Object.values(r.debt).some((n) => n > 0));

  if (!rows.length) return { ok: true, sent: false, reason: "NO_DEBT" };
  await sendAdminFixedScheduleDebtSummaryEmail(rows, { monthKey });
  return { ok: true, sent: true, rows: rows.length, monthKey };
}

export function startFixedScheduleBillingScheduler({ everyMinutes = 2, weeklySummaryEveryMinutes = 60 } = {}) {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const enabled = String(process.env.FIXED_SCHEDULE_BILLING_ENABLED || "true") !== "false";
  const minutes = Math.max(1, Number(everyMinutes || process.env.FIXED_SCHEDULE_BILLING_EVERY_MINUTES || 2));
  console.log("[FIXED BILLING] scheduler starting", { enabled, everyMinutes: minutes });
  if (!enabled) return;
  setTimeout(() => runFixedScheduleBillingTick().catch((e) => console.log("[FIXED BILLING] first tick error", e?.message || e)), 5000);
  setTimeout(() => releaseUnpaidFixedSchedules().catch((e) => console.log("[FIXED BILLING] first release error", e?.message || e)), 15000);
  schedulerTimer = setInterval(() => {
    runFixedScheduleBillingTick().catch((e) => console.log("[FIXED BILLING] tick error", e?.message || e));
    releaseUnpaidFixedSchedules().catch((e) => console.log("[FIXED BILLING] release error", e?.message || e));
  }, minutes * 60 * 1000);
  schedulerTimer.unref?.();

  weeklySummaryTimer = setInterval(() => {
    sendWeeklyFixedDebtSummary().catch((e) => console.log("[FIXED BILLING] weekly summary error", e?.message || e));
  }, Math.max(15, Number(weeklySummaryEveryMinutes || process.env.FIXED_DEBT_SUMMARY_EVERY_MINUTES || 60)) * 60 * 1000);
  weeklySummaryTimer.unref?.();
}

export default startFixedScheduleBillingScheduler;
