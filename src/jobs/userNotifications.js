// backend/src/jobs/userNotifications.js
// Notificaciones operativas mensuales y cumpleaños.
// - Créditos/sesiones: el mes cierra el último día calendario (30/31/28/29), no día hábil.
// - Primer día del mes: solo usuarios con turnos fijos activos.
// - Cumpleaños: usuario + admin.

import User from "../models/User.js";
import FixedSchedule from "../models/FixedSchedule.js";
import {
  sendCreditsExpiryReminderEmail,
  sendFinalWeekOfMonthEmail,
  sendMonthEndEmail,
  sendMonthStartFixedSchedulesEmail,
  sendBirthdayEmail,
  sendAdminBirthdayEmail,
} from "../mail.js";

const TZ = "America/Argentina/Buenos_Aires";
const SERVICE_KEYS = ["PE", "EP", "RA", "RF", "KD", "NUT"];

let schedulerStarted = false;
let schedulerTimer = null;

function pad2(n) {
  return String(n).padStart(2, "0");
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

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function ymdFromParts(p) {
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function monthKeyFromParts(p) {
  return `${p.year}-${pad2(p.month)}`;
}

function monthLabelFromParts(p) {
  try {
    const d = new Date(p.year, p.month - 1, 1, 12, 0, 0, 0);
    return d.toLocaleDateString("es-AR", {
      timeZone: TZ,
      month: "long",
      year: "numeric",
    });
  } catch {
    return monthKeyFromParts(p);
  }
}

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0, 23, 59, 59, 999);
}

function normalizeServiceKey(v) {
  const sk = String(v || "").toUpperCase().trim();
  if (sk === "AR") return "RA";
  if (sk === "KINEDEPO" || sk === "KINE-DEPO") return "KD";
  return SERVICE_KEYS.includes(sk) ? sk : "";
}

function isApprovedClient(user = {}) {
  const role = String(user?.role || "client").toLowerCase().trim();
  if (!["client", "guest"].includes(role)) return false;
  if (String(user?.approvalStatus || "approved").toLowerCase().trim() === "rejected") return false;
  return !!String(user?.email || "").trim();
}

function serviceCreditSummary(user = {}, monthEnd = null) {
  const now = new Date();
  const end = monthEnd ? new Date(monthEnd) : null;
  const out = Object.fromEntries(SERVICE_KEYS.map((k) => [k, 0]));

  for (const lot of Array.isArray(user?.creditLots) ? user.creditLots : []) {
    const remaining = Math.max(0, Number(lot?.remaining || 0));
    if (remaining <= 0) continue;

    const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) continue;

    // En DUO, las sesiones del mes vencen al cierre calendario del mes.
    // Si un lote tuviera una fecha futura distinta, lo contamos igual como saldo actual del usuario.
    if (end && exp && exp > end) {
      // Lo dejamos dentro del resumen porque el usuario necesita ver su saldo por servicio.
    }

    const sk = normalizeServiceKey(lot?.serviceKey || lot?.service || lot?.serviceName);
    if (sk && out[sk] !== undefined) out[sk] += remaining;
  }

  return out;
}

function hasBirthdayToday(user = {}, p = arParts()) {
  const bd = user?.birthDate || {};
  const day = Number(bd?.day || 0);
  const month = Number(bd?.month || 0);
  return day > 0 && month > 0 && day === p.day && month === p.month;
}

async function baseUsersQuery() {
  return User.find({
    email: { $type: "string", $ne: "" },
    role: { $in: ["client", "guest"] },
    approvalStatus: { $ne: "rejected" },
  }).select("name lastName email phone role approvalStatus creditLots notifications birthDate createdAt");
}

async function sendCreditsAndMonthNotifications({ now = new Date(), force = false } = {}) {
  const p = arParts(now);
  const monthKey = monthKeyFromParts(p);
  const monthLabel = monthLabelFromParts(p);
  const todayYmd = ymdFromParts(p);
  const lastDay = lastDayOfMonth(p.year, p.month).getDate();
  const monthEnd = lastDayOfMonth(p.year, p.month);
  const finalWeekStart = Math.max(1, lastDay - 6);

  const shouldRunFinalWeek = force || p.day === finalWeekStart;
  const shouldRunMonthEnd = force || p.day === lastDay;

  if (!shouldRunFinalWeek && !shouldRunMonthEnd) {
    return { ok: true, skipped: true, reason: "NOT_FINAL_WEEK_OR_MONTH_END", todayYmd };
  }

  const users = await baseUsersQuery();
  let creditsSent = 0;
  let finalWeekSent = 0;
  let monthEndSent = 0;

  for (const user of users) {
    if (!isApprovedClient(user)) continue;
    user.notifications = user.notifications || {};

    const summary = serviceCreditSummary(user, monthEnd);
    let changed = false;

    if (shouldRunFinalWeek && user.notifications.lastCreditsExpiryMonthKey !== monthKey) {
      await sendCreditsExpiryReminderEmail(user, summary, { monthKey, monthLabel, monthEnd });
      user.notifications.lastCreditsExpiryMonthKey = monthKey;
      creditsSent += 1;
      changed = true;
    }

    if (shouldRunFinalWeek && user.notifications.lastFinalWeekMonthKey !== monthKey) {
      await sendFinalWeekOfMonthEmail(user, { monthKey, monthLabel, monthEnd });
      user.notifications.lastFinalWeekMonthKey = monthKey;
      finalWeekSent += 1;
      changed = true;
    }

    if (shouldRunMonthEnd && user.notifications.lastMonthEndMonthKey !== monthKey) {
      await sendMonthEndEmail(user, summary, { monthKey, monthLabel, monthEnd });
      user.notifications.lastMonthEndMonthKey = monthKey;
      monthEndSent += 1;
      changed = true;
    }

    if (changed) await user.save();
  }

  return { ok: true, monthKey, todayYmd, creditsSent, finalWeekSent, monthEndSent };
}

async function sendMonthStartFixedScheduleNotifications({ now = new Date(), force = false } = {}) {
  const p = arParts(now);
  const monthKey = monthKeyFromParts(p);
  const monthLabel = monthLabelFromParts(p);
  const todayYmd = ymdFromParts(p);

  if (!force && p.day !== 1) {
    return { ok: true, skipped: true, reason: "NOT_MONTH_START", todayYmd };
  }

  const schedules = await FixedSchedule.find({
    active: true,
    startDate: { $lte: todayYmd },
    endDate: { $gte: todayYmd },
  }).lean();

  const byUser = new Map();
  for (const s of schedules) {
    const uid = String(s?.user || "");
    if (!uid) continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(s);
  }

  let sent = 0;

  for (const [uid, userSchedules] of byUser.entries()) {
    const user = await User.findById(uid).select("name lastName email phone role approvalStatus notifications");
    if (!user || !isApprovedClient(user)) continue;

    user.notifications = user.notifications || {};
    if (!force && user.notifications.lastMonthStartFixedMonthKey === monthKey) continue;

    await sendMonthStartFixedSchedulesEmail(user, userSchedules, { monthKey, monthLabel });
    user.notifications.lastMonthStartFixedMonthKey = monthKey;
    await user.save();
    sent += 1;
  }

  return { ok: true, monthKey, todayYmd, fixedUsers: byUser.size, sent };
}

async function sendBirthdayNotifications({ now = new Date(), force = false } = {}) {
  const p = arParts(now);
  const yearKey = String(p.year);
  const todayYmd = ymdFromParts(p);

  const users = await baseUsersQuery();
  let userSent = 0;
  let adminSent = 0;

  for (const user of users) {
    if (!isApprovedClient(user)) continue;
    if (!hasBirthdayToday(user, p)) continue;

    user.notifications = user.notifications || {};
    let changed = false;

    if (force || user.notifications.lastBirthdayYearKey !== yearKey) {
      await sendBirthdayEmail(user);
      user.notifications.lastBirthdayYearKey = yearKey;
      userSent += 1;
      changed = true;
    }

    if (force || user.notifications.lastAdminBirthdayYearKey !== yearKey) {
      await sendAdminBirthdayEmail(user);
      user.notifications.lastAdminBirthdayYearKey = yearKey;
      adminSent += 1;
      changed = true;
    }

    if (changed) await user.save();
  }

  return { ok: true, todayYmd, userSent, adminSent };
}

export async function runUserNotifications(options = {}) {
  const now = options?.now || new Date();
  const force = !!options?.force;

  const [monthStart, monthClose, birthdays] = await Promise.all([
    sendMonthStartFixedScheduleNotifications({ now, force }),
    sendCreditsAndMonthNotifications({ now, force }),
    sendBirthdayNotifications({ now, force }),
  ]);

  return { ok: true, monthStart, monthClose, birthdays };
}

export async function userNotificationsTick(options = {}) {
  try {
    const result = await runUserNotifications(options);
    console.log("[USER-NOTIFICATIONS] tick", result);
    return result;
  } catch (err) {
    console.log("[USER-NOTIFICATIONS] tick error", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

export function startUserNotificationsScheduler({ everyMinutes } = {}) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const enabled = String(process.env.USER_NOTIFICATIONS_ENABLED || "true") !== "false";
  const minutes = Math.max(30, Number(everyMinutes || process.env.USER_NOTIFICATIONS_EVERY_MINUTES || 360));

  console.log("[USER-NOTIFICATIONS] scheduler starting", { enabled, everyMinutes: minutes });

  if (!enabled) return;

  const delayMs = minutes * 60 * 1000;
  setTimeout(() => userNotificationsTick(), 20_000);
  schedulerTimer = setInterval(() => userNotificationsTick(), delayMs);
  schedulerTimer.unref?.();
}

export const startNotificationsScheduler = startUserNotificationsScheduler;
export default startUserNotificationsScheduler;
