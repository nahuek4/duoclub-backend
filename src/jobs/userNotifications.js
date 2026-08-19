// backend/src/jobs/userNotifications.js
// Notificaciones automáticas vigentes:
// - 7 días antes del día 1: un único aviso de vencimiento de sesiones.
// - Cumpleaños: usuario + administración.
//
// No envía mails de deuda, cierre de mes duplicados ni renovación manual de turnos fijos.

import User from "../models/User.js";
import {
  sendCreditsExpiryReminderEmail,
  sendBirthdayEmail,
  sendAdminBirthdayEmail,
} from "../mail.js";

const TZ = "America/Argentina/Buenos_Aires";
const SERVICE_KEYS = ["EP", "RA", "RF", "SYN"];

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
    const d = new Date(`${p.year}-${pad2(p.month)}-01T12:00:00-03:00`);
    return new Intl.DateTimeFormat("es-AR", {
      timeZone: TZ,
      month: "long",
      year: "numeric",
    }).format(d);
  } catch {
    return monthKeyFromParts(p);
  }
}

function lastDayNumber(year, month) {
  return new Date(Date.UTC(year, month, 0, 12, 0, 0, 0)).getUTCDate();
}

function nextMonthKey(p) {
  const d = new Date(Date.UTC(p.year, p.month - 1, 15, 12, 0, 0, 0));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

function normalizeServiceKey(v) {
  const sk = String(v || "").toUpperCase().trim();
  if (sk === "AR") return "RA";
  if (sk === "SYNERGY" || sk === "SINERGIA") return "SYN";
  return SERVICE_KEYS.includes(sk) ? sk : "";
}

function isApprovedClient(user = {}) {
  const role = String(user?.role || "client").toLowerCase().trim();
  if (!["client", "guest"].includes(role)) return false;
  if (String(user?.approvalStatus || "approved").toLowerCase().trim() === "rejected") return false;
  return !!String(user?.email || "").trim();
}

function serviceCreditSummary(user = {}, now = new Date()) {
  const out = Object.fromEntries(SERVICE_KEYS.map((k) => [k, 0]));

  for (const lot of Array.isArray(user?.creditLots) ? user.creditLots : []) {
    const remaining = Math.max(0, Number(lot?.remaining || 0));
    if (remaining <= 0) continue;

    const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) continue;

    const sk = normalizeServiceKey(lot?.serviceKey || lot?.service || lot?.serviceName);
    if (sk && out[sk] !== undefined) out[sk] += remaining;
  }

  return out;
}

function summaryTotal(summary = {}) {
  return SERVICE_KEYS.reduce(
    (acc, key) => acc + Math.max(0, Number(summary?.[key] || 0)),
    0
  );
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

async function sendMonthlyExpiryNotifications({ now = new Date(), force = false } = {}) {
  const p = arParts(now);
  const monthKey = monthKeyFromParts(p);
  const monthLabel = monthLabelFromParts(p);
  const todayYmd = ymdFromParts(p);
  const lastDay = lastDayNumber(p.year, p.month);

  // Exactamente 7 días antes del 01 del mes siguiente.
  const reminderDay = Math.max(1, lastDay - 6);
  if (!force && p.day !== reminderDay) {
    return {
      ok: true,
      skipped: true,
      reason: "NOT_EXPIRY_REMINDER_DAY",
      todayYmd,
      reminderDay,
    };
  }

  const nextKey = nextMonthKey(p);
  const lastUsableAt = new Date(
    `${monthKey}-${pad2(lastDay)}T23:59:59-03:00`
  );
  const expiryAt = new Date(`${nextKey}-01T00:00:00-03:00`);

  const users = await baseUsersQuery();
  let sent = 0;
  let withoutCredits = 0;

  for (const user of users) {
    if (!isApprovedClient(user)) continue;

    const summary = serviceCreditSummary(user, now);
    if (summaryTotal(summary) <= 0) {
      withoutCredits += 1;
      continue;
    }

    user.notifications = user.notifications || {};
    if (!force && user.notifications.lastCreditsExpiryMonthKey === monthKey) {
      continue;
    }

    await sendCreditsExpiryReminderEmail(user, summary, {
      monthKey,
      monthLabel,
      lastUsableAt,
      expiryAt,
    });

    user.notifications.lastCreditsExpiryMonthKey = monthKey;
    await user.save();
    sent += 1;
  }

  return {
    ok: true,
    monthKey,
    todayYmd,
    reminderDay,
    sent,
    withoutCredits,
  };
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

  const [monthlyExpiry, birthdays] = await Promise.all([
    sendMonthlyExpiryNotifications({ now, force }),
    sendBirthdayNotifications({ now, force }),
  ]);

  return { ok: true, monthlyExpiry, birthdays };
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
  const minutes = Math.max(
    30,
    Number(everyMinutes || process.env.USER_NOTIFICATIONS_EVERY_MINUTES || 360)
  );

  console.log("[USER-NOTIFICATIONS] scheduler starting", {
    enabled,
    everyMinutes: minutes,
  });

  if (!enabled) return;

  const delayMs = minutes * 60 * 1000;
  setTimeout(() => userNotificationsTick(), 20_000);
  schedulerTimer = setInterval(() => userNotificationsTick(), delayMs);
  schedulerTimer.unref?.();
}

export const startNotificationsScheduler = startUserNotificationsScheduler;
export default startUserNotificationsScheduler;
