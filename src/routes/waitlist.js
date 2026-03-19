import crypto from "crypto";

import Appointment from "../models/Appointment.js";
import WaitlistEntry from "../models/WaitlistEntry.js";

const TOTAL_CAP = 6;
const EP_CAP_WHEN_THERAPY_ACTIVE = 4;
const THERAPY_CAP_WHEN_ACTIVE = 2;

const EP_NAME = "Entrenamiento Personal";
const RA_NAME = "Rehabilitación activa";
const RF_NAME = "Reeducación funcional";

const TIMES_REHAB_MWF = [
  "07:00", "08:00", "09:00", "10:00",
  "11:00", "12:00", "13:30", "14:00", "15:00",
];

const TIMES_REHAB_TT = [
  "07:00", "08:00", "09:00", "10:00",
  "11:00", "12:00",
  "15:00", "16:00", "17:00", "18:00",
];

const WAITLIST_CLAIM_WINDOW_MINUTES = Number(
  process.env.WAITLIST_CLAIM_WINDOW_MINUTES || 60
);

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normSvcName(s) {
  return stripAccents(s).toLowerCase().trim();
}

function sameService(a, b) {
  return normSvcName(a) === normSvcName(b);
}

function isTherapyService(serviceName) {
  return sameService(serviceName, RA_NAME) || sameService(serviceName, RF_NAME);
}

function getWeekdayMondayFirst(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const js = new Date(y, (m || 1) - 1, d || 1).getDay();
  return js === 0 ? 7 : js;
}

function getRehabTimesForDate(dateStr) {
  const weekday = getWeekdayMondayFirst(dateStr);
  if ([1, 3, 5].includes(weekday)) return TIMES_REHAB_MWF;
  if ([2, 4].includes(weekday)) return TIMES_REHAB_TT;
  return [];
}

function isTherapyAreaActiveAt(dateStr, time) {
  const t = String(time || "").slice(0, 5);
  return getRehabTimesForDate(dateStr).includes(t);
}

function getTherapyCapForSlot(dateStr, time) {
  return isTherapyAreaActiveAt(dateStr, time) ? THERAPY_CAP_WHEN_ACTIVE : 0;
}

function getEpCapForSlot(dateStr, time) {
  return getTherapyCapForSlot(dateStr, time) > 0
    ? EP_CAP_WHEN_THERAPY_ACTIVE
    : TOTAL_CAP;
}

function getSlotReservationStats(existing, dateStr, time) {
  const list = Array.isArray(existing) ? existing : [];
  const epReserved = list.filter((a) => sameService(a.service, EP_NAME)).length;
  const therapyReserved = list.filter((a) => isTherapyService(a.service)).length;

  return {
    totalReserved: list.length,
    epReserved,
    therapyReserved,
    therapyCap: getTherapyCapForSlot(dateStr, time),
    epCap: getEpCapForSlot(dateStr, time),
  };
}

function buildClaimUrl(token) {
  const frontend = String(process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  if (!frontend) return "";
  return `${frontend}/waitlist/claim?token=${encodeURIComponent(token)}`;
}

export async function notifyWaitlistForSlot({ date, time, service = EP_NAME }) {
  try {
    if (!sameService(service, EP_NAME)) {
      return { ok: true, skipped: true, reason: "SERVICE_HAS_NO_WAITLIST" };
    }

    const t = String(time || "").slice(0, 5);

    const existingReservations = await Appointment.find({
      date,
      time: t,
      status: "reserved",
    })
      .select("service")
      .lean();

    const stats = getSlotReservationStats(existingReservations, date, t);
    if (stats.totalReserved >= TOTAL_CAP || stats.epReserved >= stats.epCap) {
      return { ok: true, skipped: true, reason: "SLOT_STILL_FULL" };
    }

    const alreadyNotified = await WaitlistEntry.findOne({
      date,
      time: t,
      service: EP_NAME,
      status: "notified",
      tokenExpiresAt: { $gt: new Date() },
    }).lean();

    if (alreadyNotified) {
      return { ok: true, skipped: true, reason: "ALREADY_NOTIFIED" };
    }

    const nextEntry = await WaitlistEntry.findOne({
      date,
      time: t,
      service: EP_NAME,
      status: "waiting",
    })
      .populate("user", "name lastName email")
      .sort({ createdAt: 1 });

    if (!nextEntry) {
      return { ok: true, skipped: true, reason: "NO_WAITLIST" };
    }

    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + WAITLIST_CLAIM_WINDOW_MINUTES * 60 * 1000);

    nextEntry.notifyToken = token;
    nextEntry.notifiedAt = new Date();
    nextEntry.tokenExpiresAt = expiresAt;
    nextEntry.status = "notified";
    await nextEntry.save();

    const claimUrl = buildClaimUrl(token);

    // Reemplazá este bloque por tu helper real de email si ya lo tenés en el proyecto.
    console.log("[WAITLIST][NOTIFY]", {
      to: nextEntry?.user?.email || "",
      userId: nextEntry?.user?._id?.toString?.() || String(nextEntry?.user || ""),
      userName: [nextEntry?.user?.name, nextEntry?.user?.lastName].filter(Boolean).join(" "),
      date,
      time: t,
      service: EP_NAME,
      claimUrl,
      expiresAt,
    });

    return {
      ok: true,
      notified: true,
      waitlistEntryId: String(nextEntry._id),
      token,
      expiresAt,
      claimUrl,
    };
  } catch (err) {
    console.error("Error en notifyWaitlistForSlot:", err);
    return { ok: false, error: err?.message || "WAITLIST_NOTIFY_ERROR" };
  }
}

export default notifyWaitlistForSlot;
