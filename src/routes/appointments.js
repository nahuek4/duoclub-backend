import express from "express";
import mongoose from "mongoose";

import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import WaitlistEntry from "../models/WaitlistEntry.js";
import FixedSchedule from "../models/FixedSchedule.js";

import { protect } from "../middleware/auth.js";

import {
  fireAndForget,
  sendAppointmentBookedEmail,
  sendAppointmentBookedBatchEmail,
  sendAppointmentCancelledEmail,
} from "../mail.js";
import { logActivity, buildUserSubject } from "../lib/activityLogger.js";

const router = express.Router();

/* =========================
   CONFIG: ventana de reserva
========================= */
const MAX_ADVANCE_DAYS = 30;

/**
 * Anticipación mínima por servicio
 * EP = 30 min fijo
 * RA/RF = 24 h fijas
 * resto = variable por env o fallback 60
 */
const DEFAULT_MIN_BOOKING_MINUTES = Number(
  process.env.MIN_BOOKING_MINUTES || 60
);

const MIN_BOOKING_MINUTES_BY_SERVICE = {
  EP: 30,
  RA: 24 * 60,
  RF: 24 * 60,
  NUT: DEFAULT_MIN_BOOKING_MINUTES,
  OTHER: DEFAULT_MIN_BOOKING_MINUTES,
};

/* =========================
   CRÉDITOS
========================= */
const CREDITS_EXPIRE_DAYS = 30;

/* =========================
   WAITLIST
========================= */
const ACTIVE_WAITLIST_STATUSES = ["waiting", "notified"];

/* =========================
   ADMIN MAIL (fallback)
========================= */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "nahuek.75@gmail.com";

async function sendAdminCopy({ kind, user, ap }) {
  try {
    if (String(process.env.MAIL_ADMIN_COPY || "true") !== "true") return;

    console.log("[MAIL ADMIN FALLBACK]", {
      to: ADMIN_EMAIL,
      kind,
      user: {
        id: user?._id?.toString?.() || user?.id,
        email: user?.email,
        name: user?.name,
      },
      ap,
    });
  } catch (e) {
    console.log("[MAIL] admin fallback error:", e?.message || e);
  }
}

function ensureStaff(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!["admin", "profesor", "staff"].includes(role)) {
    return res.status(403).json({ error: "No autorizado." });
  }
  return next();
}

/* =========================
   HELPERS: fecha/hora
========================= */
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function buildSlotDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [year, month, day] = String(dateStr).split("-").map(Number);
  const [hour, minute] = String(timeStr).split(":").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, hour || 0, minute || 0, 0, 0);
}

function validateBookingWindow(slotDate) {
  const now = new Date();
  const max = addDays(now, MAX_ADVANCE_DAYS);

  if (slotDate.getTime() < now.getTime()) {
    return { ok: false, error: "No se puede reservar un turno pasado." };
  }
  if (slotDate.getTime() > max.getTime()) {
    return {
      ok: false,
      error: `Solo se puede reservar hasta ${MAX_ADVANCE_DAYS} días de anticipación.`,
    };
  }
  return { ok: true };
}

function getMinBookingMinutesForService(serviceName) {
  const sk = serviceToKey(serviceName);
  return (
    MIN_BOOKING_MINUTES_BY_SERVICE[sk] ??
    MIN_BOOKING_MINUTES_BY_SERVICE.OTHER
  );
}

function validateMinAdvance(slotDate, serviceName) {
  const now = new Date();
  const minMinutes = getMinBookingMinutesForService(serviceName);
  const limit = new Date(now.getTime() + minMinutes * 60 * 1000);

  if (slotDate.getTime() < limit.getTime()) {
    return {
      ok: false,
      error: `El turno debe reservarse con al menos ${minMinutes} minutos de anticipación.`,
    };
  }
  return { ok: true };
}

function getWaitlistCloseMinutesForService(serviceName) {
  const sk = serviceToKey(serviceName);

  if (sk === "EP") return 30;
  if (sk === "RF" || sk === "RA") return 12 * 60;

  return null;
}

function validateWaitlistOpen(slotDate, serviceName) {
  const closeMinutes = getWaitlistCloseMinutesForService(serviceName);
  if (!Number.isFinite(closeMinutes)) return { ok: true };

  const now = new Date();
  const limit = new Date(now.getTime() + closeMinutes * 60 * 1000);

  if (slotDate.getTime() <= limit.getTime()) {
    return {
      ok: false,
      error:
        closeMinutes >= 60
          ? `La lista de espera para este servicio se cierra ${Math.round(
              closeMinutes / 60
            )} horas antes del turno.`
          : `La lista de espera para este servicio se cierra ${closeMinutes} minutos antes del turno.`,
    };
  }

  return { ok: true };
}

function isSaturday(dateStr) {
  const [y, m, d] = String(dateStr || "").split("-").map(Number);
  if (!y || !m || !d) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getDay() === 6;
}

function isSunday(dateStr) {
  const [y, m, d] = String(dateStr || "").split("-").map(Number);
  if (!y || !m || !d) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getDay() === 0;
}

function getTurnoFromTime(time) {
  if (!time) return "";
  const [hStr, mStr] = String(time).split(":");
  const h = Number(hStr);
  const m = Number(mStr);

  if (h === 13 && m === 30) return "maniana";

  if (h >= 7 && h <= 12) return "maniana";
  if (h >= 14 && h <= 17) return "tarde";
  if (h >= 18 && h <= 20) return "noche";

  return "";
}

/* =========================
   HELPERS: normalización servicios
========================= */
function normSvcName(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function sameService(a, b) {
  return normSvcName(a) === normSvcName(b);
}

/* =========================
   HELPERS: créditos
========================= */
function nowDate() {
  return new Date();
}

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function serviceToKey(serviceName) {
  const s = stripAccents(serviceName).toLowerCase().trim();

  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("nutricion")) return "NUT";

  const up = String(serviceName || "").toUpperCase().trim();
  const allowed = new Set(["PE", "EP", "RA", "RF", "NUT"]);
  if (allowed.has(up)) return up;

  return "EP";
}

function getCreditsExpireDays(_user) {
  return CREDITS_EXPIRE_DAYS;
}

function recalcUserCredits(user) {
  const now = nowDate();
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];

  const sum = lots.reduce((acc, lot) => {
    const exp = lot.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return acc;
    return acc + Number(lot.remaining || 0);
  }, 0);

  user.credits = sum;
}

function normalizeLotServiceKey(lot) {
  const raw = lot?.serviceKey;
  const sk = String(raw || "").toUpperCase().trim();
  return sk || "EP";
}

function isFirstEvaluationService(serviceName) {
  return serviceToKey(serviceName) === "PE";
}

async function syncPastAppointmentsForUserId(userId, session = null) {
  if (!userId) return null;

  const userQuery = User.findById(userId);
  if (session) userQuery.session(session);
  const user = await userQuery;
  if (!user) return null;

  const now = new Date();

  const apQuery = Appointment.find({
    user: user._id,
    status: "reserved",
  });
  if (session) apQuery.session(session);
  const reservedPast = await apQuery;

  let changed = false;
  let completedFirstEvaluation = false;

  for (const ap of reservedPast) {
    const slotDate = buildSlotDate(ap.date, ap.time);
    if (!slotDate) continue;
    if (slotDate.getTime() > now.getTime()) continue;

    ap.status = "completed";
    ap.completedAt = now;
    if (session) await ap.save({ session });
    else await ap.save();
    changed = true;

    if (isFirstEvaluationService(ap.service)) {
      completedFirstEvaluation = true;
    }
  }

  if (completedFirstEvaluation && !user.firstEvaluationCompleted) {
    user.firstEvaluationCompleted = true;
    user.firstEvaluationCompletedAt = user.firstEvaluationCompletedAt || now;
    changed = true;
  }

  if (changed) {
    recalcUserCredits(user);
    if (session) await user.save({ session });
    else await user.save();
  }

  return user;
}

function ensureSlotBeforeCreditExpiry(slotDate, lotExpiresAt) {
  if (!slotDate || !lotExpiresAt) return { ok: true };

  const exp = new Date(lotExpiresAt);
  if (Number.isNaN(exp.getTime())) return { ok: true };

  if (slotDate.getTime() > exp.getTime()) {
    return {
      ok: false,
      error:
        "No podés reservar una sesión posterior al vencimiento del crédito disponible.",
    };
  }

  return { ok: true };
}

function pickLotToConsume(user, wantedServiceKey) {
  const now = nowDate();
  const want = String(wantedServiceKey || "").toUpperCase().trim() || "EP";

  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];

  const sorted = lots
    .filter((l) => Number(l.remaining || 0) > 0)
    .filter((l) => !l.expiresAt || new Date(l.expiresAt) > now)
    .filter((l) => normalizeLotServiceKey(l) === want)
    .sort((a, b) => {
      const ae = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
      const be = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
      if (ae !== be) return ae - be;

      const ac = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bc = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ac - bc;
    });

  return sorted[0] || null;
}

function pickLotToConsumeForSlot(user, wantedServiceKey, slotDate) {
  const now = nowDate();
  const want = String(wantedServiceKey || "").toUpperCase().trim() || "EP";

  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];

  const sorted = lots
    .filter((l) => Number(l.remaining || 0) > 0)
    .filter((l) => !l.expiresAt || new Date(l.expiresAt) > now)
    .filter((l) => normalizeLotServiceKey(l) === want)
    .sort((a, b) => {
      const ae = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
      const be = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
      if (ae !== be) return ae - be;

      const ac = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bc = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ac - bc;
    });

  for (const lot of sorted) {
    const check = ensureSlotBeforeCreditExpiry(slotDate, lot.expiresAt);
    if (check.ok) return lot;
  }

  return null;
}

function hasValidCreditsForService(user, serviceNameOrKey) {
  const sk = serviceToKey(serviceNameOrKey);
  return !!pickLotToConsume(user, sk);
}

function hasValidCreditsForServiceAndSlot(user, serviceNameOrKey, slotDate) {
  const sk = serviceToKey(serviceNameOrKey);
  return !!pickLotToConsumeForSlot(user, sk, slotDate);
}

function findLotById(user, lotId) {
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
  return lots.find((l) => String(l._id) === String(lotId)) || null;
}

async function consumeCreditAtomic({
  userId,
  serviceName,
  historyItem,
  slotDate,
  session,
}) {
  const requestedSk = serviceToKey(serviceName);

  const currentUser = await User.findById(userId).session(session);
  if (!currentUser) throw new Error("USER_NOT_FOUND");

  recalcUserCredits(currentUser);
  if ((currentUser.credits || 0) <= 0) {
    throw new Error("NO_CREDITS");
  }

  const lot = pickLotToConsumeForSlot(currentUser, requestedSk, slotDate);
  if (!lot) {
    throw new Error(`NO_CREDITS_FOR_SLOT_${requestedSk}`);
  }

  const lotId = lot._id;
  const lotExp = lot.expiresAt || null;

  const upd = await User.updateOne(
    {
      _id: userId,
      "creditLots._id": lotId,
      "creditLots.remaining": { $gt: 0 },
    },
    {
      $inc: { "creditLots.$.remaining": -1 },
    },
    { session }
  );

  if (!upd.modifiedCount) {
    throw new Error("CREDIT_CONSUME_FAILED");
  }

  const freshUser = await User.findById(userId).session(session);
  if (!freshUser) throw new Error("USER_NOT_FOUND");

  freshUser.history = freshUser.history || [];
  freshUser.history.push({
    ...historyItem,
    createdAt: new Date(),
  });

  recalcUserCredits(freshUser);
  await freshUser.save({ session });

  return {
    user: freshUser,
    usedLotId: lotId,
    usedLotExp: lotExp,
    requestedSk,
  };
}

async function refundCreditAtomicToOriginalLot({
  userId,
  lotId,
  apService,
  historyItem,
  session,
}) {
  const freshUser = await User.findById(userId).session(session);
  if (!freshUser) throw new Error("USER_NOT_FOUND");

  const lot = findLotById(freshUser, lotId);

  console.log("[REFUND LOT DEBUG - BEFORE]", {
    userId: String(userId),
    lotId: String(lotId || ""),
    apService: String(apService || ""),
    lotFound: !!lot,
    lotAmount: lot?.amount,
    lotRemaining: lot?.remaining,
    lotExpiresAt: lot?.expiresAt || null,
    allLots: (Array.isArray(freshUser?.creditLots) ? freshUser.creditLots : []).map((x) => ({
      id: String(x?._id || ""),
      serviceKey: String(x?.serviceKey || ""),
      amount: Number(x?.amount || 0),
      remaining: Number(x?.remaining || 0),
      expiresAt: x?.expiresAt || null,
      source: String(x?.source || ""),
    })),
  });

  if (!lot) throw new Error("REFUND_FAILED");

  const currentRemaining = Number(lot.remaining || 0);
  const maxAmount = Number(lot.amount || 0);

  if (currentRemaining < maxAmount) {
    lot.remaining = currentRemaining + 1;
  } else {
    const now = nowDate();
    const fallbackExp = lot.expiresAt
      ? new Date(lot.expiresAt)
      : new Date(now.getTime() + Number(getCreditsExpireDays(freshUser) || 30) * 24 * 60 * 60 * 1000);

    console.warn("[REFUND INCONSISTENCY]", {
      userId: String(userId),
      lotId: String(lotId || ""),
      apService: String(apService || ""),
      currentRemaining,
      maxAmount,
      fallbackExp,
      reason: "ORIGINAL_LOT_ALREADY_FULL_ON_REFUND",
    });

    freshUser.creditLots = Array.isArray(freshUser.creditLots)
      ? freshUser.creditLots
      : [];

    freshUser.creditLots.push({
      serviceKey: serviceToKey(apService || lot.serviceKey || "EP"),
      amount: 1,
      remaining: 1,
      expiresAt: fallbackExp,
      source: "refund-recovery",
      orderId: null,
      createdAt: now,
    });
  }

  console.log("[REFUND LOT DEBUG - AFTER CALC]", {
    userId: String(userId),
    lotId: String(lotId || ""),
    apService: String(apService || ""),
    currentRemaining,
    maxAmount,
    resultingLots: (Array.isArray(freshUser?.creditLots) ? freshUser.creditLots : []).map((x) => ({
      id: String(x?._id || ""),
      serviceKey: String(x?.serviceKey || ""),
      amount: Number(x?.amount || 0),
      remaining: Number(x?.remaining || 0),
      expiresAt: x?.expiresAt || null,
      source: String(x?.source || ""),
    })),
  });

  freshUser.history = freshUser.history || [];
  freshUser.history.push({
    ...historyItem,
    createdAt: new Date(),
  });

  recalcUserCredits(freshUser);

  console.log("[REFUND USER DEBUG - BEFORE SAVE]", {
    userId: String(userId),
    creditsAfterRecalc: Number(freshUser.credits || 0),
    historyLastItem: freshUser.history?.[freshUser.history.length - 1] || null,
  });

  await freshUser.save({ session });

  console.log("[REFUND USER DEBUG - SAVED]", {
    userId: String(userId),
    creditsSaved: Number(freshUser.credits || 0),
  });

  return freshUser;
}

async function refundCreditAtomicNewLot({
  userId,
  apService,
  historyItem,
  session,
}) {
  const now = nowDate();
  const sk = serviceToKey(apService);
  const exp = new Date(now);
  exp.setDate(exp.getDate() + Number(getCreditsExpireDays() || 30));

  console.log("[REFUND NEW LOT DEBUG - BEFORE PUSH]", {
    userId: String(userId),
    apService,
    serviceKey: sk,
    expiresAt: exp,
  });

  await User.updateOne(
    { _id: userId },
    {
      $push: {
        creditLots: {
          serviceKey: sk,
          amount: 1,
          remaining: 1,
          expiresAt: exp,
          source: "refund",
          orderId: null,
          createdAt: now,
        },
      },
    },
    { session }
  );

  const freshUser = await User.findById(userId).session(session);
  if (!freshUser) throw new Error("USER_NOT_FOUND");

  freshUser.history = freshUser.history || [];
  freshUser.history.push({
    ...historyItem,
    createdAt: new Date(),
  });

  recalcUserCredits(freshUser);

  console.log("[REFUND NEW LOT DEBUG - BEFORE SAVE]", {
    userId: String(userId),
    creditsAfterRecalc: Number(freshUser.credits || 0),
    lastLot:
      Array.isArray(freshUser.creditLots) && freshUser.creditLots.length
        ? freshUser.creditLots[freshUser.creditLots.length - 1]
        : null,
  });

  await freshUser.save({ session });

  console.log("[REFUND NEW LOT DEBUG - SAVED]", {
    userId: String(userId),
    creditsSaved: Number(freshUser.credits || 0),
  });

  return { user: freshUser, sk, expiresAt: exp };
}

function serializeUserCreditLots(user) {
  return (Array.isArray(user?.creditLots) ? user.creditLots : []).map((lot) => ({
    _id: String(lot?._id || ""),
    serviceKey: String(lot?.serviceKey || "").toUpperCase().trim(),
    amount: Number(lot?.amount || 0),
    remaining: Number(lot?.remaining || 0),
    expiresAt: lot?.expiresAt || null,
    source: lot?.source || "",
    orderId: lot?.orderId || null,
    createdAt: lot?.createdAt || null,
  }));
}

function serializeAppointment(ap) {
  const json = ap?.toObject ? ap.toObject() : ap;

  const userObj = json?.user || {};
  const userId =
    userObj?._id?.toString?.() ||
    json?.userId ||
    userObj?.toString?.() ||
    "";

  const userName = String(userObj?.name || "").trim();
  const userLastName = String(userObj?.lastName || "").trim();
  const userFullName = [userName, userLastName].filter(Boolean).join(" ").trim();

  return {
    id: json?._id?.toString?.() || json?.id,
    date: json?.date,
    time: json?.time,
    service: json?.service || "",
    status: json?.status || "reserved",
    coach: json?.coach || "",
    userId,
    userName,
    userLastName,
    userFullName,
    userEmail: userObj?.email || "",
    creditExpiresAt: json?.creditExpiresAt || null,
    completedAt: json?.completedAt || null,
  };
}

function serializeWaitlistEntry(entry) {
  const json = entry?.toObject ? entry.toObject() : entry;
  const userObj = json?.user || {};

  return {
    id: json?._id?.toString?.() || json?.id,
    date: json?.date,
    time: json?.time,
    service: json?.service || EP_NAME,
    status: json?.status || "waiting",
    createdAt: json?.createdAt || null,
    notifiedAt: json?.notifiedAt || null,
    claimedAt: json?.claimedAt || null,
    user: {
      _id: userObj?._id?.toString?.() || json?.user?.toString?.() || "",
      name: userObj?.name || "",
      lastName: userObj?.lastName || "",
      email: userObj?.email || "",
      phone: userObj?.phone || "",
      dni: userObj?.dni || "",
    },
  };
}

function requiresApto(user) {
  if (!user?.createdAt) return false;
  const created = new Date(user.createdAt);
  const days = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
  return days > 20 && !user.aptoPath;
}

/* =========================
   Cupos + horarios por servicio
========================= */
const TOTAL_CAP = 6;
const EP_CAP_WHEN_THERAPY_ACTIVE = 4;
const THERAPY_CAP_WHEN_ACTIVE = 2;

const PE_NAME = "Primera evaluación presencial";
const EP_NAME = "Entrenamiento Personal";
const RA_NAME = "Rehabilitación activa";
const RF_NAME = "Reeducación funcional";

const TIMES_EP_WEEKDAY = [
  "07:00", "08:00", "09:00", "10:00",
  "11:00", "12:00", "13:30",
  "14:00", "15:00", "16:00", "17:00",
  "18:00", "19:00", "20:00",
];

const TIMES_REHAB_MWF = [
  "07:00", "08:00", "09:00", "10:00",
  "11:00", "12:00", "13:30", "14:00", "15:00",
];

const TIMES_REHAB_TT = [
  "07:00", "08:00", "09:00", "10:00",
  "11:00", "12:00",
  "15:00", "16:00", "17:00", "18:00",
];

const TIMES_DEFAULT = [
  "07:00", "08:00", "09:00", "10:00",
  "11:00", "12:00", "13:30",
  "18:00", "19:00", "20:00",
];

function isTherapyService(serviceName) {
  return sameService(serviceName, RA_NAME) || sameService(serviceName, RF_NAME);
}

function getRehabTimesForDate(dateStr) {
  const weekday = getWeekdayMondayFirst(dateStr);
  if ([1, 3, 5].includes(weekday)) return TIMES_REHAB_MWF;
  if ([2, 4].includes(weekday)) return TIMES_REHAB_TT;
  return [];
}

function getAllowedTimesForService(serviceName, dateStr = "") {
  if (!dateStr || isSaturday(dateStr) || isSunday(dateStr)) return [];

  if (sameService(serviceName, PE_NAME) || serviceToKey(serviceName) === "PE") {
    return TIMES_EP_WEEKDAY;
  }
  if (sameService(serviceName, EP_NAME)) return TIMES_EP_WEEKDAY;
  if (isTherapyService(serviceName)) return getRehabTimesForDate(dateStr);
  return TIMES_DEFAULT;
}

function isAllowedTimeForService(serviceName, dateStr, time) {
  const t = String(time || "").slice(0, 5);
  return getAllowedTimesForService(serviceName, dateStr).includes(t);
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
    therapyActive: isTherapyAreaActiveAt(dateStr, time),
  };
}

/* =========================
   CANCELACIÓN / REINTEGRO
========================= */
const CANCELLATION_POLICY_BY_SERVICE = {
  EP: {
    refundCutoffHours: 1,
    timelyRefundLimit: Infinity,
    lateRefundLimit: 1,
  },
  RA: {
    refundCutoffHours: 3,
    timelyRefundLimit: 2,
    lateRefundLimit: 1,
  },
  RF: {
    refundCutoffHours: 3,
    timelyRefundLimit: 2,
    lateRefundLimit: 1,
  },
  OTHER: {
    refundCutoffHours: 1,
    timelyRefundLimit: Infinity,
    lateRefundLimit: 1,
  },
};

function getCancellationPolicyForService(serviceName) {
  const sk = serviceToKey(serviceName);
  return CANCELLATION_POLICY_BY_SERVICE[sk] || CANCELLATION_POLICY_BY_SERVICE.OTHER;
}

function getMonthKey(dateValue = new Date()) {
  const dt = new Date(dateValue);
  if (Number.isNaN(dt.getTime())) return "";
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function countHistoryEntriesInMonth(user, matcher, refDate = new Date()) {
  const monthKey = getMonthKey(refDate);
  const history = Array.isArray(user?.history) ? user.history : [];

  return history.reduce((acc, item) => {
    const createdAt = item?.createdAt ? new Date(item.createdAt) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) return acc;
    if (getMonthKey(createdAt) !== monthKey) return acc;
    return matcher(item) ? acc + 1 : acc;
  }, 0);
}

function getHistoryServiceKey(item) {
  return serviceToKey(
    item?.serviceKey || item?.service || item?.serviceName || ""
  );
}

function countMonthlyRefundsByType(
  user,
  { serviceKey, refundType, refDate = new Date() } = {}
) {
  const wantedSk = String(serviceKey || "").toUpperCase().trim();
  const wantedType = String(refundType || "").trim();
  const wantedMonth = getMonthKey(refDate);
  const history = Array.isArray(user?.history) ? user.history : [];

  return history.reduce((acc, item) => {
    const explicitMonth = String(item?.policyMonthKey || "").trim();
    const explicitServiceKey = String(item?.policyServiceKey || "").toUpperCase().trim();
    const explicitRefundType = String(item?.policyRefundType || "").trim();

    const createdAt = item?.createdAt ? new Date(item.createdAt) : null;
    const inferredMonth =
      createdAt && !Number.isNaN(createdAt.getTime()) ? getMonthKey(createdAt) : "";
    const itemMonth = explicitMonth || inferredMonth;

    const itemSk = explicitServiceKey || getHistoryServiceKey(item);

    let itemType = explicitRefundType;
    if (!itemType) {
      const action = String(item?.action || "").trim();
      if (action === "cancelado_con_reintegro") itemType = "timely";
      else if (action === "cancelado_tarde_con_cortesia") itemType = "late";
      else itemType = "none";
    }

    if (itemMonth !== wantedMonth) return acc;
    if (wantedSk && itemSk !== wantedSk) return acc;
    if (itemType !== wantedType) return acc;

    return acc + 1;
  }, 0);
}

function buildCancellationHistoryMeta({ appointment, decision, now = new Date() }) {
  const serviceKey = serviceToKey(appointment?.service || "");
  const monthKey = getMonthKey(now);

  let refundType = "none";
  if (decision?.refundMode === "timely") refundType = "timely";
  if (decision?.refundMode === "late-courtesy") refundType = "late";

  return {
    policyMonthKey: monthKey,
    policyServiceKey: serviceKey,
    policyRefundType: refundType,
  };
}

function getMonthlyCancellationCounters(user, serviceName, refDate = new Date()) {
  const serviceKey = serviceToKey(serviceName);
  const policy = getCancellationPolicyForService(serviceName);

  const timelyLimit = Number(policy?.timelyRefundLimit);
  const lateLimit = Number(policy?.lateRefundLimit || 0);

  const timelyUsed = countMonthlyRefundsByType(user, {
    serviceKey,
    refundType: "timely",
    refDate,
  });

  const lateUsed = countMonthlyRefundsByType(user, {
    serviceKey,
    refundType: "late",
    refDate,
  });

  return {
    serviceKey,
    monthKey: getMonthKey(refDate),

    timelyLimit: Number.isFinite(timelyLimit) ? timelyLimit : null,
    timelyUsed,
    timelyRemaining: Number.isFinite(timelyLimit)
      ? Math.max(0, timelyLimit - timelyUsed)
      : null,

    lateLimit,
    lateUsed,
    lateRemaining: Math.max(0, lateLimit - lateUsed),
  };
}

function buildCancellationClientMessage({ appointment, decision, counters }) {
  const sk = serviceToKey(appointment?.service || "");

  if (decision?.refundMode === "timely") {
    if (sk === "RA" || sk === "RF") {
      if (counters.timelyRemaining > 0) {
        return `Cancelaste con el mínimo de anticipación. Te devolvimos el crédito. Te queda ${counters.timelyRemaining} cancelación en término disponible este mes.`;
      }

      return "Cancelaste con el mínimo de anticipación. Te devolvimos el crédito. Ya no te quedan más cancelaciones en término disponibles este mes. Si volvés a reservar y cancelás en término otra vez, el crédito se perderá.";
    }

    if (sk === "EP") {
      return "Cancelaste con el mínimo de anticipación. Te devolvimos el crédito.";
    }

    return "Cancelaste con el mínimo de anticipación. Te devolvimos el crédito.";
  }

  if (decision?.refundMode === "late-courtesy") {
    if (counters.lateRemaining > 0) {
      return `Cancelaste fuera de término, pero esta vez te devolvimos el crédito. Te queda ${counters.lateRemaining} cancelación fuera de término disponible este mes.`;
    }

    return "Cancelaste fuera de término, pero esta vez te devolvimos el crédito. Ya no te quedan más cancelaciones fuera de término disponibles este mes. Hasta el 01 del próximo mes, cualquier nueva cancelación fuera de término perderá el crédito.";
  }

  if (decision?.reason === "MONTHLY_TIMELY_REFUND_LIMIT_REACHED") {
    return "Cancelaste dentro del mínimo de anticipación, pero ya agotaste tus cancelaciones con reintegro disponibles para este mes. El crédito se da por perdido.";
  }

  if (decision?.reason === "MONTHLY_LATE_REFUND_LIMIT_REACHED") {
    return "Cancelaste fuera de término y ya agotaste tu única cancelación fuera de término con reintegro de este mes. El crédito se da por perdido.";
  }

  return decision?.refund
    ? "Cancelación realizada con reintegro."
    : "Cancelación realizada sin reintegro.";
}

function resolveCancellationPolicy({ user, appointment, hoursToStart }) {
  const service = appointment?.service || "";
  const serviceKey = serviceToKey(service);
  const policy = getCancellationPolicyForService(service);

  const refundCutoffHours = Number(policy.refundCutoffHours || 0);
  const hasProperNotice =
    Number.isFinite(Number(hoursToStart)) &&
    Number(hoursToStart) >= refundCutoffHours;

  if (hasProperNotice) {
    const timelyLimit = Number(policy.timelyRefundLimit);

    if (Number.isFinite(timelyLimit)) {
      const timelyUsed = countMonthlyRefundsByType(user, {
        serviceKey,
        refundType: "timely",
      });

      if (timelyUsed >= timelyLimit) {
        return {
          refund: false,
          refundMode: "none",
          refundCutoffHours,
          reason: "MONTHLY_TIMELY_REFUND_LIMIT_REACHED",
          historyAction: "cancelado_en_termino_sin_reintegro",
          serviceKey,
        };
      }
    }

    return {
      refund: true,
      refundMode: "timely",
      refundCutoffHours,
      reason: "WITH_NOTICE",
      historyAction: "cancelado_con_reintegro",
      serviceKey,
    };
  }

  const lateLimit = Number(policy.lateRefundLimit || 0);
  const lateUsed = countMonthlyRefundsByType(user, {
    serviceKey,
    refundType: "late",
  });

  if (lateUsed >= lateLimit) {
    return {
      refund: false,
      refundMode: "none",
      refundCutoffHours,
      reason: "MONTHLY_LATE_REFUND_LIMIT_REACHED",
      historyAction: "cancelado_sin_reintegro",
      serviceKey,
    };
  }

  return {
    refund: true,
    refundMode: "late-courtesy",
    refundCutoffHours,
    reason: "LATE_COURTESY",
    historyAction: "cancelado_tarde_con_cortesia",
    serviceKey,
  };
}

function lotsDebug(user) {
  return (Array.isArray(user?.creditLots) ? user.creditLots : []).map((lot) => ({
    id: String(lot?._id || ""),
    serviceKey: String(lot?.serviceKey || ""),
    amount: Number(lot?.amount || 0),
    remaining: Number(lot?.remaining || 0),
    expiresAt: lot?.expiresAt || null,
    source: String(lot?.source || ""),
  }));
}

/* =========================
   Helpers: validación de item
========================= */
function validateBasicSlotRules({ date, time, service }) {
  if (!date || !time || !service) {
    return { ok: false, error: "Faltan campos: date, time y service." };
  }

  if (isSaturday(date)) {
    return { ok: false, error: "Los sábados no hay turnos disponibles." };
  }

  if (isSunday(date)) {
    return { ok: false, error: "Los domingos no hay turnos disponibles." };
  }

  const timeNorm = String(time).slice(0, 5);

  if (timeNorm.startsWith("13:") && timeNorm !== "13:30") {
    return { ok: false, error: "Horario inválido." };
  }

  if (!isAllowedTimeForService(service, date, timeNorm)) {
    return {
      ok: false,
      error: "Ese horario no está disponible para el servicio seleccionado.",
    };
  }

  const turno = getTurnoFromTime(timeNorm);
  if (!turno) {
    return { ok: false, error: "Horario fuera del rango permitido." };
  }

  const slotDate = buildSlotDate(date, timeNorm);
  if (!slotDate) return { ok: false, error: "Fecha/hora inválida." };

  const w = validateBookingWindow(slotDate);
  if (!w.ok) return w;

  const adv = validateMinAdvance(slotDate, service);
  if (!adv.ok) return adv;

  const isEpService = sameService(service, EP_NAME);

  return { ok: true, turno, slotDate, isEpService };
}

function validateBasicSlotRulesAdmin({ date, time, service, bypassWindow = false }) {
  if (!date || !time || !service) {
    return { ok: false, error: "Faltan campos: date, time y service." };
  }

  if (isSaturday(date)) {
    return { ok: false, error: "Los sábados no hay turnos disponibles." };
  }

  if (isSunday(date)) {
    return { ok: false, error: "Los domingos no hay turnos disponibles." };
  }

  const timeNorm = String(time).slice(0, 5);

  if (timeNorm.startsWith("13:") && timeNorm !== "13:30") {
    return { ok: false, error: "Horario inválido." };
  }

  if (!isAllowedTimeForService(service, date, timeNorm)) {
    return {
      ok: false,
      error: "Ese horario no está disponible para el servicio seleccionado.",
    };
  }

  const turno = getTurnoFromTime(timeNorm);
  if (!turno) {
    return { ok: false, error: "Horario fuera del rango permitido." };
  }

  const slotDate = buildSlotDate(date, timeNorm);
  if (!slotDate) return { ok: false, error: "Fecha/hora inválida." };

  if (!bypassWindow) {
    const w = validateBookingWindow(slotDate);
    if (!w.ok) return w;

    const adv = validateMinAdvance(slotDate, service);
    if (!adv.ok) return adv;
  }

  const isEpService = sameService(service, EP_NAME);

  return { ok: true, turno, slotDate, isEpService, timeNorm };
}

function slotKey(date, time) {
  return `${date}__${time}`;
}

function isValidYMD(s) {
  if (typeof s !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function ymdAR(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addMonthsYmd(dateStr, months) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setMonth(dt.getMonth() + Number(months || 0));
  return ymdAR(dt);
}

function getWeekdayMondayFirst(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const js = new Date(y, (m || 1) - 1, d || 1).getDay();
  return js === 0 ? 7 : js;
}

function buildOccurrencesForFixedSchedule({ startDate, months, items }) {
  const out = [];
  const start = buildSlotDate(startDate, "00:00");
  const end = buildSlotDate(addMonthsYmd(startDate, months), "23:59");

  if (!start || !end) return out;

  const cursor = new Date(start);

  while (cursor <= end) {
    const date = ymdAR(cursor);
    const weekday = getWeekdayMondayFirst(date);

    for (const it of items || []) {
      if (Number(it?.weekday) === weekday) {
        out.push({
          date,
          time: String(it?.time || "").slice(0, 5),
        });
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return out.sort((a, b) => {
    const ak = `${a.date} ${a.time}`;
    const bk = `${b.date} ${b.time}`;
    return ak.localeCompare(bk);
  });
}

async function createAppointmentForTargetUser({
  userId,
  actorReq,
  date,
  time,
  service,
  notes = "",
  bypassWindow = false,
}) {
  const basic = validateBasicSlotRulesAdmin({ date, time, service, bypassWindow });
  if (!basic.ok) {
    const e = new Error(basic.error);
    e.http = 400;
    throw e;
  }

  const targetUser = await User.findById(userId);
  if (!targetUser) {
    const e = new Error("USER_NOT_FOUND");
    e.http = 404;
    throw e;
  }

  if (targetUser.suspended) {
    const e = new Error("USER_SUSPENDED");
    e.http = 403;
    throw e;
  }

  if (requiresApto(targetUser)) {
    const e = new Error("APTO_REQUIRED");
    e.http = 403;
    throw e;
  }

  recalcUserCredits(targetUser);
  if ((targetUser.credits || 0) <= 0) {
    const e = new Error("NO_CREDITS");
    e.http = 403;
    throw e;
  }

  const requestedSk = serviceToKey(service);
  if (!hasValidCreditsForServiceAndSlot(targetUser, requestedSk, basic.slotDate)) {
    const e = new Error(`NO_CREDITS_FOR_SLOT_${requestedSk}`);
    e.http = 403;
    throw e;
  }

  const t = String(time).slice(0, 5);

  const alreadyByUser = await Appointment.findOne({
    date,
    time: t,
    user: targetUser._id,
    status: "reserved",
  }).lean();

  if (alreadyByUser) {
    const e = new Error("ALREADY_HAVE_SLOT");
    e.http = 409;
    throw e;
  }

  const existingAtSlot = await Appointment.find({
    date,
    time: t,
    status: "reserved",
  }).lean();

  const stats = getSlotReservationStats(existingAtSlot, date, t);

  if (basic.isEpService) {
    if (stats.totalReserved >= TOTAL_CAP || stats.epReserved >= stats.epCap) {
      const e = new Error(
        stats.totalReserved >= TOTAL_CAP ? "TOTAL_CAP_REACHED" : "SERVICE_CAP_REACHED"
      );
      e.http = 409;
      throw e;
    }
  } else if (isTherapyService(service)) {
    if (stats.totalReserved >= TOTAL_CAP) {
      const e = new Error("TOTAL_CAP_REACHED");
      e.http = 409;
      throw e;
    }

    if (stats.therapyReserved >= stats.therapyCap) {
      const e = new Error("SERVICE_CAP_REACHED");
      e.http = 409;
      throw e;
    }
  } else if (stats.totalReserved >= TOTAL_CAP) {
    const e = new Error("TOTAL_CAP_REACHED");
    e.http = 409;
    throw e;
  }

  const consumed = await consumeCreditAtomic({
    userId: targetUser._id,
    serviceName: service,
    historyItem: {
      action: "reservado_por_admin",
      date,
      time: t,
      service,
      serviceName: service,
    },
    slotDate: basic.slotDate,
    session: null,
  });

  const effectiveUser = consumed.user;
  const usedLotId = consumed.usedLotId;
  const usedLotExp = consumed.usedLotExp;

  console.log("[BOOKING DEBUG AFTER CONSUME]", {
    userId: String(effectiveUser?._id || targetUser?._id || ""),
    service: service,
    usedLotId: String(usedLotId || ""),
    usedLotExp: usedLotExp || null,
    userCredits: Number(effectiveUser?.credits || 0),
    lots: serializeUserCreditLots(effectiveUser),
  });

  const created = await Appointment.create({
    date,
    time: t,
    service,
    user: targetUser._id,
    status: "reserved",
    creditLotId: usedLotId,
    creditExpiresAt: usedLotExp,
    createdByRole: String(actorReq?.user?.role || "").toLowerCase(),
    createdByUser: actorReq?.user?._id || actorReq?.user?.id || null,
    assignedManually: true,
  });

  const populated = await Appointment.findById(created._id)
    .populate("user", "name lastName email");

  await logActivity({
    req: actorReq,
    category: "appointments",
    action: "appointment_assigned_by_admin",
    entity: "appointment",
    entityId: String(created._id),
    title: "Turno asignado por admin",
    description: "Se asignó un turno a un usuario desde administración.",
    subject: buildUserSubject(targetUser),
    meta: {
      date,
      time: t,
      serviceName: service,
      assignedByAdmin: true,
    },
  });

  const serialized = serializeAppointment(populated);
  serialized.userCredits = Number(effectiveUser.credits || 0);
  serialized.userCreditLots = serializeUserCreditLots(effectiveUser);

  return serialized;
}

async function autoResolveFirstEvaluationCompletion({
  user,
  req,
  session,
  allowStandaloneCreditConsume = true,
}) {
  if (!user?._id) {
    return {
      cancelledAppointments: [],
      updatedUser: user,
      hadReservedFirstEvaluation: false,
      consumedStandaloneCredit: false,
    };
  }

  let updatedUser = user;
  const now = new Date();
  const actorRole = String(req.user?.role || "admin").toLowerCase() || "admin";
  const actorUserId = req.user?._id || req.user?.id || null;

  const reservedFirstEvaluations = await Appointment.find({
    user: user._id,
    status: "reserved",
    $or: [
      { service: PE_NAME },
      { service: "PE" },
      { service: /primera evaluaci/i },
    ],
  }).session(session);

  const cancelledAppointments = [];

  for (const ap of reservedFirstEvaluations) {
    ap.status = "cancelled";
    ap.cancelledAt = now;
    ap.cancelledByRole = actorRole;
    ap.cancelledByUser = actorUserId;
    ap.cancelReason = "FIRST_EVALUATION_COMPLETED_BY_ADMIN";
    ap.refundApplied = false;
    ap.refundMode = "none";
    await ap.save({ session });

    updatedUser.history = Array.isArray(updatedUser.history) ? updatedUser.history : [];
    updatedUser.history.push({
      action: "cancelado_por_primera_evaluacion_completada_por_admin",
      date: ap.date,
      time: ap.time,
      service: ap.service,
      serviceName: ap.service,
      createdAt: now,
    });

    cancelledAppointments.push({
      id: String(ap._id),
      date: ap.date,
      time: ap.time,
      service: ap.service,
    });
  }

  const hadReservedFirstEvaluation = cancelledAppointments.length > 0;
  let consumedStandaloneCredit = false;

  if (!hadReservedFirstEvaluation && allowStandaloneCreditConsume) {
    recalcUserCredits(updatedUser);

    const standalonePeLot = pickLotToConsume(updatedUser, "PE");

    if (standalonePeLot && Number(updatedUser.credits || 0) > 0) {
      const upd = await User.updateOne(
        {
          _id: updatedUser._id,
          "creditLots._id": standalonePeLot._id,
          "creditLots.remaining": { $gt: 0 },
        },
        {
          $inc: { "creditLots.$.remaining": -1 },
        },
        { session }
      );

      if (!upd.modifiedCount) {
        throw new Error("FIRST_EVALUATION_CREDIT_CONSUME_FAILED");
      }

      updatedUser = await User.findById(updatedUser._id).session(session);
      if (!updatedUser) throw new Error("USER_NOT_FOUND");

      updatedUser.history = Array.isArray(updatedUser.history) ? updatedUser.history : [];
      updatedUser.history.push({
        action: "consumo_credito_primera_evaluacion_por_completar_admin",
        service: PE_NAME,
        serviceName: PE_NAME,
        serviceKey: "PE",
        createdAt: now,
      });

      consumedStandaloneCredit = true;
    }
  }

  recalcUserCredits(updatedUser);
  await updatedUser.save({ session });

  return {
    cancelledAppointments,
    updatedUser,
    hadReservedFirstEvaluation,
    consumedStandaloneCredit,
  };
}

/* =========================
   AUTH required
========================= */
router.use(protect);

/* =========================
   POST /appointments/admin/:userId/complete-first-evaluation
========================= */
router.post("/admin/:userId/complete-first-evaluation", ensureStaff, async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const userId = String(req.params?.userId || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "Falta userId." });
    }

    let responsePayload = null;
    let activityUser = null;

    await session.withTransaction(async () => {
      let user = await User.findById(userId).session(session);
      if (!user) {
        throw new Error("USER_NOT_FOUND");
      }

      const alreadyCompleted = !!user.firstEvaluationCompleted;
      const resolution = await autoResolveFirstEvaluationCompletion({
        user,
        req,
        session,
        allowStandaloneCreditConsume: !alreadyCompleted,
      });

      user = resolution.updatedUser || user;

      if (!alreadyCompleted) {
        user.firstEvaluationCompleted = true;
        user.firstEvaluationCompletedAt = user.firstEvaluationCompletedAt || new Date();

        user.history = Array.isArray(user.history) ? user.history : [];
        user.history.push({
          action: "evaluacion_obligatoria_completada_por_admin",
          service: PE_NAME,
          serviceName: PE_NAME,
          createdAt: new Date(),
        });
      }

      recalcUserCredits(user);
      await user.save({ session });

      activityUser = user;
      responsePayload = {
        ok: true,
        user: {
          _id: user._id,
          firstEvaluationCompleted: !!user.firstEvaluationCompleted,
          firstEvaluationCompletedAt: user.firstEvaluationCompletedAt || null,
          credits: Number(user.credits || 0),
          creditLots: serializeUserCreditLots(user),
        },
        cancelledReservedFirstEvaluations: resolution.cancelledAppointments,
        consumedStandaloneFirstEvaluationCredit: !!resolution.consumedStandaloneCredit,
      };
    });

    await logActivity({
      req,
      category: "users",
      action: "first_evaluation_completed_by_admin",
      entity: "user",
      entityId: String(activityUser?._id || userId),
      title: "Evaluación obligatoria completada",
      description: "Se marcó manualmente la evaluación obligatoria como completada.",
      subject: buildUserSubject(activityUser || { _id: userId }),
      meta: {
        firstEvaluationCompleted: true,
        firstEvaluationCompletedAt: responsePayload?.user?.firstEvaluationCompletedAt || null,
        cancelledReservedFirstEvaluationsCount: Array.isArray(responsePayload?.cancelledReservedFirstEvaluations)
          ? responsePayload.cancelledReservedFirstEvaluations.length
          : 0,
        consumedStandaloneFirstEvaluationCredit: !!responsePayload?.consumedStandaloneFirstEvaluationCredit,
      },
    });

    return res.json(responsePayload);
  } catch (err) {
    console.error("Error en POST /appointments/admin/:userId/complete-first-evaluation:", err);

    if (String(err?.message || "") === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    if (String(err?.message || "") === "FIRST_EVALUATION_CREDIT_CONSUME_FAILED") {
      return res.status(409).json({
        error: "No se pudo descontar el crédito de primera evaluación.",
      });
    }

    return res.status(500).json({
      error: "No se pudo completar la evaluación obligatoria.",
    });
  } finally {
    await session.endSession();
  }
});

/* =========================
   POST /appointments/admin/:userId/complete-apto
========================= */
router.post("/admin/:userId/complete-apto", ensureStaff, async (req, res) => {
  try {
    const userId = String(req.params?.userId || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "Falta userId." });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    if (!user.aptoPath) {
      user.aptoPath = "ADMIN_COMPLETED_APTO";
      user.aptoCompletedAt = new Date();

      user.history = Array.isArray(user.history) ? user.history : [];
      user.history.push({
        action: "apto_completado_por_admin",
        createdAt: new Date(),
      });

      await user.save();
    }

    await logActivity({
      req,
      category: "users",
      action: "apto_completed_by_admin",
      entity: "user",
      entityId: String(user._id),
      title: "Apto completado",
      description: "Se marcó manualmente el apto como completado.",
      subject: buildUserSubject(user),
      meta: {
        aptoPath: user.aptoPath || null,
        aptoCompletedAt: user.aptoCompletedAt || null,
      },
    });

    return res.json({
      ok: true,
      user: {
        _id: user._id,
        aptoPath: user.aptoPath || null,
        aptoCompletedAt: user.aptoCompletedAt || null,
      },
    });
  } catch (err) {
    console.error("Error en POST /appointments/admin/:userId/complete-apto:", err);
    return res.status(500).json({
      error: "No se pudo completar el apto.",
    });
  }
});

/* =========================
   GET /appointments/me/status
========================= */
router.get("/me/status", async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;

    const user = await syncPastAppointmentsForUserId(userId);
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    return res.json({
      ok: true,
      firstEvaluationCompleted: !!user.firstEvaluationCompleted,
      firstEvaluationCompletedAt: user.firstEvaluationCompletedAt || null,
      credits: Number(user.credits || 0),
    });
  } catch (err) {
    console.error("Error en GET /appointments/me/status:", err);
    return res.status(500).json({
      error: "No se pudo obtener el estado del usuario.",
    });
  }
});

/* =========================
   GET /appointments/waitlist
========================= */
router.get("/waitlist", ensureStaff, async (req, res) => {
  try {
    const items = await WaitlistEntry.find({
      status: { $in: ACTIVE_WAITLIST_STATUSES },
    })
      .populate("user", "name lastName email phone dni")
      .sort({ date: 1, time: 1, priorityOrder: 1, createdAt: 1 })
      .lean();

    return res.json(items.map(serializeWaitlistEntry));
  } catch (err) {
    console.error("Error en GET /appointments/waitlist:", err);
    return res.status(500).json({ error: "No se pudo cargar la lista de espera." });
  }
});

/* =========================
   DELETE /appointments/waitlist/:id
========================= */
router.delete("/waitlist/:id", ensureStaff, async (req, res) => {
  try {
    const item = await WaitlistEntry.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: "Elemento de lista de espera no encontrado." });
    }

    item.status = "removed";
    item.removedAt = new Date();
    item.removedBy = req.user?._id || req.user?.id || null;
    item.closeReason = "MANUAL_CLOSE";
    await item.save();

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error en DELETE /appointments/waitlist/:id:", err);
    return res.status(500).json({ error: "No se pudo quitar de la lista de espera." });
  }
});

/* =========================
   GET /appointments/availability
========================= */
router.get("/availability", async (req, res) => {
  try {
    const date = String(req.query?.date || "").slice(0, 10);
    const service = String(req.query?.service || "").trim();

    if (!date || !service) {
      return res.status(400).json({ error: "Faltan params: date y service." });
    }

    const allowedTimes = getAllowedTimesForService(service, date);

    const times =
      Array.isArray(req.query?.times) && req.query.times.length
        ? req.query.times
            .map((x) => String(x).slice(0, 5))
            .filter((t) => allowedTimes.includes(t))
        : allowedTimes;

    const requesterId = req.user?._id || req.user?.id;
    const requesterRole = String(req.user?.role || "");

    if (requesterId && requesterRole !== "admin") {
      await syncPastAppointmentsForUserId(requesterId);

      const me = await User.findById(requesterId)
        .select("role suspended aptoPath createdAt credits creditLots firstEvaluationCompleted firstEvaluationCompletedAt")
        .lean();

      if (!me) {
        return res.status(403).json({ error: "Usuario no encontrado." });
      }

      if (me.suspended) {
        return res.json({
          date,
          service,
          slots: times.map((t) => ({
            time: t,
            state: "closed",
            reason: "Cuenta suspendida",
          })),
        });
      }

      if (requiresApto(me)) {
        return res.json({
          date,
          service,
          slots: times.map((t) => ({
            time: t,
            state: "closed",
            reason: "Falta apto médico",
          })),
        });
      }

      if (!me.firstEvaluationCompleted && !isFirstEvaluationService(service)) {
        return res.json({
          date,
          service,
          slots: times.map((t) => ({
            time: t,
            state: "closed",
            reason: "Primero debés completar tu primera evaluación presencial.",
          })),
        });
      }
    }

    if (isSaturday(date) || isSunday(date)) {
      return res.json({
        date,
        service,
        slots: times.map((t) => ({
          time: t,
          state: "closed",
          reason: isSunday(date)
            ? "Domingos no disponibles"
            : "Sábados no disponibles",
        })),
      });
    }

    const out = [];

    for (const time of times) {
      const t = String(time).slice(0, 5);
      const basic = validateBasicSlotRules({ date, time: t, service });

      if (!basic.ok) {
        out.push({ time: t, state: "closed", reason: basic.error });
        continue;
      }

      if (requesterId && requesterRole !== "admin") {
        const me = await User.findById(requesterId)
          .select("credits creditLots firstEvaluationCompleted")
          .lean();

        if (!hasValidCreditsForServiceAndSlot(me, service, basic.slotDate)) {
          out.push({
            time: t,
            state: "closed",
            reason: "No tenés sesiones válidas para ese día y horario",
          });
          continue;
        }
      }

      const existing = await Appointment.find({ date, time: t, status: "reserved" })
        .select("service")
        .lean();

      const stats = getSlotReservationStats(existing, date, t);
      const isTherapy = isTherapyService(service);

      if (basic.isEpService) {
        if (stats.totalReserved >= TOTAL_CAP || stats.epReserved >= stats.epCap) {
          const waitlistCheck = validateWaitlistOpen(basic.slotDate, service);

          out.push({
            time: t,
            state: waitlistCheck.ok ? "waitlist" : "waitlist_closed",
            reason: waitlistCheck.ok ? "" : waitlistCheck.error,
            totalReserved: stats.totalReserved,
            epReserved: stats.epReserved,
            epCap: stats.epCap,
            therapyReserved: stats.therapyReserved,
            therapyCap: stats.therapyCap,
          });
          continue;
        }
      } else if (isTherapy) {
        if (stats.totalReserved >= TOTAL_CAP || stats.therapyReserved >= stats.therapyCap) {
          out.push({
            time: t,
            state: "full",
            totalReserved: stats.totalReserved,
            therapyReserved: stats.therapyReserved,
            therapyCap: stats.therapyCap,
          });
          continue;
        }
      } else if (stats.totalReserved >= TOTAL_CAP) {
        out.push({ time: t, state: "full", totalReserved: stats.totalReserved });
        continue;
      }

      out.push({
        time: t,
        state: "available",
        totalReserved: stats.totalReserved,
        epReserved: stats.epReserved,
        epCap: stats.epCap,
        therapyReserved: stats.therapyReserved,
        therapyCap: stats.therapyCap,
      });
    }

    return res.json({ date, service, slots: out });
  } catch (e) {
    console.error("Error en GET /appointments/availability:", e);
    return res.status(500).json({ error: "Error calculando disponibilidad." });
  }
});

/* =========================
   GET /appointments
========================= */
router.get("/", async (req, res) => {
  try {
    const scope = String(req.query?.scope || "mine");
    const from = req.query?.from;
    const to = req.query?.to;
    const includePast = String(req.query?.includePast || "0") === "1";

    const hasFrom = isValidYMD(from);
    const hasTo = isValidYMD(to);

    const tokenUserId = req.user?._id || req.user?.id;
    const role = String(req.user?.role || "").toLowerCase();
    const isStaff = role === "admin" || role === "profesor" || role === "staff";

    if (scope === "calendar") {
      const q = { status: "reserved" };

      if (hasFrom && hasTo) q.date = { $gte: from, $lt: to };
      else if (hasFrom) q.date = { $gte: from };
      else q.date = { $gte: ymdAR() };

      const list = await Appointment.find(q)
        .select("_id date time service status")
        .lean();

      return res.json(
        (list || []).map((a) => ({
          id: a?._id?.toString?.() || String(a?._id || ""),
          date: a?.date,
          time: a?.time,
          service: a?.service || "",
          status: a?.status || "reserved",
        }))
      );
    }

    if (scope === "all") {
      if (!isStaff) return res.status(403).json({ error: "No autorizado." });

      const q = {};
      if (hasFrom && hasTo) q.date = { $gte: from, $lt: to };
      else if (hasFrom) q.date = { $gte: from };

      const list = await Appointment.find(q)
        .populate("user", "name lastName email")
        .lean();

      return res.json((list || []).map(serializeAppointment));
    }

    await syncPastAppointmentsForUserId(tokenUserId);

    const q = { user: tokenUserId, status: { $ne: "cancelled" } };

    if (hasFrom && hasTo) q.date = { $gte: from, $lt: to };
    else if (hasFrom) q.date = { $gte: from };
    else if (!includePast) q.date = { $gte: ymdAR() };

    const list = await Appointment.find(q)
      .sort({ date: 1, time: 1 })
      .lean();

    return res.json(
      (list || []).map((a) => ({
        id: a?._id?.toString?.() || String(a?._id || ""),
        date: a?.date,
        time: a?.time,
        service: a?.service || "",
        status: a?.status || "reserved",
        coach: a?.coach || "",
        creditExpiresAt: a?.creditExpiresAt || null,
        completedAt: a?.completedAt || null,
        userId: String(a?.user || ""),
      }))
    );
  } catch (err) {
    console.error("Error en GET /appointments:", err);
    res.status(500).json({ error: "Error al obtener turnos." });
  }
});

/* =========================
   POST /appointments/admin/assign
========================= */
router.post("/admin/assign", async (req, res) => {
  try {
    const role = String(req.user?.role || "").toLowerCase();
    if (!["admin", "profesor", "staff"].includes(role)) {
      return res.status(403).json({
        error: "Solo staff, profesor o admin pueden asignar turnos.",
      });
    }

    const userId = String(req.body?.userId || "").trim();
    const notes = String(req.body?.notes || "").trim();

    if (!userId) {
      return res.status(400).json({ error: "Falta userId." });
    }

    const items =
      Array.isArray(req.body?.items) && req.body.items.length
        ? req.body.items
        : req.body?.date && req.body?.time && req.body?.service
          ? [{ date: req.body.date, time: req.body.time, service: req.body.service }]
          : [];

    if (!items.length) {
      return res.status(400).json({ error: "Faltan items para asignar." });
    }

    const created = [];
    const conflicts = [];

    for (const it of items) {
      try {
        const ap = await createAppointmentForTargetUser({
          userId,
          actorReq: req,
          date: String(it?.date || "").slice(0, 10),
          time: String(it?.time || "").slice(0, 5),
          service: String(it?.service || "").trim(),
          notes,
          bypassWindow: true,
        });
        created.push(ap);
      } catch (e) {
        conflicts.push({
          date: String(it?.date || "").slice(0, 10),
          time: String(it?.time || "").slice(0, 5),
          service: String(it?.service || "").trim(),
          error: e?.message || "No se pudo asignar.",
        });
      }
    }

    if (!created.length && conflicts.length) {
      return res.status(409).json({
        error: conflicts[0]?.error || "No se pudo asignar ningún turno.",
        createdCount: 0,
        conflictsCount: conflicts.length,
        conflicts,
      });
    }

    return res.status(201).json({
      ok: true,
      items: created,
      createdCount: created.length,
      conflictsCount: conflicts.length,
      conflicts,
    });
  } catch (err) {
    console.error("Error en POST /appointments/admin/assign:", err);
    return res.status(500).json({ error: "Error al asignar turnos." });
  }
});

/* =========================
   POST /appointments/admin/fixed-schedules
========================= */
router.post("/admin/fixed-schedules", async (req, res) => {
  try {
    const role = String(req.user?.role || "").toLowerCase();
    if (!["admin", "profesor", "staff"].includes(role)) {
      return res.status(403).json({
        error: "Solo staff, profesor o admin pueden crear turnos fijos.",
      });
    }

    const userId = String(req.body?.userId || "").trim();
    const service = String(req.body?.service || "").trim();
    const notes = String(req.body?.notes || "").trim();
    const months = Math.max(1, Math.min(12, Number(req.body?.months || 1)));
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!userId) return res.status(400).json({ error: "Falta userId." });
    if (!service) return res.status(400).json({ error: "Falta service." });
    if (!items.length) return res.status(400).json({ error: "Faltan días fijos." });

    const cleanItems = items
      .map((it) => ({
        weekday: Number(it?.weekday || 0),
        time: String(it?.time || "").slice(0, 5),
      }))
      .filter((it) => it.weekday >= 1 && it.weekday <= 5 && !!it.time);

    if (!cleanItems.length) {
      return res.status(400).json({ error: "No hay items válidos para guardar." });
    }

    const startDate = ymdAR(new Date());
    const endDate = addMonthsYmd(startDate, months);

    const fixed = await FixedSchedule.create({
      user: userId,
      createdBy: req.user?._id || req.user?.id,
      service,
      items: cleanItems,
      months,
      startDate,
      endDate,
      notes,
      active: true,
    });

    const occurrences = buildOccurrencesForFixedSchedule({
      startDate,
      months,
      items: cleanItems,
    });

    const created = [];
    const conflicts = [];

    for (const occ of occurrences) {
      try {
        const ap = await createAppointmentForTargetUser({
          userId,
          actorReq: req,
          date: occ.date,
          time: occ.time,
          service,
          notes,
          bypassWindow: true,
        });
        created.push(ap);
      } catch (e) {
        conflicts.push({
          date: occ.date,
          time: occ.time,
          service,
          error: e?.message || "No se pudo crear.",
        });
      }
    }

    return res.status(201).json({
      ok: true,
      fixedScheduleId: String(fixed._id),
      createdCount: created.length,
      conflictsCount: conflicts.length,
      items: created,
      conflicts,
    });
  } catch (err) {
    console.error("Error en POST /appointments/admin/fixed-schedules:", err);
    return res.status(500).json({ error: "Error al guardar turnos fijos." });
  }
});

/* =========================
   POST /appointments
========================= */
router.post("/", async (req, res) => {
  const session = await mongoose.startSession();

  let mailUser = null;
  let mailAp = null;
  let mailServiceName = null;

  try {
    const { date, time, service, notes = "" } = req.body || {};
    const basic = validateBasicSlotRules({ date, time, service });
    if (!basic.ok) return res.status(400).json({ error: basic.error });

    const userId = req.user._id || req.user.id;
    let out = null;

    await session.withTransaction(async () => {
      let user = await User.findById(userId).session(session);
      if (!user) throw new Error("USER_NOT_FOUND");

      user = (await syncPastAppointmentsForUserId(userId, session)) || user;

      if (user.suspended) throw new Error("USER_SUSPENDED");
      if (requiresApto(user)) throw new Error("APTO_REQUIRED");
      if (!user.firstEvaluationCompleted && !isFirstEvaluationService(service)) {
        throw new Error("FIRST_EVALUATION_REQUIRED");
      }

      recalcUserCredits(user);
      if ((user.credits || 0) <= 0) throw new Error("NO_CREDITS");

      const requestedSk = serviceToKey(service);
      if (!hasValidCreditsForServiceAndSlot(user, requestedSk, basic.slotDate)) {
        throw new Error(`NO_CREDITS_FOR_SLOT_${requestedSk}`);
      }

      const t = String(time).slice(0, 5);

      const alreadyByUser = await Appointment.findOne({
        date,
        time: t,
        user: user._id,
        status: "reserved",
      }).session(session).lean();

      if (alreadyByUser) throw new Error("ALREADY_HAVE_SLOT");

      const existingAtSlot = await Appointment.find({
        date,
        time: t,
        status: "reserved",
      }).session(session).lean();

      let willWaitlist = false;
      const stats = getSlotReservationStats(existingAtSlot, date, t);

      if (basic.isEpService) {
        if (stats.totalReserved >= TOTAL_CAP || stats.epReserved >= stats.epCap) {
          willWaitlist = true;
        }
      } else if (isTherapyService(service)) {
        if (stats.totalReserved >= TOTAL_CAP) throw new Error("TOTAL_CAP_REACHED");
        if (stats.therapyReserved >= stats.therapyCap) {
          throw new Error("SERVICE_CAP_REACHED");
        }
      } else if (stats.totalReserved >= TOTAL_CAP) {
        throw new Error("TOTAL_CAP_REACHED");
      }

      if (willWaitlist && basic.isEpService) {
        const wlWindow = validateWaitlistOpen(basic.slotDate, service);
        if (!wlWindow.ok) throw new Error("WAITLIST_CLOSED");

        const wlExists = await WaitlistEntry.findOne({
          user: user._id,
          date,
          time: t,
          service: EP_NAME,
          status: { $in: ACTIVE_WAITLIST_STATUSES },
        }).session(session);

        if (wlExists) throw new Error("ALREADY_IN_WAITLIST");

        const lastPriority = await WaitlistEntry.findOne({
          date,
          time: t,
          service: EP_NAME,
          status: { $in: ACTIVE_WAITLIST_STATUSES },
        })
          .sort({ priorityOrder: -1, createdAt: -1 })
          .session(session)
          .lean();

        const nextPriority = Number(lastPriority?.priorityOrder || 0) + 1;

        const [createdWaitlist] = await WaitlistEntry.create(
          [{
            user: user._id,
            date,
            time: t,
            service: EP_NAME,
            status: "waiting",
            notes: String(notes || "").trim(),
            priorityOrder: nextPriority,
            createdByUser: user._id,
            createdByRole: String(req.user?.role || "client").toLowerCase(),
          }],
          { session }
        );

        recalcUserCredits(user);

        out = {
          kind: "waitlist",
          id: String(createdWaitlist._id),
          date,
          time: t,
          service: EP_NAME,
          status: "waiting",
          priorityOrder: nextPriority,
          createdAt: createdWaitlist.createdAt || new Date(),
          userCredits: Number(user.credits || 0),
          userCreditLots: serializeUserCreditLots(user),
          firstEvaluationCompleted: !!user.firstEvaluationCompleted,
          firstEvaluationCompletedAt: user.firstEvaluationCompletedAt || null,
        };
        return;
      }

      let usedLotId = null;
      let usedLotExp = null;
      let effectiveUser = user;

      const consumed = await consumeCreditAtomic({
        userId: user._id,
        serviceName: service,
        historyItem: {
          action: "reservado",
          date,
          time: t,
          service,
          serviceName: service,
        },
        slotDate: basic.slotDate,
        session,
      });

      effectiveUser = consumed.user;
      usedLotId = consumed.usedLotId;
      usedLotExp = consumed.usedLotExp;

      console.log("[BOOKING DEBUG AFTER CONSUME]", {
        userId: String(effectiveUser?._id || user?._id || ""),
        service,
        usedLotId: String(usedLotId || ""),
        usedLotExp: usedLotExp || null,
        userCredits: Number(effectiveUser?.credits || 0),
        lots: serializeUserCreditLots(effectiveUser),
      });

      const created = await Appointment.create(
        [{
          date,
          time: t,
          service,
          user: user._id,
          status: "reserved",
          creditLotId: usedLotId,
          creditExpiresAt: usedLotExp,
          createdByRole: String(req.user?.role || "").toLowerCase(),
          createdByUser: req.user?._id || req.user?.id || null,
        }],
        { session }
      );

      const populated = await Appointment.findById(created[0]._id)
        .populate("user", "name lastName email")
        .session(session);

      out = {
        ...serializeAppointment(populated),
        userCredits: Number(effectiveUser.credits || 0),
        userCreditLots: serializeUserCreditLots(effectiveUser),
        firstEvaluationCompleted: !!effectiveUser.firstEvaluationCompleted,
        firstEvaluationCompletedAt: effectiveUser.firstEvaluationCompletedAt || null,
      };

      mailUser = { ...effectiveUser.toObject(), _id: effectiveUser._id };
      mailAp = { date, time: t, service };
      mailServiceName = service;
    });

    if (out?.kind === "waitlist") {
      await logActivity({
        req,
        category: "appointments",
        action: "waitlist_joined",
        entity: "waitlist",
        entityId:
          String(out?.date || "") +
          "-" +
          String(out?.time || "") +
          "-" +
          String(req.user?._id || ""),
        title: "Lista de espera",
        description: "Se agregó a lista de espera de turnos.",
        subject: buildUserSubject(req.user),
        meta: {
          date: out?.date,
          time: out?.time,
          serviceName: out?.service,
          priorityOrder: out?.priorityOrder || null,
        },
      });
    } else if (out?.id) {
      await logActivity({
        req,
        category: "appointments",
        action: "appointment_reserved",
        entity: "appointment",
        entityId: out.id,
        title: "Turno reservado",
        description: "Se registró una nueva reserva.",
        subject: buildUserSubject(req.user),
        meta: {
          date: out?.date,
          time: out?.time,
          serviceName: out?.service,
        },
      });
    }

    const httpCode = out?.kind === "waitlist" ? 202 : 201;
    res.status(httpCode).json(out);

    if (mailUser && mailAp && out?.kind !== "waitlist") {
      fireAndForget(async () => {
        try {
          await sendAppointmentBookedEmail(mailUser, mailAp, mailServiceName);
        } catch (e) {
          console.log("[MAIL] booked error:", e?.message || e);
          await sendAdminCopy({ kind: "booked", user: mailUser, ap: mailAp });
        }
      }, "MAIL_BOOKED");
    }
  } catch (err) {
    console.error("Error en POST /appointments:", err);
    const msg = String(err?.message || "");

    if (msg === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }
    if (msg === "USER_SUSPENDED") {
      return res.status(403).json({ error: "Cuenta suspendida." });
    }
    if (msg === "APTO_REQUIRED") {
      return res.status(403).json({ error: "Falta apto médico." });
    }
    if (msg === "FIRST_EVALUATION_REQUIRED") {
      return res.status(403).json({
        error: "Primero debés completar tu primera evaluación presencial.",
      });
    }
    if (msg === "NO_CREDITS") {
      return res.status(403).json({ error: "Sin créditos disponibles." });
    }
    if (msg.startsWith("NO_CREDITS_FOR_SLOT_")) {
      return res.status(403).json({
        error: "No tenés sesiones válidas para ese día y horario.",
      });
    }
    if (msg === "ALREADY_HAVE_SLOT") {
      return res.status(409).json({ error: "Ya tenés un turno reservado en ese horario." });
    }
    if (msg === "WAITLIST_CLOSED") {
      return res.status(409).json({
        error: "La lista de espera para ese servicio y horario ya está cerrada.",
      });
    }
    if (msg === "ALREADY_IN_WAITLIST") {
      return res.status(409).json({ error: "Ya estás anotado/a en la lista de espera de ese horario." });
    }
    if (msg === "SERVICE_CAP_REACHED") {
      return res.status(409).json({ error: "Ese servicio ya alcanzó su cupo para ese horario." });
    }
    if (msg === "TOTAL_CAP_REACHED") {
      return res.status(409).json({ error: "Se alcanzó el cupo total disponible para ese horario." });
    }

    return res.status(500).json({ error: "No se pudo reservar el turno." });
  } finally {
    await session.endSession();
  }
});

/* =========================
   POST /appointments/batch
========================= */
router.post("/batch", async (req, res) => {
  const session = await mongoose.startSession();

  let mailUser = null;
  let mailItems = null;
  let responseItems = [];

  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ error: "Faltan items para reservar." });
    }

    const userId = req.user?._id || req.user?.id;

    await session.withTransaction(async () => {
      let user = await User.findById(userId).session(session);
      if (!user) throw new Error("USER_NOT_FOUND");

      user = (await syncPastAppointmentsForUserId(userId, session)) || user;

      if (user.suspended) throw new Error("USER_SUSPENDED");
      if (requiresApto(user)) throw new Error("APTO_REQUIRED");

      const basicItems = items.map((it) => {
        const date = String(it?.date || "").slice(0, 10);
        const time = String(it?.time || "").slice(0, 5);
        const service = String(it?.service || "").trim();

        const basic = validateBasicSlotRules({ date, time, service });
        if (!basic.ok) {
          const e = new Error(basic.error);
          e.http = 400;
          throw e;
        }

        return {
          date,
          time,
          service,
          ...basic,
        };
      });

      for (const it of basicItems) {
        if (!user.firstEvaluationCompleted && !isFirstEvaluationService(it.service)) {
          throw new Error("FIRST_EVALUATION_REQUIRED");
        }
      }

      recalcUserCredits(user);
      const needed = basicItems.length;
      if ((user.credits || 0) < needed) throw new Error("NO_CREDITS");

      const seen = new Set();
      for (const it of basicItems) {
        const k = slotKey(it.date, it.time);
        if (seen.has(k)) throw new Error("DUPLICATED_SLOT_IN_REQUEST");
        seen.add(k);
      }

      for (const it of basicItems) {
        const requestedSk = serviceToKey(it.service);
        if (!hasValidCreditsForServiceAndSlot(user, requestedSk, it.slotDate)) {
          throw new Error(`NO_CREDITS_FOR_SLOT_${requestedSk}`);
        }

        const alreadyByUser = await Appointment.findOne({
          date: it.date,
          time: it.time,
          user: user._id,
          status: "reserved",
        }).session(session).lean();

        if (alreadyByUser) throw new Error("ALREADY_HAVE_SLOT");

        const existingAtSlot = await Appointment.find({
          date: it.date,
          time: it.time,
          status: "reserved",
        }).session(session).lean();

        const stats = getSlotReservationStats(existingAtSlot, it.date, it.time);

        if (it.isEpService) {
          if (stats.totalReserved >= TOTAL_CAP || stats.epReserved >= stats.epCap) {
            throw new Error("SERVICE_CAP_REACHED");
          }
        } else if (isTherapyService(it.service)) {
          if (stats.totalReserved >= TOTAL_CAP) throw new Error("TOTAL_CAP_REACHED");
          if (stats.therapyReserved >= stats.therapyCap) {
            throw new Error("SERVICE_CAP_REACHED");
          }
        } else if (stats.totalReserved >= TOTAL_CAP) {
          throw new Error("TOTAL_CAP_REACHED");
        }
      }

      for (const it of basicItems) {
        const consumed = await consumeCreditAtomic({
          userId: user._id,
          serviceName: it.service,
          historyItem: {
            action: "reservado",
            date: it.date,
            time: it.time,
            service: it.service,
            serviceName: it.service,
          },
          slotDate: it.slotDate,
          session,
        });

        user = consumed.user;

        console.log("[BOOKING DEBUG AFTER CONSUME]", {
          userId: String(user?._id || ""),
          service: it.service,
          usedLotId: String(consumed.usedLotId || ""),
          usedLotExp: consumed.usedLotExp || null,
          userCredits: Number(user?.credits || 0),
          lots: serializeUserCreditLots(user),
        });

        const created = await Appointment.create(
          [{
            date: it.date,
            time: it.time,
            service: it.service,
            user: user._id,
            status: "reserved",
            creditLotId: consumed.usedLotId,
            creditExpiresAt: consumed.usedLotExp,
            createdByRole: String(req.user?.role || "").toLowerCase(),
            createdByUser: req.user?._id || req.user?.id || null,
          }],
          { session }
        );

        const populated = await Appointment.findById(created[0]._id)
          .populate("user", "name lastName email")
          .session(session);

        responseItems.push({
          ...serializeAppointment(populated),
          userCredits: Number(user.credits || 0),
          userCreditLots: serializeUserCreditLots(user),
          firstEvaluationCompleted: !!user.firstEvaluationCompleted,
          firstEvaluationCompletedAt: user.firstEvaluationCompletedAt || null,
        });
      }

      mailUser = { ...user.toObject(), _id: user._id };
      mailItems = responseItems.map((x) => ({
        date: x.date,
        time: x.time,
        service: x.service,
      }));
    });

    if (responseItems.length) {
      await logActivity({
        req,
        category: "appointments",
        action: "appointments_reserved_batch",
        entity: "appointment",
        entityId: responseItems.map((x) => x.id).join(","),
        title: "Turnos reservados",
        description: "Se registraron múltiples reservas.",
        subject: buildUserSubject(req.user),
        meta: {
          items: responseItems.map((x) => ({
            date: x.date,
            time: x.time,
            serviceName: x.service,
          })),
        },
      });
    }

    res.status(201).json({ items: responseItems });

    if (mailUser && mailItems?.length) {
      fireAndForget(async () => {
        try {
          await sendAppointmentBookedBatchEmail(mailUser, mailItems);
        } catch (e) {
          console.log("[MAIL] booked batch error:", e?.message || e);
          await sendAdminCopy({ kind: "booked_batch", user: mailUser, ap: mailItems });
        }
      }, "MAIL_BOOKED_BATCH");
    }
  } catch (err) {
    console.error("Error en POST /appointments/batch:", err);
    const msg = String(err?.message || "");

    if (msg === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }
    if (msg === "USER_SUSPENDED") {
      return res.status(403).json({ error: "Cuenta suspendida." });
    }
    if (msg === "APTO_REQUIRED") {
      return res.status(403).json({ error: "Falta apto médico." });
    }
    if (msg === "FIRST_EVALUATION_REQUIRED") {
      return res.status(403).json({
        error: "Primero debés completar tu primera evaluación presencial.",
      });
    }
    if (msg === "NO_CREDITS") {
      return res.status(403).json({ error: "Sin créditos suficientes." });
    }
    if (msg.startsWith("NO_CREDITS_FOR_SLOT_")) {
      return res.status(403).json({
        error: "No tenés sesiones válidas para alguno de los turnos elegidos.",
      });
    }
    if (msg === "ALREADY_HAVE_SLOT") {
      return res.status(409).json({ error: "Ya tenés un turno reservado en uno de esos horarios." });
    }
    if (msg === "DUPLICATED_SLOT_IN_REQUEST") {
      return res.status(400).json({ error: "Hay horarios duplicados en la misma reserva." });
    }
    if (msg === "SERVICE_CAP_REACHED") {
      return res.status(409).json({ error: "Uno de los servicios ya alcanzó su cupo para ese horario." });
    }
    if (msg === "TOTAL_CAP_REACHED") {
      return res.status(409).json({ error: "Se alcanzó el cupo total disponible para uno de los horarios." });
    }

    return res.status(500).json({ error: "No se pudieron reservar los turnos." });
  } finally {
    await session.endSession();
  }
});

/* =========================
   DELETE /appointments/:id
========================= */
router.delete("/:id", async (req, res) => {
  const session = await mongoose.startSession();

  let mailUser = null;
  let mailAp = null;
  let responsePayload = null;

  try {
    console.log("[DELETE APPOINTMENT HIT]", {
      appointmentId: String(req.params?.id || ""),
      userId: String(req.user?._id || req.user?.id || ""),
      role: String(req.user?.role || ""),
    });

    const tokenUserId = req.user?._id || req.user?.id;
    const role = String(req.user?.role || "").toLowerCase();

    await session.withTransaction(async () => {
      const ap = await Appointment.findById(req.params.id).session(session);
      if (!ap) throw new Error("APPOINTMENT_NOT_FOUND");

      const isOwner = String(ap.user) === String(tokenUserId);
      const isStaff = ["admin", "profesor", "staff"].includes(role);

      if (!isOwner && !isStaff) {
        throw new Error("NOT_AUTHORIZED");
      }

      if (String(ap.status || "") !== "reserved") {
        throw new Error("APPOINTMENT_NOT_RESERVED");
      }

      const user = await User.findById(ap.user).session(session);
      if (!user) throw new Error("USER_NOT_FOUND");

      const slotDate = buildSlotDate(ap.date, ap.time);
      if (!slotDate) throw new Error("INVALID_SLOT_DATE");

      const now = new Date();
      const hoursToStart = (slotDate.getTime() - now.getTime()) / (1000 * 60 * 60);

      const decision = resolveCancellationPolicy({
        user,
        appointment: ap,
        hoursToStart,
      });

      console.log("[CANCEL DEBUG]", {
        appointmentId: String(ap._id),
        service: ap.service,
        serviceKey: serviceToKey(ap.service),
        hoursToStart,
        decision,
        timelyUsed: countMonthlyRefundsByType(user, {
          serviceKey: serviceToKey(ap.service),
          refundType: "timely",
        }),
        lateUsed: countMonthlyRefundsByType(user, {
          serviceKey: serviceToKey(ap.service),
          refundType: "late",
        }),
        creditLotId: ap.creditLotId || null,
        lots: lotsDebug(user),
      });

      const historyMeta = buildCancellationHistoryMeta({
        appointment: ap,
        decision,
        now,
      });

      let updatedUser = user;

      if (decision.refund) {
        if (ap.creditLotId) {
          updatedUser = await refundCreditAtomicToOriginalLot({
            userId: user._id,
            lotId: ap.creditLotId,
            apService: ap.service,
            historyItem: {
              action: decision.historyAction,
              date: ap.date,
              time: ap.time,
              service: ap.service,
              serviceName: ap.service,
              ...historyMeta,
            },
            session,
          });
        } else {
          const refunded = await refundCreditAtomicNewLot({
            userId: user._id,
            apService: ap.service,
            historyItem: {
              action: decision.historyAction,
              date: ap.date,
              time: ap.time,
              service: ap.service,
              serviceName: ap.service,
              ...historyMeta,
            },
            session,
          });
          updatedUser = refunded.user;
        }
      } else {
        updatedUser.history = Array.isArray(updatedUser.history)
          ? updatedUser.history
          : [];

        updatedUser.history.push({
          action: decision.historyAction,
          date: ap.date,
          time: ap.time,
          service: ap.service,
          serviceName: ap.service,
          ...historyMeta,
          createdAt: new Date(),
        });

        recalcUserCredits(updatedUser);
        await updatedUser.save({ session });
      }

      ap.status = "cancelled";
      ap.cancelledAt = new Date();
      ap.cancelledByRole = role || "client";
      ap.cancelledByUser = tokenUserId || null;
      ap.cancelReason = decision.reason || "";
      ap.refundApplied = !!decision.refund;
      ap.refundMode = decision.refundMode || "none";
      await ap.save({ session });

      const cancellationCounters = getMonthlyCancellationCounters(
        updatedUser,
        ap.service,
        new Date()
      );

      const cancellationMessage = buildCancellationClientMessage({
        appointment: ap,
        decision,
        counters: cancellationCounters,
      });

      responsePayload = {
        ok: true,
        id: String(ap._id),
        refundApplied: !!decision.refund,
        refundMode: decision.refundMode || "none",
        refundReason: decision.reason || "",
        cancelReason: decision.reason || "",
        cancellationMessage,
        cancellationPolicy: cancellationCounters,
        userCredits: Number(updatedUser.credits || 0),
        userCreditLots: serializeUserCreditLots(updatedUser),
      };

      mailUser = { ...updatedUser.toObject(), _id: updatedUser._id };
      mailAp = {
        id: String(ap._id),
        date: ap.date,
        time: ap.time,
        service: ap.service,
        serviceName: ap.service,
        refund: !!decision.refund,
        refundApplied: !!decision.refund,
        refundMode: decision.refundMode || "none",
        refundCutoffHours: Number(decision.refundCutoffHours || 0),
        cancelReason: decision.reason || "",
      };

      console.log("[CANCEL MAIL PAYLOAD]", {
        appointmentId: String(ap._id),
        to: updatedUser?.email || "",
        refund: mailAp.refund,
        refundApplied: mailAp.refundApplied,
        refundMode: mailAp.refundMode,
        refundCutoffHours: mailAp.refundCutoffHours,
        service: mailAp.service,
        serviceName: mailAp.serviceName,
      });
    });

    await logActivity({
      req,
      category: "appointments",
      action: "appointment_cancelled",
      entity: "appointment",
      entityId: String(req.params.id),
      title: "Turno cancelado",
      description: "Se canceló un turno.",
      subject: buildUserSubject(req.user),
      meta: {
        refundApplied: !!responsePayload?.refundApplied,
        refundMode: responsePayload?.refundMode || "none",
      },
    });

    res.json(responsePayload);

    if (mailUser && mailAp) {
      fireAndForget(async () => {
        try {
          await sendAppointmentCancelledEmail(mailUser, mailAp);
        } catch (e) {
          console.log("[MAIL] cancelled error:", e?.message || e);
          await sendAdminCopy({ kind: "cancelled", user: mailUser, ap: mailAp });
        }
      }, "MAIL_CANCELLED");
    }
  } catch (err) {
    console.error("Error en DELETE /appointments/:id:", err);
    const msg = String(err?.message || "");

    if (msg === "APPOINTMENT_NOT_FOUND") {
      return res.status(404).json({ error: "Turno no encontrado." });
    }
    if (msg === "NOT_AUTHORIZED") {
      return res.status(403).json({ error: "No autorizado para cancelar este turno." });
    }
    if (msg === "APPOINTMENT_NOT_RESERVED") {
      return res.status(409).json({ error: "El turno ya no está reservado." });
    }
    if (msg === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }
    if (msg === "INVALID_SLOT_DATE") {
      return res.status(400).json({ error: "Fecha u horario inválido en el turno." });
    }
    if (msg === "REFUND_FAILED") {
      return res.status(500).json({ error: "No se pudo devolver el crédito al lote original." });
    }

    return res.status(500).json({ error: "No se pudo cancelar el turno." });
  } finally {
    await session.endSession();
  }
});

/* =========================
   POST /appointments/waitlist/claim
========================= */
router.post("/waitlist/claim", ensureStaff, async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const entryId = String(req.body?.entryId || "").trim();
    if (!entryId) {
      return res.status(400).json({ error: "Falta entryId." });
    }

    let createdAppointment = null;

    await session.withTransaction(async () => {
      const entry = await WaitlistEntry.findById(entryId).session(session);
      if (!entry) throw new Error("WAITLIST_NOT_FOUND");

      if (!ACTIVE_WAITLIST_STATUSES.includes(String(entry.status || ""))) {
        throw new Error("WAITLIST_NOT_ACTIVE");
      }

      createdAppointment = await createAppointmentForTargetUser({
        userId: String(entry.user),
        actorReq: req,
        date: entry.date,
        time: entry.time,
        service: entry.service || EP_NAME,
        notes: entry.notes || "",
        bypassWindow: true,
      });

      entry.status = "claimed";
      entry.claimedAt = new Date();
      entry.claimedBy = req.user?._id || req.user?.id || null;
      entry.closeReason = "CLAIMED_BY_STAFF";
      await entry.save({ session });

      await WaitlistEntry.updateMany(
        {
          _id: { $ne: entry._id },
          date: entry.date,
          time: entry.time,
          service: entry.service || EP_NAME,
          status: { $in: ACTIVE_WAITLIST_STATUSES },
        },
        {
          $set: {
            status: "closed",
            closeReason: "SLOT_FILLED",
            closedAt: new Date(),
          },
        },
        { session }
      );
    });

    return res.status(201).json({
      ok: true,
      appointment: createdAppointment,
    });
  } catch (err) {
    console.error("Error en POST /appointments/waitlist/claim:", err);
    const msg = String(err?.message || "");

    if (msg === "WAITLIST_NOT_FOUND") {
      return res.status(404).json({ error: "Elemento de lista de espera no encontrado." });
    }
    if (msg === "WAITLIST_NOT_ACTIVE") {
      return res.status(409).json({ error: "La lista de espera ya no está activa." });
    }
    if (msg === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }
    if (msg === "USER_SUSPENDED") {
      return res.status(403).json({ error: "Cuenta suspendida." });
    }
    if (msg === "APTO_REQUIRED") {
      return res.status(403).json({ error: "Falta apto médico." });
    }
    if (msg === "NO_CREDITS") {
      return res.status(403).json({ error: "Sin créditos disponibles." });
    }
    if (msg.startsWith("NO_CREDITS_FOR_SLOT_")) {
      return res.status(403).json({
        error: "No tiene sesiones válidas para ese día y horario.",
      });
    }
    if (msg === "ALREADY_HAVE_SLOT") {
      return res.status(409).json({ error: "El usuario ya tiene un turno reservado en ese horario." });
    }
    if (msg === "SERVICE_CAP_REACHED") {
      return res.status(409).json({ error: "Ese servicio ya alcanzó su cupo para ese horario." });
    }
    if (msg === "TOTAL_CAP_REACHED") {
      return res.status(409).json({ error: "Se alcanzó el cupo total disponible para ese horario." });
    }

    return res.status(500).json({ error: "No se pudo asignar desde la lista de espera." });
  } finally {
    await session.endSession();
  }
});

/* =========================
   GET /appointments/admin/fixed-schedules
========================= */
router.get("/admin/fixed-schedules", ensureStaff, async (_req, res) => {
  try {
    const items = await FixedSchedule.find({ active: true })
      .populate("user", "name lastName email")
      .sort({ createdAt: -1 })
      .lean();

    return res.json(
      items.map((it) => ({
        id: String(it._id),
        user: it.user
          ? {
              _id: String(it.user._id),
              name: it.user.name || "",
              lastName: it.user.lastName || "",
              email: it.user.email || "",
            }
          : null,
        service: it.service || "",
        items: Array.isArray(it.items)
          ? it.items.map((x) => ({
              weekday: Number(x?.weekday || 0),
              time: String(x?.time || "").slice(0, 5),
            }))
          : [],
        months: Number(it.months || 1),
        startDate: it.startDate || null,
        endDate: it.endDate || null,
        notes: it.notes || "",
        active: !!it.active,
        createdAt: it.createdAt || null,
      }))
    );
  } catch (err) {
    console.error("Error en GET /appointments/admin/fixed-schedules:", err);
    return res.status(500).json({ error: "No se pudieron cargar los turnos fijos." });
  }
});

/* =========================
   DELETE /appointments/admin/fixed-schedules/:id
========================= */
router.delete("/admin/fixed-schedules/:id", ensureStaff, async (req, res) => {
  try {
    const schedule = await FixedSchedule.findById(req.params.id);
    if (!schedule) {
      return res.status(404).json({ error: "Turno fijo no encontrado." });
    }

    schedule.active = false;
    schedule.deactivatedAt = new Date();
    schedule.deactivatedBy = req.user?._id || req.user?.id || null;
    await schedule.save();

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error nn DELETE /appointments/admin/fixed-schedules/:id:", err);
    return res.status(500).json({ error: "No se pudo desactivar el turno fijo." });
  }
});

export default router;