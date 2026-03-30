// =========================
// BACKEND: appointments_politicas_actualizadas.js
// =========================

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
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "duoclub.ar@gmail.com";

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

  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("nutricion")) return "NUT";

  const up = String(serviceName || "").toUpperCase().trim();
  const allowed = new Set(["EP", "RA", "RF", "NUT"]);
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
  historyItem,
  session,
}) {
  const freshUser = await User.findById(userId).session(session);
  if (!freshUser) throw new Error("USER_NOT_FOUND");

  const lot = findLotById(freshUser, lotId);
  if (!lot) throw new Error("REFUND_FAILED");

  const currentRemaining = Number(lot.remaining || 0);
  const maxAmount = Number(lot.amount || 0);

  lot.remaining = Math.min(currentRemaining + 1, maxAmount);

  freshUser.history = freshUser.history || [];
  freshUser.history.push({
    ...historyItem,
    createdAt: new Date(),
  });

  recalcUserCredits(freshUser);
  await freshUser.save({ session });

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
  await freshUser.save({ session });

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

  return countHistoryEntriesInMonth(
    user,
    (item) => {
      const itemSk = getHistoryServiceKey(item);
      if (wantedSk && itemSk !== wantedSk) return false;

      const action = String(item?.action || "").trim();

      if (wantedType === "timely") {
        return action === "cancelado_con_reintegro";
      }

      if (wantedType === "late") {
        return action === "cancelado_tarde_con_cortesia";
      }

      return false;
    },
    refDate
  );
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
      notes,
    },
    slotDate: basic.slotDate,
    session: null,
  });

  const effectiveUser = consumed.user;
  const usedLotId = consumed.usedLotId;
  const usedLotExp = consumed.usedLotExp;

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

/* =========================
   AUTH required
========================= */
router.use(protect);

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
      const me = await User.findById(requesterId)
        .select("role suspended aptoPath createdAt credits creditLots")
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
          .select("credits creditLots")
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

    {
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
          userId: String(a?.user || ""),
        }))
      );
    }
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
      const user = await User.findById(userId).session(session);
      if (!user) throw new Error("USER_NOT_FOUND");

      if (user.suspended) throw new Error("USER_SUSPENDED");
      if (requiresApto(user)) throw new Error("APTO_REQUIRED");

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

    if (err?.code === 11000) {
      return res.status(409).json({
        error: "Conflicto: ese turno o ese servicio ya fue reservado. Actualizá y probá de nuevo.",
      });
    }

    if (msg === "USER_NOT_FOUND") return res.status(403).json({ error: "Usuario no encontrado." });
    if (msg === "USER_SUSPENDED") return res.status(403).json({ error: "Cuenta suspendida." });
    if (msg === "APTO_REQUIRED")
      return res.status(403).json({ error: "Cuenta suspendida por falta de apto médico." });
    if (msg === "NO_CREDITS") return res.status(403).json({ error: "Sin créditos disponibles." });
    if (msg === "CREDIT_CONSUME_FAILED")
      return res.status(409).json({ error: "No se pudo debitar la sesión. Actualizá y probá de nuevo." });

    if (msg === "ALREADY_HAVE_SLOT")
      return res.status(409).json({ error: "Ya tenés un turno reservado en ese horario." });

    if (msg === "ALREADY_IN_WAITLIST")
      return res.status(409).json({ error: "Ya estás en lista de espera para ese horario." });

    if (msg === "WAITLIST_CLOSED")
      return res.status(409).json({
        error:
          "La lista de espera para ese horario ya está cerrada por anticipación.",
      });

    if (msg === "TOTAL_CAP_REACHED")
      return res.status(409).json({ error: "Se alcanzó el cupo total disponible para este horario." });

    if (msg === "SERVICE_CAP_REACHED")
      return res.status(409).json({ error: "Ese servicio ya alcanzó su cupo para ese horario." });

    if (msg.startsWith("NO_CREDITS_FOR_SLOT_")) {
      const sk = msg.replace("NO_CREDITS_FOR_SLOT_", "");
      return res.status(403).json({
        error: `No tenés créditos válidos para reservar ese día y horario (${sk}).`,
      });
    }

    if (msg.startsWith("NO_CREDITS_FOR_")) {
      const sk = msg.replace("NO_CREDITS_FOR_", "");
      return res.status(403).json({ error: `No tenés créditos válidos para este servicio (${sk}).` });
    }

    return res.status(500).json({ error: "Error al crear el turno." });
  } finally {
    session.endSession();
  }
});

/* =========================
   POST /appointments/batch
========================= */
router.post("/batch", async (req, res) => {
  const session = await mongoose.startSession();

  let mailUser = null;
  let mailItems = null;

  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "Faltan items: [{date,time,service}]." });
    if (items.length > 12) return res.status(400).json({ error: "Máximo 12 turnos por operación." });

    const seen = new Set();
    const normalized = items.map((it, idx) => {
      const date = String(it?.date || "").trim();
      const time = String(it?.time || "").trim();
      const service = String(it?.service || "").trim();

      const basic = validateBasicSlotRules({ date, time, service });
      if (!basic.ok) {
        const e = new Error(`ITEM_${idx}_INVALID:${basic.error}`);
        e.http = 400;
        throw e;
      }

      const timeNorm = String(time).slice(0, 5);
      const key = `${date}__${timeNorm}__${service}`;
      if (seen.has(key)) {
        const e = new Error(`ITEM_${idx}_DUP`);
        e.http = 409;
        throw e;
      }
      seen.add(key);

      return { date, time: timeNorm, service, ...basic };
    });

    const userId = req.user._id || req.user.id;
    let createdItems = [];
    let waitlistedItems = [];
    let userCreditsAfter = null;
    let userCreditLotsAfter = [];

    await session.withTransaction(async () => {
      const user = await User.findById(userId).session(session);
      if (!user) throw new Error("USER_NOT_FOUND");

      if (user.suspended) throw new Error("USER_SUSPENDED");
      if (requiresApto(user)) throw new Error("APTO_REQUIRED");

      recalcUserCredits(user);
      if ((user.credits || 0) <= 0) throw new Error("NO_CREDITS");

      const slotSet = new Set(normalized.map((x) => slotKey(x.date, x.time)));
      if (slotSet.size !== normalized.length) {
        const e = new Error("DUP_SLOT_IN_BATCH");
        e.http = 409;
        throw e;
      }

      const orSlots = normalized.map((x) => ({ date: x.date, time: x.time }));
      const alreadyByUserAny = await Appointment.findOne({
        user: user._id,
        status: "reserved",
        $or: orSlots,
      }).session(session).lean();

      if (alreadyByUserAny) throw new Error("ALREADY_HAVE_SLOT");

      const existing = await Appointment.find({
        status: "reserved",
        $or: orSlots,
      }).session(session).lean();

      const bySlot = new Map();
      for (const ap of existing) {
        const k = slotKey(ap.date, ap.time);
        if (!bySlot.has(k)) bySlot.set(k, []);
        bySlot.get(k).push(ap);
      }

      for (const it of normalized) {
        const k = slotKey(it.date, it.time);
        const cur = bySlot.get(k) || [];
        const stats = getSlotReservationStats(cur, it.date, it.time);

        if (it.isEpService) {
          if (stats.totalReserved >= TOTAL_CAP || stats.epReserved >= stats.epCap) {
            it.waitlist = true;
            continue;
          }
        } else if (isTherapyService(it.service)) {
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

        cur.push({ date: it.date, time: it.time, service: it.service });
        bySlot.set(k, cur);
      }

      createdItems = [];
      waitlistedItems = [];

      const toReserve = normalized.filter((x) => !x.waitlist);

      recalcUserCredits(user);
      if ((user.credits || 0) < toReserve.length) {
        const e = new Error("NO_CREDITS");
        e.http = 403;
        throw e;
      }

      const needByService = { EP: 0, RF: 0, RA: 0, NUT: 0 };

      for (const it of normalized) {
        const requestedSk = serviceToKey(it.service);
        if (!it.waitlist && !hasValidCreditsForServiceAndSlot(user, requestedSk, it.slotDate)) {
          const e = new Error(`NO_CREDITS_FOR_SLOT_${requestedSk}`);
          e.http = 403;
          throw e;
        }
      }

      for (const it of toReserve) {
        const sk = serviceToKey(it.service);
        if (needByService[sk] !== undefined) needByService[sk] += 1;
      }

      for (const [sk, need] of Object.entries(needByService)) {
        if (!need) continue;

        let available = 0;
        for (const lot of Array.isArray(user.creditLots) ? user.creditLots : []) {
          const rem = Number(lot?.remaining || 0);
          if (rem <= 0) continue;

          const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
          if (exp && exp <= new Date()) continue;

          const lk = String(lot?.serviceKey || "").toUpperCase().trim();
          if (lk === sk) available += rem;
        }

        if (available < need) {
          const e = new Error(`NO_CREDITS_FOR_${sk}`);
          e.http = 403;
          throw e;
        }
      }

      for (const it of normalized) {
        if (it.waitlist) {
          const wlWindow = validateWaitlistOpen(it.slotDate, it.service);
          if (!wlWindow.ok) {
            const e = new Error("WAITLIST_CLOSED");
            e.http = 409;
            throw e;
          }

          const wlExists = await WaitlistEntry.findOne({
            user: user._id,
            date: it.date,
            time: it.time,
            service: EP_NAME,
            status: { $in: ACTIVE_WAITLIST_STATUSES },
          }).session(session);

          if (!wlExists) {
            const lastPriority = await WaitlistEntry.findOne({
              date: it.date,
              time: it.time,
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
                date: it.date,
                time: it.time,
                service: EP_NAME,
                status: "waiting",
                priorityOrder: nextPriority,
                createdByUser: user._id,
                createdByRole: String(req.user?.role || "client").toLowerCase(),
              }],
              { session }
            );

            waitlistedItems.push({
              kind: "waitlist",
              id: String(createdWaitlist._id),
              date: it.date,
              time: it.time,
              service: EP_NAME,
              status: "waiting",
              priorityOrder: nextPriority,
              createdAt: createdWaitlist.createdAt || new Date(),
            });
          }
          continue;
        }

        let usedLotId = null;
        let usedLotExp = null;

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

        usedLotId = consumed.usedLotId;
        usedLotExp = consumed.usedLotExp;

        const created = await Appointment.create(
          [{
            date: it.date,
            time: it.time,
            service: it.service,
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

        createdItems.push(serializeAppointment(populated));
      }

      const finalUser = await User.findById(user._id).session(session);
      if (!finalUser) throw new Error("USER_NOT_FOUND");

      recalcUserCredits(finalUser);
      await finalUser.save({ session });

      userCreditsAfter = Number(finalUser.credits || 0);
      userCreditLotsAfter = serializeUserCreditLots(finalUser);
      mailUser = { ...finalUser.toObject(), _id: finalUser._id };
      mailItems = createdItems.map((x) => ({ date: x.date, time: x.time, service: x.service }));
    });

    await logActivity({
      req,
      category: "appointments",
      action: "appointment_batch_created",
      entity: "appointment_batch",
      entityId: String(req.user?._id || "") + "-" + String(Date.now()),
      title: "Reserva múltiple",
      description: "Se registró una reserva múltiple de turnos.",
      subject: buildUserSubject(req.user),
      meta: {
        createdCount: createdItems.length,
        waitlistedCount: waitlistedItems.length,
        steps: [
          ...createdItems.map(
            (x) => `Reservó ${x.service} el ${x.date} a las ${x.time}`
          ),
          ...waitlistedItems.map(
            (x) => `Entró en lista de espera para ${x.service} el ${x.date} a las ${x.time}`
          ),
        ],
      },
    });

    res.status(201).json({
      items: createdItems,
      waitlisted: waitlistedItems,
      userCredits: userCreditsAfter,
      userCreditLots: userCreditLotsAfter,
    });

    if (mailUser && mailItems?.length) {
      fireAndForget(async () => {
        try {
          await sendAppointmentBookedBatchEmail(mailUser, mailItems);
        } catch (e) {
          console.log("[MAIL] batch booked error:", e?.message || e);
          await sendAdminCopy({ kind: "batch_booked", user: mailUser, ap: { items: mailItems } });
        }
      }, "MAIL_BATCH_BOOKED");
    }
  } catch (err) {
    console.error("Error en POST /appointments/batch:", err);
    const msg = String(err?.message || "");
    const http = err?.http;

    if (http) {
      if (msg.startsWith("ITEM_") && msg.includes("_INVALID:")) {
        const parts = msg.split("_INVALID:");
        return res.status(400).json({ error: parts[1] || "Item inválido." });
      }
      if (msg.startsWith("ITEM_") && msg.endsWith("_DUP")) {
        return res.status(409).json({ error: "Hay items duplicados dentro del batch." });
      }
      if (msg === "SERVICE_CAP_REACHED") {
        return res.status(409).json({ error: "Ese servicio ya alcanzó su cupo en uno de los horarios." });
      }
      if (msg === "TOTAL_CAP_REACHED") {
        return res.status(409).json({ error: "Se alcanzó el cupo total disponible para alguno de los horarios." });
      }
      if (msg === "NO_CREDITS") {
        return res.status(403).json({ error: "Sin créditos disponibles." });
      }
      if (msg === "CREDIT_CONSUME_FAILED") {
        return res.status(409).json({ error: "No se pudo debitar una sesión. Actualizá y probá de nuevo." });
      }
      if (msg === "WAITLIST_CLOSED") {
        return res.status(409).json({
          error: "La lista de espera para uno de los horarios ya está cerrada por anticipación.",
        });
      }
      if (msg.startsWith("NO_CREDITS_FOR_SLOT_")) {
        const sk = msg.replace("NO_CREDITS_FOR_SLOT_", "");
        return res.status(403).json({
          error: `No tenés créditos válidos para reservar uno de esos días/horarios (${sk}).`,
        });
      }
      if (msg.startsWith("NO_CREDITS_FOR_")) {
        const sk = msg.replace("NO_CREDITS_FOR_", "");
        return res.status(403).json({ error: `No tenés créditos válidos para este servicio (${sk}).` });
      }
      return res.status(http).json({ error: "No se pudo reservar el batch." });
    }

    if (err?.code === 11000) {
      return res.status(409).json({
        error: "Conflicto: alguno de los turnos/servicios ya fue reservado. Actualizá y probá de nuevo.",
      });
    }

    if (msg === "USER_NOT_FOUND") return res.status(403).json({ error: "Usuario no encontrado." });
    if (msg === "USER_SUSPENDED") return res.status(403).json({ error: "Cuenta suspendida." });
    if (msg === "APTO_REQUIRED")
      return res.status(403).json({ error: "Cuenta suspendida por falta de apto médico." });
    if (msg === "NO_CREDITS") return res.status(403).json({ error: "Sin créditos disponibles." });

    if (msg === "DUP_SLOT_IN_BATCH")
      return res.status(409).json({ error: "No podés reservar 2 turnos en el mismo horario en un solo batch." });

    if (msg === "ALREADY_HAVE_SLOT")
      return res.status(409).json({ error: "Ya tenés un turno reservado en alguno de esos horarios." });

    if (msg === "TOTAL_CAP_REACHED")
      return res.status(409).json({ error: "Se alcanzó el cupo total disponible para alguno de los horarios." });

    if (msg === "WAITLIST_CLOSED") {
      return res.status(409).json({
        error: "La lista de espera para uno de los horarios ya está cerrada por anticipación.",
      });
    }

    if (msg.startsWith("NO_CREDITS_FOR_SLOT_")) {
      const sk = msg.replace("NO_CREDITS_FOR_SLOT_", "");
      return res.status(403).json({
        error: `No tenés créditos válidos para reservar uno de esos días/horarios (${sk}).`,
      });
    }

    if (msg.startsWith("NO_CREDITS_FOR_")) {
      const sk = msg.replace("NO_CREDITS_FOR_", "");
      return res.status(403).json({ error: `No tenés créditos válidos para este servicio (${sk}).` });
    }

    return res.status(500).json({ error: "Error al reservar el batch." });
  } finally {
    session.endSession();
  }
});

/* =========================
   POST /appointments/waitlist/claim
   Deshabilitado: la asignación desde waitlist ahora es manual
========================= */
router.post("/waitlist/claim", async (req, res) => {
  return res.status(410).json({
    error:
      "La confirmación automática desde lista de espera ya no está disponible. La asignación es manual por parte del staff/admin.",
  });
});

/* =========================
   POST /appointments/waitlist/:id/assign-manual
========================= */
router.post("/waitlist/:id/assign-manual", async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const role = String(req.user?.role || "").toLowerCase();
    if (!["admin", "profesor", "staff"].includes(role)) {
      return res.status(403).json({
        error: "Solo staff, profesor o admin pueden asignar manualmente desde la lista de espera.",
      });
    }

    const waitlistId = String(req.params?.id || "").trim();
    if (!waitlistId) {
      return res.status(400).json({ error: "Falta id de lista de espera." });
    }

    let payload = null;

    await session.withTransaction(async () => {
      const wl = await WaitlistEntry.findById(waitlistId).session(session);
      if (!wl) {
        const e = new Error("WAITLIST_NOT_FOUND");
        e.http = 404;
        throw e;
      }

      if (!ACTIVE_WAITLIST_STATUSES.includes(String(wl.status || ""))) {
        const e = new Error("WAITLIST_NOT_ACTIVE");
        e.http = 409;
        throw e;
      }

      const ap = await createAppointmentForTargetUser({
        userId: String(wl.user),
        actorReq: req,
        date: wl.date,
        time: wl.time,
        service: wl.service || EP_NAME,
        notes: String(wl.notes || "").trim(),
        bypassWindow: true,
      });

      wl.status = "claimed";
      wl.claimedAt = new Date();
      wl.claimedBy = req.user?._id || req.user?.id || null;
      wl.assignedAppointmentId = ap?.id || null;
      await wl.save({ session });

      payload = {
        ok: true,
        waitlistId: String(wl._id),
        appointment: ap,
      };
    });

    return res.status(201).json(payload);
  } catch (err) {
    console.error("Error en POST /appointments/waitlist/:id/assign-manual:", err);
    const msg = String(err?.message || "");
    const http = err?.http || 500;

    if (msg === "WAITLIST_NOT_FOUND") {
      return res.status(404).json({ error: "Entrada de lista de espera no encontrada." });
    }
    if (msg === "WAITLIST_NOT_ACTIVE") {
      return res.status(409).json({ error: "La entrada de lista de espera ya no está activa." });
    }
    if (msg === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }
    if (msg === "USER_SUSPENDED") {
      return res.status(403).json({ error: "Cuenta suspendida." });
    }
    if (msg === "APTO_REQUIRED") {
      return res.status(403).json({ error: "Cuenta suspendida por falta de apto médico." });
    }
    if (msg === "NO_CREDITS") {
      return res.status(403).json({ error: "Sin créditos disponibles." });
    }
    if (msg.startsWith("NO_CREDITS_FOR_SLOT_")) {
      const sk = msg.replace("NO_CREDITS_FOR_SLOT_", "");
      return res.status(403).json({
        error: `No tenés créditos válidos para reservar ese día y horario (${sk}).`,
      });
    }
    if (msg.startsWith("NO_CREDITS_FOR_")) {
      const sk = msg.replace("NO_CREDITS_FOR_", "");
      return res.status(403).json({ error: `No tenés créditos válidos para este servicio (${sk}).` });
    }
    if (msg === "ALREADY_HAVE_SLOT") {
      return res.status(409).json({ error: "El usuario ya tiene un turno reservado en ese horario." });
    }
    if (msg === "TOTAL_CAP_REACHED") {
      return res.status(409).json({ error: "Se alcanzó el cupo total disponible para este horario." });
    }
    if (msg === "SERVICE_CAP_REACHED") {
      return res.status(409).json({ error: "Ese servicio ya alcanzó su cupo para ese horario." });
    }

    return res.status(http).json({ error: "No se pudo asignar manualmente desde la lista de espera." });
  } finally {
    session.endSession();
  }
});

/* =========================
   PATCH /appointments/:id/cancel
========================= */
router.patch("/:id/cancel", async (req, res) => {
  const session = await mongoose.startSession();

  let mailUser = null;
  let mailAp = null;
  let shouldMail = false;

  try {
    const apId = req.params.id;
    const role = String(req.user?.role || "").toLowerCase();
    const isAdmin = role === "admin";
    const cancelReasonRaw = String(req.body?.reason || "").trim();
    const cancelReason = cancelReasonRaw.slice(0, 300);

    let payload = null;
    let activityMeta = null;

    await session.withTransaction(async () => {
      const ap = await Appointment.findById(apId).session(session);
      if (!ap) throw new Error("NOT_FOUND");
      if (String(ap.status) === "cancelled") throw new Error("ALREADY_CANCELLED");

      if (!isAdmin && String(ap.user) !== String(req.user._id || req.user.id)) {
        const e = new Error("FORBIDDEN");
        e.http = 403;
        throw e;
      }

      const user = await User.findById(ap.user).session(session);
      if (!user) throw new Error("USER_NOT_FOUND");

      const slotDate = buildSlotDate(ap.date, ap.time);
      if (!slotDate) throw new Error("INVALID_SLOT_DATE");

      const now = new Date();
      const diffMs = slotDate.getTime() - now.getTime();
      const hoursToStart = diffMs / (1000 * 60 * 60);

      const policy = resolveCancellationPolicy({
        user,
        appointment: ap,
        hoursToStart,
      });

      let effectiveUser = user;
      let refundInfo = null;

      if (policy.refund) {
        const historyItem = {
          action: policy.historyAction,
          date: ap.date,
          time: ap.time,
          service: ap.service,
          serviceName: ap.service,
          serviceKey: serviceToKey(ap.service),
          refundMode: policy.refundMode,
          refundReason: policy.reason,
          cancelReason,
        };

        if (ap.creditLotId) {
          effectiveUser = await refundCreditAtomicToOriginalLot({
            userId: user._id,
            lotId: ap.creditLotId,
            historyItem,
            session,
          });

          refundInfo = {
            mode: "original-lot",
            refundMode: policy.refundMode,
          };
        } else {
          const refunded = await refundCreditAtomicNewLot({
            userId: user._id,
            apService: ap.service,
            historyItem,
            session,
          });

          effectiveUser = refunded.user;
          refundInfo = {
            mode: "new-lot",
            refundMode: policy.refundMode,
            serviceKey: refunded.sk,
            expiresAt: refunded.expiresAt,
          };
        }
      } else {
        user.history = user.history || [];
        user.history.push({
          action: policy.historyAction,
          date: ap.date,
          time: ap.time,
          service: ap.service,
          serviceName: ap.service,
          serviceKey: serviceToKey(ap.service),
          refundMode: "none",
          refundReason: policy.reason,
          cancelReason,
          createdAt: new Date(),
        });
        recalcUserCredits(user);
        await user.save({ session });
        effectiveUser = user;
      }

      ap.status = "cancelled";
      ap.cancelledAt = new Date();
      ap.cancelledBy = req.user?._id || req.user?.id || null;
      ap.cancelReason = cancelReason || "";
      ap.refundApplied = !!policy.refund;
      ap.refundMode = policy.refundMode;
      ap.refundReason = policy.reason;
      await ap.save({ session });

      // La asignación desde lista de espera es manual.
      // No se envían confirmaciones automáticas ni claims automáticos.

      payload = {
        ok: true,
        appointmentId: String(ap._id),
        refundApplied: !!policy.refund,
        refundMode: policy.refundMode,
        refundReason: policy.reason,
        refundCutoffHours: policy.refundCutoffHours,
        userCredits: Number(effectiveUser.credits || 0),
        userCreditLots: serializeUserCreditLots(effectiveUser),
        refundInfo,
      };

      activityMeta = {
        date: ap.date,
        time: ap.time,
        serviceName: ap.service,
        refundApplied: !!policy.refund,
        refundMode: policy.refundMode,
        refundReason: policy.reason,
        cancelReason,
      };

      mailUser = { ...effectiveUser.toObject(), _id: effectiveUser._id };
      mailAp = {
        date: ap.date,
        time: ap.time,
        service: ap.service,
      };
      shouldMail = true;
    });

    await logActivity({
      req,
      category: "appointments",
      action: "appointment_cancelled",
      entity: "appointment",
      entityId: String(req.params.id),
      title: "Turno cancelado",
      description: "Se canceló un turno existente.",
      subject: buildUserSubject(req.user),
      meta: activityMeta || {},
    });

    res.json(payload);

    if (shouldMail && mailUser && mailAp) {
      fireAndForget(async () => {
        try {
          await sendAppointmentCancelledEmail(mailUser, mailAp, {
            refundApplied: payload?.refundApplied,
            refundMode: payload?.refundMode,
            refundReason: payload?.refundReason,
            refundCutoffHours: payload?.refundCutoffHours,
          });
        } catch (e) {
          console.log("[MAIL] cancelled error:", e?.message || e);
          await sendAdminCopy({ kind: "cancelled", user: mailUser, ap: mailAp });
        }
      }, "MAIL_CANCELLED");
    }
  } catch (err) {
    console.error("Error en PATCH /appointments/:id/cancel:", err);
    const msg = String(err?.message || "");
    const http = err?.http || 500;

    if (msg === "NOT_FOUND") return res.status(404).json({ error: "Turno no encontrado." });
    if (msg === "ALREADY_CANCELLED") return res.status(409).json({ error: "El turno ya estaba cancelado." });
    if (msg === "FORBIDDEN") return res.status(403).json({ error: "No autorizado para cancelar este turno." });
    if (msg === "USER_NOT_FOUND") return res.status(404).json({ error: "Usuario no encontrado." });
    if (msg === "INVALID_SLOT_DATE") return res.status(500).json({ error: "Fecha/hora inválida en el turno." });
    if (msg === "REFUND_FAILED") {
      return res.status(409).json({ error: "No se pudo reintegrar la sesión al lote original." });
    }

    return res.status(http).json({ error: "No se pudo cancelar el turno." });
  } finally {
    session.endSession();
  }
});

export default router;