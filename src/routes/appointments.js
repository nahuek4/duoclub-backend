import express from "express";
import mongoose from "mongoose";

import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import WaitlistEntry from "../models/WaitlistEntry.js";
import FixedSchedule from "../models/FixedSchedule.js";
import ScheduleBlock from "../models/ScheduleBlock.js";

import { protect } from "../middleware/auth.js";

import {
  fireAndForget,
  sendAppointmentBookedEmail,
  sendAppointmentBookedBatchEmail,
  sendAppointmentCancelledEmail,
  sendAdminAppointmentBookedEmail,
  sendAdminAppointmentCancelledEmail,
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
 * RA/RF/KD = 24 h fijas
 * resto = variable por env o fallback 60
 */
const DEFAULT_MIN_BOOKING_MINUTES = Number(
  process.env.MIN_BOOKING_MINUTES || 60
);

const MIN_BOOKING_MINUTES_BY_SERVICE = {
  EP: 30,
  RA: 24 * 60,
  RF: 24 * 60,
  KD: 24 * 60,
  SYN: 24 * 60,
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

function waitlistQueueServiceKeys(serviceKeyOrName) {
  const sk = serviceToKey(serviceKeyOrName);
  if (!sk) return [];
  if (isTherapyService(sk)) return ["RA", "RF", "KD", "SYN"];
  return [sk];
}

function buildWaitlistQueueMatch(serviceKeyOrName) {
  const keys = waitlistQueueServiceKeys(serviceKeyOrName);
  if (!keys.length) return { serviceKey: "__NO_SERVICE__" };
  return { serviceKey: { $in: keys } };
}

function isWaitlistableService(serviceKeyOrName) {
  const sk = serviceToKey(serviceKeyOrName);
  return sk === "EP" || isTherapyService(sk);
}

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

function normalizeCreatedByRole(value, fallback = "client") {
  const role = String(value || "").toLowerCase().trim();
  if (["admin", "profesor", "staff", "guest", "client"].includes(role)) {
    return role;
  }
  return fallback;
}

function ensureStaff(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (!["admin", "profesor", "staff"].includes(role)) {
    return res.status(403).json({ error: "No autorizado." });
  }
  return next();
}

function isStaffActor(req) {
  const role = String(req.user?.role || "").toLowerCase().trim();
  return ["admin", "profesor", "staff"].includes(role);
}

async function sendBookedMailRespectingActor({ req, user, ap, serviceName }) {
  if (isStaffActor(req)) {
    await sendAdminAppointmentBookedEmail(user, ap, serviceName);
    return;
  }

  await sendAppointmentBookedEmail(user, ap, serviceName);
}

async function sendBookedBatchMailRespectingActor({ req, user, items = [] }) {
  if (isStaffActor(req)) {
    for (const item of Array.isArray(items) ? items : []) {
      await sendAdminAppointmentBookedEmail(
        user,
        item,
        item?.serviceName || item?.service
      );
    }
    return;
  }

  await sendAppointmentBookedBatchEmail(user, items);
}

async function sendCancelledMailRespectingActor({ req, user, ap }) {
  if (isStaffActor(req)) {
    await sendAdminAppointmentCancelledEmail(
      user,
      ap,
      ap?.serviceName || ap?.service,
      ap
    );
    return;
  }

  await sendAppointmentCancelledEmail(user, ap);
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
  if (["RA", "RF", "KD", "SYN"].includes(sk)) return 12 * 60;

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

  if (h >= 7 && h <= 12) return "maniana";
  if (h >= 13 && h <= 17) return "tarde";
  if (h >= 18 && h <= 20) return "noche";

  return "";
}

/* =========================
   HELPERS: normalización servicios
========================= */
const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RA", "RF", "KD", "SYN", "NUT"]);

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación activa",
  RF: "Reeducación funcional",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
  NUT: "Nutrición",
};

function normSvcName(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeServiceKey(value) {
  const up = String(value || "").toUpperCase().trim();
  return ALLOWED_SERVICE_KEYS.has(up) ? up : "";
}

function serviceToKey(serviceNameOrKey) {
  const explicit = normalizeServiceKey(serviceNameOrKey);
  if (explicit) return explicit;

  const s = stripAccents(serviceNameOrKey).toLowerCase().trim();

  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("kinefilaxia") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("synergy") || s.includes("sinergia")) return "SYN";
  if (s.includes("nutricion")) return "NUT";

  return "";
}

function serviceKeyToName(serviceKey) {
  return SERVICE_KEY_TO_NAME[normalizeServiceKey(serviceKey)] || "";
}

function normalizeServiceIdentity({ service = "", serviceKey = "" } = {}) {
  const key = normalizeServiceKey(serviceKey) || serviceToKey(service);
  if (!key) return null;

  return {
    serviceKey: key,
    serviceName: serviceKeyToName(key),
  };
}

function appointmentServiceKey(ap) {
  return serviceToKey(ap?.serviceKey || ap?.service || ap?.serviceName || "");
}

function waitlistEntryServiceKey(entry) {
  return serviceToKey(
    entry?.serviceKey ||
      entry?.service ||
      entry?.serviceName ||
      entry?.requestedService ||
      entry?.requestedServiceKey ||
      ""
  );
}

function sameService(a, b) {
  const ak = serviceToKey(a);
  const bk = serviceToKey(b);

  if (ak && bk) return ak === bk;
  return normSvcName(a) === normSvcName(b);
}

/* =========================
   HELPERS: créditos
========================= */
function nowDate() {
  return new Date();
}

function getCreditsExpireDays(_user) {
  return CREDITS_EXPIRE_DAYS;
}


function sumCreditLotsForService(user, serviceKey = "", slotDate = null) {
  const now = nowDate();
  const wanted = normalizeServiceKey(serviceKey) || serviceToKey(serviceKey);
  const lots = Array.isArray(user?.creditLots) ? user.creditLots : [];

  return lots.reduce((acc, lot) => {
    const exp = lot.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return acc;
    if (wanted && normalizeLotServiceKey(lot) !== wanted) return acc;
    // El crédito solo debe estar vigente al momento de reservar.
    // No bloqueamos por la fecha futura del turno, porque eso dejaba sin horarios
    // a créditos comprados cerca del cierre de mes.
    return acc + Number(lot.remaining || 0);
  }, 0);
}

function getServiceBalance(user, serviceKey, slotDate = null) {
  const sk = normalizeServiceKey(serviceKey) || serviceToKey(serviceKey);
  if (!sk) return 0;
  return sumCreditLotsForService(user, sk, slotDate);
}

function recalcUserCredits(user) {
  user.credits = sumCreditLotsForService(user);
}

function normalizeLotServiceKey(lot) {
  return serviceToKey(lot?.serviceKey || lot?.service || lot?.serviceName || "");
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
  let currentUser = user;

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

    const serviceKey = serviceToKey(ap.serviceKey || ap.service || "");
    const billingStatus = String(ap.creditDebitStatus || "").trim();
    const needsFixedBillingBeforeCompletion =
      !!ap.fixedScheduleId &&
      isFixedBillingServiceKey(serviceKey) &&
      !ap.fixedDebitProcessedAt &&
      !FIXED_BILLING_DONE_STATUSES.has(billingStatus);

    if (needsFixedBillingBeforeCompletion) {
      const billing = await applyFixedAppointmentMonthlyBilling({
        appointment: ap,
        session,
      });

      if (billing?.action === "debt" || billing?.action === "debited") {
        const refreshedUserQuery = User.findById(user._id);
        if (session) refreshedUserQuery.session(session);
        currentUser = (await refreshedUserQuery) || currentUser;
      }
    }

    ap.status = "completed";
    ap.completedAt = now;
    if (session) await ap.save({ session });
    else await ap.save();
    changed = true;

    if (isFirstEvaluationService(ap.service)) {
      completedFirstEvaluation = true;
    }
  }

  if (completedFirstEvaluation && !currentUser.firstEvaluationCompleted) {
    currentUser.firstEvaluationCompleted = true;
    currentUser.firstEvaluationCompletedAt = currentUser.firstEvaluationCompletedAt || now;
    changed = true;
  }

  if (changed) {
    recalcUserCredits(currentUser);
    if (session) await currentUser.save({ session });
    else await currentUser.save();
  }

  return currentUser;
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

  // El lote ya fue filtrado por vigencia actual. No se descarta por la fecha futura
  // del turno para evitar que EP/RA/RF/KD/NUT queden sin disponibilidad al reservar
  // fechas posteriores al vencimiento operativo del crédito.
  return sorted[0] || null;
}

function hasValidCreditsForService(user, serviceNameOrKey) {
  const sk = serviceToKey(serviceNameOrKey);
  return getServiceBalance(user, sk) > 0 && !!pickLotToConsume(user, sk);
}

function hasValidCreditsForServiceAndSlot(user, serviceNameOrKey, slotDate) {
  const sk = serviceToKey(serviceNameOrKey);
  return getServiceBalance(user, sk, slotDate) > 0 && !!pickLotToConsumeForSlot(user, sk, slotDate);
}

function findLotById(user, lotId) {
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
  return lots.find((l) => String(l._id) === String(lotId)) || null;
}

async function consumeCreditAtomic({
  userId,
  serviceKey,
  serviceName,
  historyItem,
  slotDate,
  session,
}) {
  const requestedSk = normalizeServiceKey(serviceKey) || serviceToKey(serviceName);
  if (!requestedSk) {
    throw new Error("INVALID_SERVICE");
  }

  const currentUser = await User.findById(userId).session(session);
  if (!currentUser) throw new Error("USER_NOT_FOUND");

  recalcUserCredits(currentUser);
  if ((currentUser.credits || 0) <= 0 || getServiceBalance(currentUser, requestedSk, slotDate) <= 0) {
    throw new Error("NO_CREDITS");
  }

  const lot = pickLotToConsumeForSlot(currentUser, requestedSk, slotDate);
  if (!lot) {
    throw new Error(`NO_CREDITS_FOR_SLOT_${requestedSk}`);
  }

  const lotId = lot._id;
  const lotExp = lot.expiresAt || null;

  console.log("[CONSUME PICKED LOT]", {
    userId: String(userId),
    requestedSk,
    serviceKey: String(serviceKey || ""),
    serviceName: String(serviceName || ""),
    lotId: String(lotId || ""),
    lotExp: lotExp || null,
    currentLots: (Array.isArray(currentUser?.creditLots) ? currentUser.creditLots : []).map((x) => ({
      id: String(x?._id || ""),
      serviceKey: String(x?.serviceKey || ""),
      amount: Number(x?.amount || 0),
      remaining: Number(x?.remaining || 0),
      expiresAt: x?.expiresAt || null,
      source: String(x?.source || ""),
    })),
  });

  const upd = await User.updateOne(
    {
      _id: userId,
      creditLots: {
        $elemMatch: {
          _id: lotId,
          serviceKey: requestedSk,
          remaining: { $gt: 0 },
        },
      },
    },
    {
      $inc: { "creditLots.$.remaining": -1 },
    },
    { session }
  );

  console.log("[CONSUME UPDATE RESULT]", {
    userId: String(userId),
    requestedSk,
    lotId: String(lotId || ""),
    matchedCount: Number(upd?.matchedCount || 0),
    modifiedCount: Number(upd?.modifiedCount || 0),
  });

  if (!upd.modifiedCount) {
    throw new Error("CREDIT_CONSUME_FAILED");
  }

  const freshUser = await User.findById(userId).session(session);
  if (!freshUser) throw new Error("USER_NOT_FOUND");

  console.log("[CONSUME USER AFTER UPDATEONE]", {
    userId: String(userId),
    requestedSk,
    lotId: String(lotId || ""),
    lots: (Array.isArray(freshUser?.creditLots) ? freshUser.creditLots : []).map((x) => ({
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

  console.log("[CONSUME BEFORE SAVE]", {
    userId: String(userId),
    requestedSk,
    lotId: String(lotId || ""),
    lots: (Array.isArray(freshUser?.creditLots) ? freshUser.creditLots : []).map((x) => ({
      id: String(x?._id || ""),
      serviceKey: String(x?.serviceKey || ""),
      amount: Number(x?.amount || 0),
      remaining: Number(x?.remaining || 0),
      expiresAt: x?.expiresAt || null,
      source: String(x?.source || ""),
    })),
  });

  await freshUser.save({ session });

  console.log("[CONSUME AFTER SAVE]", {
    userId: String(userId),
    requestedSk,
    lotId: String(lotId || ""),
    lots: (Array.isArray(freshUser?.creditLots) ? freshUser.creditLots : []).map((x) => ({
      id: String(x?._id || ""),
      serviceKey: String(x?.serviceKey || ""),
      amount: Number(x?.amount || 0),
      remaining: Number(x?.remaining || 0),
      expiresAt: x?.expiresAt || null,
      source: String(x?.source || ""),
    })),
  });

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
    console.warn("[REFUND INCONSISTENCY]", {
      userId: String(userId),
      lotId: String(lotId || ""),
      apService: String(apService || ""),
      currentRemaining,
      maxAmount,
      reason: "ORIGINAL_LOT_ALREADY_FULL_ON_REFUND",
    });

    throw new Error("ORIGINAL_LOT_ALREADY_FULL_ON_REFUND");
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
  if (!sk) throw new Error("INVALID_SERVICE");
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


async function refundCreditAtomicToOriginalLotOrNewLot({
  userId,
  lotId,
  apService,
  historyItem,
  session,
}) {
  try {
    return await refundCreditAtomicToOriginalLot({
      userId,
      lotId,
      apService,
      historyItem,
      session,
    });
  } catch (err) {
    const code = String(err?.message || err || "");

    // En turnos fijos puede pasar que el lote original ya esté lleno
    // por cancelaciones previas del mismo plan. Si el turno tenía creditLotId,
    // el crédito sí fue consumido; por eso no lo podemos perder.
    // En ese caso devolvemos un crédito nuevo, manteniendo antes la prioridad
    // de compensar deuda en el flujo que llama a este helper.
    if (code !== "ORIGINAL_LOT_ALREADY_FULL_ON_REFUND" && code !== "REFUND_FAILED") {
      throw err;
    }

    console.warn("[REFUND FALLBACK NEW LOT]", {
      userId: String(userId || ""),
      lotId: String(lotId || ""),
      apService: String(apService || ""),
      reason: code,
    });

    const refunded = await refundCreditAtomicNewLot({
      userId,
      apService,
      historyItem: {
        ...historyItem,
        refundFallbackReason: code,
      },
      session,
    });

    return refunded.user;
  }
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
  const serviceKey = appointmentServiceKey(json);
  const serviceName = serviceKeyToName(serviceKey) || String(json?.service || "").trim();

  return {
    id: json?._id?.toString?.() || json?.id,
    date: json?.date,
    time: json?.time,
    service: serviceName,
    serviceKey,
    status: json?.status || "reserved",
    coach: json?.coach || "",
    userId,
    userName,
    userLastName,
    userFullName,
    userEmail: userObj?.email || "",
    creditExpiresAt: json?.creditExpiresAt || null,
    creditDebitStatus: json?.creditDebitStatus || "",
    fixedDebtAmount: Number(json?.fixedDebtAmount || 0),
    fixedScheduleId: json?.fixedScheduleId || null,
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
    serviceKey: waitlistEntryServiceKey(json) || serviceToKey(json?.service || "") || "",
    status: json?.status || "waiting",
    priorityOrder: Number(json?.priorityOrder || 0),
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
  // La regla nueva no bloquea por días de alta directamente.
  // El job de apto físico envía recordatorios a los días 10/20/30 y recién
  // desde el día 31 marca al usuario como suspendido. Esa suspensión ya se
  // valida por separado con user.suspended.
  const status = String(user?.medicalClearance?.status || "").toLowerCase().trim();
  return status === "suspended";
}

/* =========================
   Cupos + horarios por servicio
========================= */
const PE_CAP_PER_SLOT = 1;
const EP_CAP_PER_SLOT = 12;
const THERAPY_SHARED_CAP_PER_SLOT = 8; // RA + RF + KD + SYN comparten este cupo total por horario.
const NUT_CAP_PER_SLOT = 1;

const PE_NAME = "Primera evaluación presencial";
const EP_NAME = "Entrenamiento Personal";
const RA_NAME = "Rehabilitación activa";
const RF_NAME = "Reeducación funcional";
const KD_NAME = "Kinefilaxia Deportiva";
const SYN_NAME = "Synergy";

const TIMES_EP_WEEKDAY = [
  "07:00", "08:00", "09:00", "10:00",
  "11:00", "12:00", "13:00",
  "14:00", "15:00", "16:00", "17:00",
  "18:00", "19:00", "20:00",
];

// Sala PERFORMANCE: lunes a viernes de 07 a 13 (última 12)
// y 16 a 20 (última 19).
const TIMES_PERFORMANCE_WEEKDAY = [
  "07:00", "08:00", "09:00", "10:00",
  "11:00", "12:00",
  "16:00", "17:00", "18:00", "19:00",
];

const TIMES_DEFAULT = [
  "07:00", "08:00", "09:00", "10:00",
  "11:00", "12:00", "13:00",
  "18:00", "19:00", "20:00",
];

function isTherapyService(serviceNameOrKey) {
  const sk = serviceToKey(serviceNameOrKey);
  return ["RA", "RF", "KD", "SYN"].includes(sk);
}

function getRehabTimesForDate(dateStr) {
  return getPerformanceTimesForDate(dateStr);
}

function getPerformanceTimesForDate(dateStr) {
  if (!dateStr || isSunday(dateStr)) return [];
  if (isSaturday(dateStr)) return [];

  const weekday = getWeekdayMondayFirst(dateStr);
  if (weekday >= 1 && weekday <= 5) return TIMES_PERFORMANCE_WEEKDAY;

  return [];
}

function getTherapySharedTimesForDate(dateStr) {
  return [...new Set([...getRehabTimesForDate(dateStr), ...getPerformanceTimesForDate(dateStr)])];
}

function getAllowedTimesForService(serviceNameOrKey, dateStr = "") {
  if (!dateStr || isSunday(dateStr)) return [];

  const sk = serviceToKey(serviceNameOrKey);

  if (isSaturday(dateStr)) return [];

  if (sk === "PE" || sk === "EP") return TIMES_EP_WEEKDAY;
  if (["RA", "RF", "KD", "SYN"].includes(sk)) return getPerformanceTimesForDate(dateStr);
  if (sk === "NUT") return TIMES_DEFAULT;

  return [];
}

function isAllowedTimeForService(serviceNameOrKey, dateStr, time) {
  const t = String(time || "").slice(0, 5);
  return getAllowedTimesForService(serviceNameOrKey, dateStr).includes(t);
}

function isTherapyAreaActiveAt(dateStr, time) {
  const t = String(time || "").slice(0, 5);
  return getTherapySharedTimesForDate(dateStr).includes(t);
}

function getTherapyCapForSlot(dateStr, time) {
  return isTherapyAreaActiveAt(dateStr, time) ? THERAPY_SHARED_CAP_PER_SLOT : 0;
}

function getEpCapForSlot(dateStr, time) {
  return EP_CAP_PER_SLOT;
}

function getNutCapForSlot(dateStr, time) {
  return NUT_CAP_PER_SLOT;
}

function getSlotReservationStats(existing, dateStr, time) {
  const list = Array.isArray(existing) ? existing : [];

  const peReserved = list.filter((a) => appointmentServiceKey(a) === "PE").length;
  const epReserved = list.filter((a) => appointmentServiceKey(a) === "EP").length;
  const raReserved = list.filter((a) => appointmentServiceKey(a) === "RA").length;
  const rfReserved = list.filter((a) => appointmentServiceKey(a) === "RF").length;
  const kdReserved = list.filter((a) => appointmentServiceKey(a) === "KD").length;
  const nutReserved = list.filter((a) => appointmentServiceKey(a) === "NUT").length;
  const synReserved = list.filter((a) => appointmentServiceKey(a) === "SYN").length;
  const therapyReserved = raReserved + rfReserved + kdReserved + synReserved;

  return {
    totalReserved: list.length,
    peReserved,
    peCap: PE_CAP_PER_SLOT,
    epReserved,
    raReserved,
    rfReserved,
    kdReserved,
    nutReserved,
    synReserved,
    therapyReserved,
    therapyCap: getTherapyCapForSlot(dateStr, time),
    epCap: getEpCapForSlot(dateStr, time),
    nutCap: getNutCapForSlot(dateStr, time),
    synCap: getTherapyCapForSlot(dateStr, time),
    therapyActive: isTherapyAreaActiveAt(dateStr, time),
  };
}


function timeIsInsideScheduleBlock(block, time) {
  if (!block) return false;
  if (block.allDay) return true;

  const t = String(time || "").slice(0, 5);
  const from = String(block.timeFrom || "").slice(0, 5);
  const to = String(block.timeTo || "").slice(0, 5);

  if (!from || !to) return true;
  return t >= from && t < to;
}

function dateMatchesScheduleBlock(block, date) {
  const day = String(date || "").slice(0, 10);
  if (!day || !block?.dateFrom) return false;
  if (day < String(block.dateFrom).slice(0, 10)) return false;

  if (!block.indefinite) {
    const to = String(block.dateTo || block.dateFrom || "").slice(0, 10);
    if (to && day > to) return false;
  }

  const weekdays = Array.isArray(block.weekdays) ? block.weekdays : [];
  if (weekdays.length) {
    const weekday = getWeekdayMondayFirst(day);
    if (!weekdays.map(Number).includes(weekday)) return false;
  }

  return true;
}

function scheduleBlockReason(block) {
  return (
    String(block?.reason || "").trim() ||
    String(block?.title || "").trim() ||
    "Agenda bloqueada"
  );
}

function blockId(block) {
  return String(block?._id || block?.id || "");
}

async function findActiveScheduleBlocksForDateService({ date, serviceKey, session = null }) {
  const day = String(date || "").slice(0, 10);
  const sk = normalizeServiceKey(serviceKey);
  if (!day || !sk) return [];

  const query = ScheduleBlock.find({
    active: true,
    dateFrom: { $lte: day },
    $and: [
      {
        $or: [
          { serviceKeys: sk },
          { allServices: true },
        ],
      },
      {
        $or: [
          { indefinite: true },
          { dateTo: { $gte: day } },
          { dateTo: "" },
          { dateTo: { $exists: false } },
        ],
      },
    ],
  }).sort({ createdAt: -1 });

  if (session) query.session(session);

  const candidates = await query.lean();
  return (candidates || []).filter((block) => dateMatchesScheduleBlock(block, day));
}

function scheduleBlockCoversEveryTime(block, times = []) {
  if (!block || !Array.isArray(times) || !times.length) return false;
  if (block.allDay) return true;

  return times.every((time) => timeIsInsideScheduleBlock(block, time));
}

async function getFullDayScheduleBlockInfo({ date, serviceKey, times = [], session = null }) {
  const cleanTimes = (Array.isArray(times) ? times : [])
    .map((t) => String(t || "").slice(0, 5))
    .filter(Boolean);

  if (!cleanTimes.length) {
    return { blocked: false, reason: "", blockIds: [], blockByTime: {} };
  }

  const blocks = await findActiveScheduleBlocksForDateService({
    date,
    serviceKey,
    session,
  });

  if (!blocks.length) {
    return { blocked: false, reason: "", blockIds: [], blockByTime: {} };
  }

  const blockByTime = {};
  for (const time of cleanTimes) {
    const block = blocks.find((candidate) => timeIsInsideScheduleBlock(candidate, time)) || null;
    if (block) blockByTime[time] = block;
  }

  const blocked = cleanTimes.every((time) => !!blockByTime[time]);
  if (!blocked) {
    return { blocked: false, reason: "", blockIds: [], blockByTime };
  }

  const fullDayBlock = blocks.find((block) => scheduleBlockCoversEveryTime(block, cleanTimes));
  const firstBlock = fullDayBlock || blockByTime[cleanTimes[0]] || blocks[0];
  const blockIds = [
    ...new Set(
      cleanTimes
        .map((time) => blockId(blockByTime[time]))
        .filter(Boolean)
    ),
  ];

  return {
    blocked: true,
    reason: scheduleBlockReason(firstBlock),
    blockIds,
    blockByTime,
    fullDayBlock: fullDayBlock || null,
  };
}

function buildScheduleBlockedSlots(times = [], fullDayInfo = {}) {
  return (Array.isArray(times) ? times : []).map((time) => {
    const t = String(time || "").slice(0, 5);
    const block = fullDayInfo?.blockByTime?.[t] || fullDayInfo?.fullDayBlock || null;

    return {
      time: t,
      state: "blocked",
      reason: block ? scheduleBlockReason(block) : fullDayInfo?.reason || "Agenda bloqueada",
      totalReserved: 0,
      capacity: 0,
      reserved: 0,
      available: 0,
      availableVacancies: 0,
      blockId: blockId(block) || "",
      dayBlocked: true,
    };
  });
}

async function findActiveScheduleBlock({ date, time, serviceKey, session = null }) {
  const blocks = await findActiveScheduleBlocksForDateService({ date, serviceKey, session });

  return (
    blocks.find((block) => timeIsInsideScheduleBlock(block, time)) || null
  );
}

async function assertSlotNotBlocked({ date, time, serviceKey, session = null }) {
  const block = await findActiveScheduleBlock({ date, time, serviceKey, session });
  if (!block) return null;

  const e = new Error(`SCHEDULE_BLOCKED:${scheduleBlockReason(block)}`);
  e.http = 409;
  e.block = block;
  throw e;
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
    refundCutoffHours: 4,
    timelyRefundLimit: 2,
    lateRefundLimit: 1,
  },
  RF: {
    refundCutoffHours: 4,
    timelyRefundLimit: 2,
    lateRefundLimit: 1,
  },
  KD: {
    refundCutoffHours: 4,
    timelyRefundLimit: 2,
    lateRefundLimit: 1,
  },
  SYN: {
    refundCutoffHours: 4,
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

      if (action === "cancelado_con_reintegro") {
        itemType = "timely";
      } else if (action === "cancelado_tarde_con_cortesia") {
        itemType = "late";
      } else if (
        action === "fixed_schedule_debt_released_by_cancel" ||
        action === "fixed_schedule_debt_settled_by_cancelled_credit"
      ) {
        // IMPORTANTE:
        // Si el usuario cancela un turno fijo que no devuelve crédito positivo
        // porque primero baja/compensa deuda, igualmente cuenta como una
        // cancelación con reintegro a nivel política mensual.
        //
        // En entradas nuevas esto ya viene guardado en policyRefundType,
        // pero dejamos este fallback para no abrir un hueco con historiales
        // anteriores o acciones viejas sin metadata explícita.
        itemType = "timely";
      } else {
        itemType = "none";
      }
    }

    if (itemMonth !== wantedMonth) return acc;
    if (wantedSk && itemSk !== wantedSk) return acc;
    if (itemType !== wantedType) return acc;

    return acc + 1;
  }, 0);
}

function buildCancellationHistoryMeta({ appointment, decision, now = new Date() }) {
  const serviceKey = serviceToKey(appointment?.serviceKey || appointment?.service || "");
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

  if (decision?.reason === "FIXED_SCHEDULE_DEBT_RELEASED_BY_CANCEL") {
    return "Cancelaste con el mínimo de anticipación. Este turno fijo estaba en deuda, por eso no se agregó un crédito positivo: se descontó de la deuda pendiente. Esta cancelación cuenta dentro de tus reintegros disponibles del mes.";
  }

  if (decision?.reason === "FIXED_SCHEDULE_DEBT_SETTLED_BY_CANCEL") {
    return "Cancelaste con el mínimo de anticipación. Como tenías deuda del mismo servicio, el crédito de este turno se usó primero para compensar esa deuda. Esta cancelación cuenta dentro de tus reintegros disponibles del mes.";
  }

  if (decision?.reason === "FIXED_SCHEDULE_SETTLED_DEBT_REFUNDED_BY_CANCEL") {
    return "Cancelaste con el mínimo de anticipación. Ese turno fijo ya había sido saldado, por eso se generó el crédito de reintegro correspondiente.";
  }

  if (decision?.refundMode === "timely") {
    if (["RA", "RF", "KD", "SYN"].includes(sk)) {
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
   Turnos fijos: débito/deuda mensual y reversa por baja de plan
========================= */
const FIXED_BILLING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN"]);
const FIXED_BILLING_DONE_STATUSES = new Set(["monthly_reserved", "debited", "debt", "skipped"]);

function isFixedBillingServiceKey(value) {
  const sk = serviceToKey(value);
  return FIXED_BILLING_SERVICE_KEYS.has(sk);
}

// Los turnos manuales del admin también tienen que impactar en la cuenta
// del usuario: si hay crédito, se debita; si no hay crédito, queda deuda.
// Reutilizamos fixedScheduleDebt como saldo/deuda por servicio para no abrir
// otro modelo paralelo ni romper la visualización actual del perfil.
const ADMIN_MANUAL_DEBT_SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN", "NUT"]);

function isAdminManualDebtServiceKey(value) {
  const sk = serviceToKey(value);
  return ADMIN_MANUAL_DEBT_SERVICE_KEYS.has(sk);
}

function isFinanciallyTrackedAppointment(ap) {
  return !!ap?.fixedScheduleId || !!ap?.assignedManually;
}

function isUnpaidDebtAppointment(ap) {
  const serviceKey = serviceToKey(ap?.serviceKey || ap?.service || "");
  const fixedDebtAmount = Math.max(0, Number(ap?.fixedDebtAmount || 0));

  return (
    !!ap?._id &&
    isFinanciallyTrackedAppointment(ap) &&
    isAdminManualDebtServiceKey(serviceKey) &&
    !ap?.creditLotId &&
    (String(ap?.creditDebitStatus || "") === "debt" || fixedDebtAmount > 0)
  );
}

function isSettledDebtAppointmentWithoutLot(ap) {
  const serviceKey = serviceToKey(ap?.serviceKey || ap?.service || "");
  const status = String(ap?.creditDebitStatus || "").trim();

  return (
    !!ap?._id &&
    isFinanciallyTrackedAppointment(ap) &&
    isAdminManualDebtServiceKey(serviceKey) &&
    !ap?.creditLotId &&
    ["monthly_reserved", "debited"].includes(status) &&
    Math.max(0, Number(ap?.fixedDebtAmount || 0)) <= 0
  );
}

function getCurrentMonthRangeYmd(refDate = new Date()) {
  const ref = new Date(refDate);
  const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
  const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);

  return {
    monthKey: getMonthKey(ref),
    startYmd: ymdAR(start),
    endYmd: ymdAR(end),
  };
}

function isYmdInsideRange(day, startYmd, endYmd) {
  const ymd = String(day || "").slice(0, 10);
  if (!ymd || !startYmd || !endYmd) return false;
  return ymd >= startYmd && ymd <= endYmd;
}

function isSlotStrictlyAfterMoment(date, time, moment = new Date()) {
  const slotDate = buildSlotDate(String(date || "").slice(0, 10), String(time || "").slice(0, 5));
  if (!slotDate) return false;

  const ref = moment instanceof Date ? moment : new Date(moment);
  if (Number.isNaN(ref.getTime())) return false;

  // Turnos fijos: solo se generan/debitan/cancelan por plan si el horario
  // todavía es posterior al momento exacto de la acción del admin.
  // Ej: si son 10:01, el turno de hoy 10:00 ya no entra.
  return slotDate.getTime() > ref.getTime();
}

function ensureFixedScheduleDebtObject(user) {
  user.fixedScheduleDebt = user.fixedScheduleDebt || {};

  for (const sk of ["EP", "RA", "RF", "KD", "SYN", "NUT"]) {
    const n = Number(user.fixedScheduleDebt?.[sk] || 0);
    user.fixedScheduleDebt[sk] = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  }

  return user.fixedScheduleDebt;
}

async function applyFixedAppointmentMonthlyBilling({ appointment, actorReq = null, session = null } = {}) {
  const ap = appointment;
  if (!ap?._id) return { ok: false, skipped: true, reason: "NO_APPOINTMENT" };

  const serviceKey = serviceToKey(ap.serviceKey || ap.service || "");
  if (!isFixedBillingServiceKey(serviceKey)) {
    ap.creditDebitStatus = ap.creditDebitStatus || "skipped";
    ap.fixedDebitProcessedAt = ap.fixedDebitProcessedAt || new Date();
    if (session) await ap.save({ session });
    else await ap.save();
    return { ok: true, skipped: true, reason: "SERVICE_NOT_BILLABLE", appointmentId: String(ap._id), serviceKey };
  }

  if (String(ap.status || "") !== "reserved") {
    return { ok: true, skipped: true, reason: "NOT_RESERVED", appointmentId: String(ap._id), serviceKey };
  }

  if (!ap.fixedScheduleId) {
    return { ok: true, skipped: true, reason: "NOT_FIXED_SCHEDULE", appointmentId: String(ap._id), serviceKey };
  }

  const status = String(ap.creditDebitStatus || "").trim();
  if (ap.fixedDebitProcessedAt || FIXED_BILLING_DONE_STATUSES.has(status)) {
    return { ok: true, skipped: true, reason: "ALREADY_PROCESSED", appointmentId: String(ap._id), serviceKey, status };
  }

  const { monthKey, startYmd, endYmd } = getCurrentMonthRangeYmd(new Date());
  if (!isYmdInsideRange(ap.date, startYmd, endYmd)) {
    return { ok: true, skipped: true, reason: "OUTSIDE_CURRENT_MONTH", appointmentId: String(ap._id), serviceKey, monthKey };
  }

  const userQuery = User.findById(ap.user);
  if (session) userQuery.session(session);
  const user = await userQuery;
  if (!user) {
    ap.creditDebitStatus = "skipped";
    ap.fixedDebitProcessedAt = new Date();
    if (session) await ap.save({ session });
    else await ap.save();
    return { ok: false, skipped: true, reason: "USER_NOT_FOUND", appointmentId: String(ap._id), serviceKey };
  }

  const now = new Date();
  recalcUserCredits(user);

  const lot = pickLotToConsume(user, serviceKey);
  if (lot && Number(lot.remaining || 0) > 0) {
    lot.remaining = Number(lot.remaining || 0) - 1;

    user.history = Array.isArray(user.history) ? user.history : [];
    user.history.push({
      action: "fixed_schedule_monthly_debit",
      title: `Débito mensual de turno fijo ${serviceKey}`,
      message: "Se debitó 1 crédito por un turno fijo del mes.",
      date: ap.date,
      time: ap.time,
      service: serviceKeyToName(serviceKey) || ap.service,
      serviceName: serviceKeyToName(serviceKey) || ap.service,
      serviceKey,
      qty: 1,
      appointmentId: ap._id,
      fixedScheduleId: ap.fixedScheduleId,
      policyMonthKey: monthKey,
      createdAt: now,
    });

    recalcUserCredits(user);
    if (session) await user.save({ session });
    else await user.save();

    ap.serviceKey = serviceKey;
    ap.creditLotId = lot._id || null;
    ap.creditExpiresAt = lot.expiresAt || null;
    ap.creditDebitStatus = "monthly_reserved";
    ap.creditDebitedAt = now;
    ap.fixedDebitProcessedAt = now;
    ap.fixedDebtAmount = 0;
    if (session) await ap.save({ session });
    else await ap.save();

    return {
      ok: true,
      action: "debited",
      appointmentId: String(ap._id),
      serviceKey,
      lotId: String(lot._id || ""),
      userCredits: Number(user.credits || 0),
      monthKey,
    };
  }

  ensureFixedScheduleDebtObject(user);
  user.fixedScheduleDebt[serviceKey] = Number(user.fixedScheduleDebt?.[serviceKey] || 0) + 1;
  user.markModified?.("fixedScheduleDebt");

  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    action: "fixed_schedule_monthly_debt",
    title: `Deuda mensual de turno fijo ${serviceKey}`,
    message: "Se generó 1 sesión adeudada por turno fijo sin crédito disponible.",
    date: ap.date,
    time: ap.time,
    service: serviceKeyToName(serviceKey) || ap.service,
    serviceName: serviceKeyToName(serviceKey) || ap.service,
    serviceKey,
    qty: 1,
    appointmentId: ap._id,
    fixedScheduleId: ap.fixedScheduleId,
    policyMonthKey: monthKey,
    createdAt: now,
  });

  recalcUserCredits(user);
  if (session) await user.save({ session });
  else await user.save();

  ap.serviceKey = serviceKey;
  ap.creditDebitStatus = "debt";
  ap.creditLotId = null;
  ap.creditExpiresAt = null;
  ap.creditDebitedAt = null;
  ap.fixedDebitProcessedAt = now;
  ap.fixedDebtAmount = 1;
  if (session) await ap.save({ session });
  else await ap.save();

  return {
    ok: true,
    action: "debt",
    appointmentId: String(ap._id),
    serviceKey,
    userCredits: Number(user.credits || 0),
    debt: Number(user.fixedScheduleDebt?.[serviceKey] || 0),
    monthKey,
  };
}

function isBackfillablePastFixedDebtAppointment(ap, now = new Date()) {
  if (!ap?._id) return false;

  const serviceKey = serviceToKey(ap.serviceKey || ap.service || "");
  if (!isFixedBillingServiceKey(serviceKey)) return false;

  if (!ap.fixedScheduleId) return false;
  if (!["reserved", "completed"].includes(String(ap.status || ""))) return false;

  const slotDate = buildSlotDate(ap.date, ap.time);
  if (!slotDate || slotDate.getTime() > now.getTime()) return false;

  const billingStatus = String(ap.creditDebitStatus || "").trim();
  if (ap.fixedDebitProcessedAt || FIXED_BILLING_DONE_STATUSES.has(billingStatus)) {
    return false;
  }

  if (ap.creditLotId) return false;
  if (Number(ap.fixedDebtAmount || 0) > 0) return false;

  return true;
}

async function backfillPastFixedAppointmentDebt({ appointment, session = null } = {}) {
  const ap = appointment;
  if (!isBackfillablePastFixedDebtAppointment(ap)) {
    return { ok: false, skipped: true, reason: "NOT_BACKFILLABLE" };
  }

  const serviceKey = serviceToKey(ap.serviceKey || ap.service || "");
  const slotDate = buildSlotDate(ap.date, ap.time);
  const monthKey = slotDate ? getMonthKey(slotDate) : getMonthKey(new Date());
  const now = new Date();

  const userQuery = User.findById(ap.user);
  if (session) userQuery.session(session);
  const user = await userQuery;
  if (!user) {
    return { ok: false, skipped: true, reason: "USER_NOT_FOUND" };
  }

  ensureFixedScheduleDebtObject(user);
  user.fixedScheduleDebt[serviceKey] = Number(user.fixedScheduleDebt?.[serviceKey] || 0) + 1;
  user.markModified?.("fixedScheduleDebt");

  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    action: "fixed_schedule_monthly_debt",
    title: `Deuda regularizada de turno fijo ${serviceKey}`,
    message:
      "Se regularizó 1 sesión adeudada de un turno fijo pasado que no tenía procesamiento financiero.",
    date: ap.date,
    time: ap.time,
    service: serviceKeyToName(serviceKey) || ap.service,
    serviceName: serviceKeyToName(serviceKey) || ap.service,
    serviceKey,
    qty: 1,
    appointmentId: ap._id,
    fixedScheduleId: ap.fixedScheduleId,
    policyMonthKey: monthKey,
    createdAt: now,
  });

  recalcUserCredits(user);
  if (session) await user.save({ session });
  else await user.save();

  ap.creditDebitStatus = "debt";
  ap.creditLotId = null;
  ap.creditExpiresAt = null;
  ap.creditDebitedAt = null;
  ap.fixedDebitProcessedAt = now;
  ap.fixedDebtAmount = 1;
  if (String(ap.status || "") === "reserved") {
    ap.status = "completed";
    ap.completedAt = ap.completedAt || now;
  }

  if (session) await ap.save({ session });
  else await ap.save();

  return {
    ok: true,
    action: "debt_backfilled",
    appointmentId: String(ap._id),
    userId: String(user._id),
    serviceKey,
    date: ap.date,
    time: ap.time,
    debt: Number(user.fixedScheduleDebt?.[serviceKey] || 0),
  };
}

async function settleFixedScheduleDebtWithCancelledCreditOnCancel({ user, appointment, historyItem = {}, session = null } = {}) {
  const ap = appointment;
  const serviceKey = serviceToKey(ap?.serviceKey || ap?.service || "");
  const isDebitedTrackedAppointment =
    isFinanciallyTrackedAppointment(ap) &&
    !!ap?.creditLotId &&
    isAdminManualDebtServiceKey(serviceKey);

  if (!user?._id || !isDebitedTrackedAppointment) {
    return { settled: false, amount: 0, serviceKey, user };
  }

  ensureFixedScheduleDebtObject(user);

  const currentDebt = Math.max(0, Number(user.fixedScheduleDebt?.[serviceKey] || 0));
  if (currentDebt <= 0) {
    return { settled: false, amount: 0, serviceKey, user };
  }

  const settled = Math.min(currentDebt, 1);
  user.fixedScheduleDebt[serviceKey] = currentDebt - settled;
  user.markModified?.("fixedScheduleDebt");

  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    ...historyItem,
    action: historyItem?.action || "fixed_schedule_debt_settled_by_cancelled_credit",
    title: historyItem?.title || `Deuda de turno fijo compensada ${serviceKey}`,
    message:
      historyItem?.message ||
      "Se canceló un turno fijo que ya tenía crédito debitado. Como existía deuda del mismo servicio, no se generó crédito positivo: se compensó la deuda pendiente.",
    serviceKey,
    service: serviceKeyToName(serviceKey) || ap.service,
    serviceName: serviceKeyToName(serviceKey) || ap.service,
    qty: settled,
    createdAt: new Date(),
  });

  recalcUserCredits(user);
  if (session) await user.save({ session });
  else await user.save();

  ap.creditDebitStatus = "skipped";
  ap.fixedDebtAmount = 0;

  return { settled: true, amount: settled, serviceKey, user };
}

async function releaseFixedAppointmentDebtOnCancel({ user, appointment, historyItem = {}, session = null } = {}) {
  const ap = appointment;
  const serviceKey = serviceToKey(ap?.serviceKey || ap?.service || "");
  const fixedDebtAmount = Math.max(0, Number(ap?.fixedDebtAmount || 0));
  const isDebtAppointment = isUnpaidDebtAppointment(ap);

  if (!user?._id || !isDebtAppointment || !isAdminManualDebtServiceKey(serviceKey)) {
    return { released: false, amount: 0, serviceKey };
  }

  ensureFixedScheduleDebtObject(user);

  const amount = Math.max(1, fixedDebtAmount || 1);
  const currentDebt = Math.max(0, Number(user.fixedScheduleDebt?.[serviceKey] || 0));
  const released = Math.min(currentDebt, amount);

  if (released > 0) {
    user.fixedScheduleDebt[serviceKey] = currentDebt - released;
    user.markModified?.("fixedScheduleDebt");
  }

  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    ...historyItem,
    action: historyItem?.action || "fixed_schedule_debt_released_by_cancel",
    title: historyItem?.title || `Deuda liberada por cancelación ${serviceKey}`,
    message:
      historyItem?.message ||
      `Se liberó ${released || amount} sesión adeudada por cancelar un turno fijo que estaba marcado como deuda.`,
    serviceKey,
    service: serviceKeyToName(serviceKey) || ap.service,
    serviceName: serviceKeyToName(serviceKey) || ap.service,
    qty: released || amount,
    createdAt: new Date(),
  });

  recalcUserCredits(user);
  if (session) await user.save({ session });
  else await user.save();

  ap.fixedDebtAmount = 0;
  ap.creditDebitStatus = "skipped";

  return { released: true, amount: released || amount, serviceKey };
}

async function reverseFixedAppointmentBillingForPlanDelete({ user, appointment, req, session = null } = {}) {
  const ap = appointment;
  const serviceKey = serviceToKey(ap?.serviceKey || ap?.service || "");

  if (!user?._id || !ap?._id || !ap?.fixedScheduleId || !isFixedBillingServiceKey(serviceKey)) {
    return {
      changed: false,
      refundApplied: false,
      refundMode: "none",
      refundReason: "FIXED_SCHEDULE_DELETE_NO_BILLING",
      user,
      serviceKey,
    };
  }

  const baseHistory = {
    date: ap.date,
    time: ap.time,
    service: serviceKeyToName(serviceKey) || ap.service,
    serviceName: serviceKeyToName(serviceKey) || ap.service,
    serviceKey,
    fixedScheduleId: ap.fixedScheduleId,
    appointmentId: ap._id,
    createdAt: new Date(),
  };

  if (ap.creditLotId) {
    const debtSettlement = await settleFixedScheduleDebtWithCancelledCreditOnCancel({
      user,
      appointment: ap,
      historyItem: {
        ...baseHistory,
        action: "fixed_schedule_debt_settled_by_plan_delete",
        title: `Deuda de turno fijo compensada ${serviceKey}`,
        message:
          "El admin dio de baja el plan de turnos fijos. Este turno ya estaba debitado y se usó para compensar deuda pendiente del mismo servicio.",
      },
      session,
    });

    if (debtSettlement.settled) {
      return {
        changed: true,
        refundApplied: true,
        refundMode: "fixed-debt-settlement",
        refundReason: "FIXED_SCHEDULE_DEBT_SETTLED_BY_PLAN_DELETE",
        user: debtSettlement.user,
        serviceKey,
        amount: Number(debtSettlement.amount || 0),
      };
    }

    const refundedUser = await refundCreditAtomicToOriginalLotOrNewLot({
      userId: user._id,
      lotId: ap.creditLotId,
      apService: ap.service,
      historyItem: {
        ...baseHistory,
        action: "fixed_schedule_credit_refunded_by_plan_delete",
        title: `Crédito devuelto por baja de turno fijo ${serviceKey}`,
        message:
          "El admin dio de baja el plan de turnos fijos. Se devolvió 1 crédito porque no había deuda pendiente para compensar.",
      },
      session,
    });

    return {
      changed: true,
      refundApplied: true,
      refundMode: "fixed-plan-delete-refund",
      refundReason: "FIXED_SCHEDULE_CREDIT_REFUNDED_BY_PLAN_DELETE",
      user: refundedUser,
      serviceKey,
      amount: 1,
    };
  }

  const debtRelease = await releaseFixedAppointmentDebtOnCancel({
    user,
    appointment: ap,
    historyItem: {
      ...baseHistory,
      action: "fixed_schedule_debt_released_by_plan_delete",
      title: `Deuda liberada por baja de turno fijo ${serviceKey}`,
      message:
        "El admin dio de baja el plan de turnos fijos. Se liberó la deuda asociada a este turno futuro.",
    },
    session,
  });

  if (debtRelease.released) {
    return {
      changed: true,
      refundApplied: true,
      refundMode: "fixed-debt-release",
      refundReason: "FIXED_SCHEDULE_DEBT_RELEASED_BY_PLAN_DELETE",
      user,
      serviceKey,
      amount: Number(debtRelease.amount || 0),
    };
  }

  return {
    changed: false,
    refundApplied: false,
    refundMode: "none",
    refundReason: "FIXED_SCHEDULE_DELETE_UNBILLED_FUTURE_APPOINTMENT",
    user,
    serviceKey,
  };
}

/* =========================
   Helpers: validación de item
========================= */
function validateBasicSlotRules({ date, time, service, serviceKey }) {
  const identity = normalizeServiceIdentity({ service, serviceKey });

  if (!date || !time || !identity?.serviceKey) {
    return { ok: false, error: "Faltan campos: date, time y service." };
  }

  const normalizedServiceKey = identity.serviceKey;
  const normalizedServiceName = identity.serviceName;

  if (isSaturday(date)) {
    return { ok: false, error: "Los sábados no hay turnos disponibles para este servicio." };
  }

  if (isSunday(date)) {
    return { ok: false, error: "Los domingos no hay turnos disponibles." };
  }

  const timeNorm = String(time).slice(0, 5);

  if (!isAllowedTimeForService(normalizedServiceKey, date, timeNorm)) {
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

  const adv = validateMinAdvance(slotDate, normalizedServiceKey);
  if (!adv.ok) return adv;

  const isPeService = normalizedServiceKey === "PE";
  const isEpService = normalizedServiceKey === "EP";

  return {
    ok: true,
    turno,
    slotDate,
    isPeService,
    isEpService,
    timeNorm,
    serviceKey: normalizedServiceKey,
    serviceName: normalizedServiceName,
  };
}

function validateBasicSlotRulesAdmin({ date, time, service, serviceKey, bypassWindow = false }) {
  const identity = normalizeServiceIdentity({ service, serviceKey });

  if (!date || !time || !identity?.serviceKey) {
    return { ok: false, error: "Faltan campos: date, time y service." };
  }

  const normalizedServiceKey = identity.serviceKey;
  const normalizedServiceName = identity.serviceName;

  if (isSaturday(date)) {
    return { ok: false, error: "Los sábados no hay turnos disponibles para este servicio." };
  }

  if (isSunday(date)) {
    return { ok: false, error: "Los domingos no hay turnos disponibles." };
  }

  const timeNorm = String(time).slice(0, 5);

  if (!isAllowedTimeForService(normalizedServiceKey, date, timeNorm)) {
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

    const adv = validateMinAdvance(slotDate, normalizedServiceKey);
    if (!adv.ok) return adv;
  }

  const isPeService = normalizedServiceKey === "PE";
  const isEpService = normalizedServiceKey === "EP";

  return {
    ok: true,
    turno,
    slotDate,
    isPeService,
    isEpService,
    timeNorm,
    serviceKey: normalizedServiceKey,
    serviceName: normalizedServiceName,
  };
}

function slotKey(date, time) {
  return `${date}__${time}`;
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildReservedSlotQuery(date, time, extra = {}) {
  const day = String(date || "").slice(0, 10);
  const t = String(time || "").slice(0, 5);

  return {
    ...(extra || {}),
    $or: [
      { date: day },
      { date: { $regex: `^${escapeRegExp(day)}T` } },
    ],
    time: t,
    status: "reserved",
  };
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
  serviceKey,
  notes = "",
  bypassWindow = false,
  bypassCredits = false,
  allowDebtIfNoCredits = false,
  bypassScheduleBlocks = false,
  fixedScheduleId = null,
  monthlyRolloverMonthKey = "",
  skipActivityLog = false,
  session = null,
}) {
  const basic = validateBasicSlotRulesAdmin({
    date,
    time,
    service,
    serviceKey,
    bypassWindow,
  });
  if (!basic.ok) {
    const e = new Error(basic.error);
    e.http = 400;
    throw e;
  }

  const targetUserQuery = User.findById(userId);
  if (session) targetUserQuery.session(session);
  const targetUser = await targetUserQuery;
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

  const requestedSk = basic.serviceKey;
  const hasCreditsForRequestedService =
    (targetUser.credits || 0) > 0 &&
    getServiceBalance(targetUser, requestedSk, basic.slotDate) > 0 &&
    hasValidCreditsForServiceAndSlot(targetUser, requestedSk, basic.slotDate);

  if (!bypassCredits && !hasCreditsForRequestedService) {
    if (allowDebtIfNoCredits && isAdminManualDebtServiceKey(requestedSk)) {
      // El admin puede asignar igual: después generamos deuda del servicio.
    } else if ((targetUser.credits || 0) <= 0 || getServiceBalance(targetUser, requestedSk, basic.slotDate) <= 0) {
      const e = new Error("NO_CREDITS");
      e.http = 403;
      throw e;
    } else {
      const e = new Error(`NO_CREDITS_FOR_SLOT_${requestedSk}`);
      e.http = 403;
      throw e;
    }
  }

  const t = String(time).slice(0, 5);

  if (!bypassScheduleBlocks) {
    await assertSlotNotBlocked({
      date,
      time: t,
      serviceKey: basic.serviceKey,
      session,
    });
  }

  const alreadyByUserQuery = Appointment.findOne(
    buildReservedSlotQuery(date, t, { user: targetUser._id })
  );
  if (session) alreadyByUserQuery.session(session);
  const alreadyByUser = await alreadyByUserQuery.lean();

  if (alreadyByUser) {
    const e = new Error("ALREADY_HAVE_SLOT");
    e.http = 409;
    throw e;
  }

  const existingAtSlotQuery = Appointment.find(
    buildReservedSlotQuery(date, t)
  );
  if (session) existingAtSlotQuery.session(session);
  const existingAtSlot = await existingAtSlotQuery.lean();

  const stats = getSlotReservationStats(existingAtSlot, date, t);

  if (basic.isPeService) {
    if (stats.peReserved >= stats.peCap) {
      const e = new Error("SERVICE_CAP_REACHED");
      e.http = 409;
      throw e;
    }
  } else if (basic.isEpService) {
    if (stats.epReserved >= stats.epCap) {
      const e = new Error("SERVICE_CAP_REACHED");
      e.http = 409;
      throw e;
    }
  } else if (isTherapyService(requestedSk)) {

    if (stats.therapyReserved >= stats.therapyCap) {
      const e = new Error("SERVICE_CAP_REACHED");
      e.http = 409;
      throw e;
    }
  } else if (requestedSk === "NUT") {
    if (stats.nutReserved >= stats.nutCap) {
      const e = new Error("SERVICE_CAP_REACHED");
      e.http = 409;
      throw e;
    }
  }

  let effectiveUser = targetUser;
  let usedLotId = null;
  let usedLotExp = null;
  let creditDebitStatus = "";
  let creditDebitedAt = null;
  let fixedDebitProcessedAt = null;
  let fixedDebtAmount = 0;
  let manualBillingAction = "none";

  if (!bypassCredits && hasCreditsForRequestedService) {
    const consumed = await consumeCreditAtomic({
      userId: targetUser._id,
      serviceKey: basic.serviceKey,
      serviceName: basic.serviceName,
      historyItem: {
        action: "reservado_por_admin",
        date,
        time: t,
        service: basic.serviceName,
        serviceName: basic.serviceName,
        serviceKey: basic.serviceKey,
      },
      slotDate: basic.slotDate,
      session,
    });

    effectiveUser = consumed.user;
    usedLotId = consumed.usedLotId;
    usedLotExp = consumed.usedLotExp;
    creditDebitStatus = "debited";
    creditDebitedAt = new Date();
    fixedDebitProcessedAt = creditDebitedAt;
    manualBillingAction = "debited";
  } else if (!bypassCredits && allowDebtIfNoCredits && isAdminManualDebtServiceKey(requestedSk)) {
    const now = new Date();

    ensureFixedScheduleDebtObject(targetUser);
    targetUser.fixedScheduleDebt[requestedSk] =
      Number(targetUser.fixedScheduleDebt?.[requestedSk] || 0) + 1;
    targetUser.markModified?.("fixedScheduleDebt");

    targetUser.history = Array.isArray(targetUser.history) ? targetUser.history : [];
    targetUser.history.push({
      action: "manual_admin_debt",
      title: `Deuda generada por turno manual ${requestedSk}`,
      message: "El admin asignó un turno manual sin crédito disponible. Se generó 1 sesión adeudada del servicio.",
      date,
      time: t,
      service: basic.serviceName,
      serviceName: basic.serviceName,
      serviceKey: basic.serviceKey,
      qty: 1,
      createdAt: now,
    });

    recalcUserCredits(targetUser);
    if (session) await targetUser.save({ session });
    else await targetUser.save();

    effectiveUser = targetUser;
    creditDebitStatus = "debt";
    fixedDebtAmount = 1;
    fixedDebitProcessedAt = now;
    manualBillingAction = "debt";
  } else if (bypassCredits) {
    targetUser.history = Array.isArray(targetUser.history) ? targetUser.history : [];
    targetUser.history.push({
      action: fixedScheduleId ? "turno_fijo_asignado" : "reservado_por_admin_sin_credito",
      date,
      time: t,
      service: basic.serviceName,
      serviceName: basic.serviceName,
      serviceKey: basic.serviceKey,
      title: fixedScheduleId
        ? "Turno fijo asignado por administración."
        : "Turno asignado por administración sin consumir crédito.",
      createdAt: new Date(),
    });
    recalcUserCredits(targetUser);
    if (session) await targetUser.save({ session });
    else await targetUser.save();
    effectiveUser = targetUser;
    manualBillingAction = fixedScheduleId ? "pending_fixed_billing" : "skipped";
  }

  console.log("[BOOKING DEBUG AFTER CONSUME]", {
    userId: String(effectiveUser?._id || targetUser?._id || ""),
    service: service,
    usedLotId: String(usedLotId || ""),
    usedLotExp: usedLotExp || null,
    userCredits: Number(effectiveUser?.credits || 0),
    lots: serializeUserCreditLots(effectiveUser),
  });

  const createdDocs = await Appointment.create(
    [{
      date,
      time: t,
      service: basic.serviceName,
      serviceKey: basic.serviceKey,
      user: targetUser._id,
      status: "reserved",
      creditLotId: usedLotId,
      creditExpiresAt: usedLotExp,
      creditDebitStatus,
      creditDebitedAt,
      fixedDebitProcessedAt,
      fixedDebtAmount,
      createdByRole: String(actorReq?.user?.role || "").toLowerCase(),
      createdByUser: actorReq?.user?._id || actorReq?.user?.id || null,
      assignedManually: true,
      fixedScheduleId: fixedScheduleId || null,
      monthlyRolloverMonthKey: monthlyRolloverMonthKey || "",
    }],
    session ? { session } : undefined
  );

  const created = Array.isArray(createdDocs) ? createdDocs[0] : createdDocs;

  const populatedQuery = Appointment.findById(created._id)
    .populate("user", "name lastName email");
  if (session) populatedQuery.session(session);
  const populated = await populatedQuery;

  if (!skipActivityLog) {
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
        serviceName: basic.serviceName,
        assignedByAdmin: true,
      },
    });
  }

  const serialized = serializeAppointment(populated);
  serialized.userCredits = Number(effectiveUser.credits || 0);
  serialized.userCreditLots = serializeUserCreditLots(effectiveUser);
  serialized.manualBillingAction = manualBillingAction;
  serialized.billingAction = manualBillingAction;
  serialized.fixedScheduleDebt = effectiveUser?.fixedScheduleDebt || {};

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
          creditLots: {
            $elemMatch: {
              _id: standalonePeLot._id,
              serviceKey: "PE",
              remaining: { $gt: 0 },
            },
          },
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
   POST /appointments/waitlist/claim (public token flow)
========================= */
router.post("/waitlist/claim", async (req, res, next) => {
  const token = String(req.body?.token || "").trim();
  if (!token) return next();

  const session = await mongoose.startSession();

  try {
    let createdAppointment = null;

    await session.withTransaction(async () => {
      const entry = await WaitlistEntry.findOne({
        notifyToken: token,
        tokenExpiresAt: { $gt: new Date() },
      }).session(session);

      if (!entry) throw new Error("WAITLIST_TOKEN_INVALID");
      if (String(entry.status || "") !== "notified") {
        throw new Error("WAITLIST_NOT_ACTIVE");
      }

      createdAppointment = await createAppointmentForTargetUser({
        userId: String(entry.user),
        actorReq: {
          user: {
            _id: entry.user,
            id: entry.user,
            role: "client",
          },
        },
        date: entry.date,
        time: entry.time,
        service: entry.service || EP_NAME,
        serviceKey: entry.serviceKey || "EP",
        notes: entry.notes || "",
        bypassWindow: true,
      });

      entry.status = "claimed";
      entry.claimedAt = new Date();
      entry.claimedBy = entry.user || null;
      entry.assignedAppointmentId = createdAppointment?.id || null;
      entry.closeReason = "CLAIMED_BY_CLIENT";
      entry.notifyToken = null;
      entry.tokenExpiresAt = null;
      await entry.save({ session });

      // La sala de espera queda bajo gestión manual del admin.
      // No cerramos automáticamente el resto de la cola: puede quedar cupo
      // disponible para más de una persona o para otro servicio del pool RA/RF/KD/SYN.
    });

    return res.status(201).json({
      ok: true,
      appointment: createdAppointment,
    });
  } catch (err) {
    console.error("Error en POST /appointments/waitlist/claim (token):", err);
    const msg = String(err?.message || "");

    if (msg === "WAITLIST_TOKEN_INVALID") {
      return res.status(404).json({ error: "El link de la lista de espera es inválido o venció." });
    }
    if (msg === "WAITLIST_NOT_ACTIVE") {
      return res.status(409).json({ error: "La vacante ya no está disponible." });
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
      return res.status(409).json({ error: "Ya tenías ese turno reservado." });
    }
    if (msg.startsWith("SCHEDULE_BLOCKED:")) {
      return res.status(409).json({
        error: msg.replace("SCHEDULE_BLOCKED:", "") || "Agenda bloqueada para ese horario.",
      });
    }
    if (msg === "SERVICE_CAP_REACHED" || msg === "TOTAL_CAP_REACHED") {
      return res.status(409).json({ error: "La vacante ya fue ocupada." });
    }

    return res.status(500).json({ error: "No se pudo confirmar el turno." });
  } finally {
    await session.endSession();
  }
});

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

    const now = new Date();

    if (!user.aptoPath) {
      user.aptoPath = "ADMIN_COMPLETED_APTO";
    }

    user.aptoStatus = "approved";
    user.aptoCompletedAt = now;
    user.medicalClearance = user.medicalClearance || {};
    user.medicalClearance.status = "approved";
    user.medicalClearance.approvedAt = now;
    user.medicalClearance.rejectedAt = null;
    user.medicalClearance.suspendedAt = null;
    user.medicalClearance.lastCheckedAt = now;

    if (user.suspended && String(user.suspendedReason || "") === "medical_clearance") {
      user.suspended = false;
      user.suspendedReason = "";
      user.suspendedAt = null;
    }

    user.history = Array.isArray(user.history) ? user.history : [];
    user.history.push({
      action: "apto_completado_por_admin",
      title: "Apto físico aprobado",
      message: "Se marcó manualmente el apto como aprobado.",
      createdAt: now,
    });

    await user.save();

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

router.post("/admin/backfill-fixed-debt", ensureStaff, async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const dryRun =
      req.body?.dryRun !== false &&
      String(req.query?.dryRun || "1") !== "0" &&
      String(req.query?.dryRun || "true") !== "false";

    const userId = String(req.body?.userId || req.query?.userId || "").trim();
    const serviceKey = serviceToKey(req.body?.serviceKey || req.query?.serviceKey || "");
    const from = String(req.body?.from || req.query?.from || "").slice(0, 10);
    const to = String(req.body?.to || req.query?.to || ymdAR()).slice(0, 10);
    const limit = Math.min(1000, Math.max(1, Number(req.body?.limit || req.query?.limit || 500)));
    const now = new Date();

    const query = {
      fixedScheduleId: { $ne: null },
      status: { $in: ["reserved", "completed"] },
      date: { $lte: to || ymdAR() },
      creditLotId: null,
      $or: [
        { fixedDebitProcessedAt: null },
        { fixedDebitProcessedAt: { $exists: false } },
      ],
      $and: [
        {
          $or: [
            { creditDebitStatus: "" },
            { creditDebitStatus: null },
            { creditDebitStatus: { $exists: false } },
          ],
        },
        {
          $or: [
            { fixedDebtAmount: 0 },
            { fixedDebtAmount: null },
            { fixedDebtAmount: { $exists: false } },
          ],
        },
      ],
    };

    if (from) query.date.$gte = from;

    if (userId) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ error: "userId inválido." });
      }
      query.user = userId;
    }

    if (serviceKey) query.serviceKey = serviceKey;

    const candidatesRaw = await Appointment.find(query)
      .sort({ date: 1, time: 1, createdAt: 1 })
      .limit(limit)
      .populate("user", "name lastName email")
      .lean();

    const candidates = (candidatesRaw || []).filter((ap) =>
      isBackfillablePastFixedDebtAppointment(ap, now)
    );

    const summaryByService = {};
    const summaryByUser = {};

    for (const ap of candidates) {
      const sk = serviceToKey(ap.serviceKey || ap.service || "");
      summaryByService[sk] = Number(summaryByService[sk] || 0) + 1;

      const userObj = ap.user || {};
      const uid = String(userObj?._id || ap.user || "");
      const userName = [userObj?.name, userObj?.lastName].filter(Boolean).join(" ").trim();

      if (!summaryByUser[uid]) {
        summaryByUser[uid] = {
          userId: uid,
          fullName: userName || "Usuario",
          email: userObj?.email || "",
          count: 0,
          byService: {},
        };
      }

      summaryByUser[uid].count += 1;
      summaryByUser[uid].byService[sk] = Number(summaryByUser[uid].byService[sk] || 0) + 1;
    }

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        message:
          "Simulación: no se modificó nada. Enviar dryRun=false en el body para aplicar.",
        scanned: candidatesRaw.length,
        candidates: candidates.length,
        summaryByService,
        summaryByUser: Object.values(summaryByUser),
        sample: candidates.slice(0, 50).map((ap) => ({
          appointmentId: String(ap._id),
          userId: String(ap.user?._id || ap.user || ""),
          fullName: [ap.user?.name, ap.user?.lastName].filter(Boolean).join(" ").trim(),
          email: ap.user?.email || "",
          date: ap.date,
          time: ap.time,
          service: ap.service,
          serviceKey: serviceToKey(ap.serviceKey || ap.service || ""),
          status: ap.status,
        })),
      });
    }

    const applied = [];
    const skipped = [];

    await session.withTransaction(async () => {
      for (const candidate of candidates) {
        const ap = await Appointment.findById(candidate._id).session(session);

        if (!ap || !isBackfillablePastFixedDebtAppointment(ap, now)) {
          skipped.push({
            appointmentId: String(candidate._id),
            reason: "NOT_BACKFILLABLE_AT_APPLY_TIME",
          });
          continue;
        }

        const result = await backfillPastFixedAppointmentDebt({
          appointment: ap,
          session,
        });

        if (result?.ok) applied.push(result);
        else {
          skipped.push({
            appointmentId: String(candidate._id),
            reason: result?.reason || "SKIPPED",
          });
        }
      }
    });

    await logActivity({
      req,
      category: "appointments",
      action: "fixed_schedule_past_debt_backfilled",
      entity: "appointment_batch",
      entityId: "fixed_schedule_past_debt_backfill",
      title: "Deuda de turnos fijos pasados regularizada",
      description:
        "Se regularizaron como deuda turnos fijos pasados que no tenían procesamiento financiero.",
      subject: buildUserSubject({ _id: req.user?._id || req.user?.id || "" }),
      meta: {
        appliedCount: applied.length,
        skippedCount: skipped.length,
        filters: { userId, serviceKey, from, to, limit },
        summaryByService,
      },
    });

    return res.json({
      ok: true,
      dryRun: false,
      appliedCount: applied.length,
      skippedCount: skipped.length,
      applied,
      skipped,
    });
  } catch (err) {
    console.error("POST /appointments/admin/backfill-fixed-debt error:", err);
    return res.status(500).json({
      error: err?.message || "No se pudo regularizar la deuda de turnos pasados.",
    });
  } finally {
    await session.endSession();
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
   GET /appointments/availability/month
   Devuelve estado por día para que el front desactive días bloqueados completos.
========================= */
router.get("/availability/month", async (req, res) => {
  try {
    const service = String(req.query?.service || "").trim();
    const serviceKey = String(req.query?.serviceKey || "").trim();
    const month = String(req.query?.month || "").slice(0, 7);

    let from = String(req.query?.from || "").slice(0, 10);
    let to = String(req.query?.to || "").slice(0, 10);

    if ((!from || !to) && /^\d{4}-\d{2}$/.test(month)) {
      const [y, m] = month.split("-").map(Number);
      from = ymdAR(new Date(y, m - 1, 1));
      to = ymdAR(new Date(y, m, 0));
    }

    const identity = normalizeServiceIdentity({ service, serviceKey });

    if (!identity?.serviceKey) {
      return res.status(400).json({ error: "Falta service." });
    }

    if (!isValidYMD(from) || !isValidYMD(to) || from > to) {
      return res.status(400).json({ error: "Rango de fechas inválido." });
    }

    const start = buildSlotDate(from, "00:00");
    const end = buildSlotDate(to, "00:00");
    if (!start || !end) {
      return res.status(400).json({ error: "Rango de fechas inválido." });
    }

    const diffDays = Math.floor((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)) + 1;
    if (diffDays > 62) {
      return res.status(400).json({ error: "El rango máximo permitido es de 62 días." });
    }

    const normalizedServiceKey = identity.serviceKey;
    const normalizedServiceName = identity.serviceName;
    const days = [];
    const cursor = new Date(start);

    while (cursor.getTime() <= end.getTime()) {
      const date = ymdAR(cursor);
      const allowedTimes = getAllowedTimesForService(normalizedServiceKey, date);

      if (!allowedTimes.length || isSunday(date) || isSaturday(date)) {
        days.push({
          date,
          service: normalizedServiceName,
          serviceKey: normalizedServiceKey,
          state: "closed",
          dayBlocked: false,
          dayDisabled: true,
          reason: isSunday(date)
            ? "Domingos no disponibles"
            : isSaturday(date)
              ? "Sábados no disponibles para este servicio"
              : "Sin horarios disponibles",
          blockIds: [],
        });
        cursor.setDate(cursor.getDate() + 1);
        continue;
      }

      const fullDayBlockInfo = await getFullDayScheduleBlockInfo({
        date,
        serviceKey: normalizedServiceKey,
        times: allowedTimes,
      });

      days.push({
        date,
        service: normalizedServiceName,
        serviceKey: normalizedServiceKey,
        state: fullDayBlockInfo.blocked ? "blocked" : "available",
        dayBlocked: !!fullDayBlockInfo.blocked,
        dayDisabled: !!fullDayBlockInfo.blocked,
        reason: fullDayBlockInfo.blocked ? fullDayBlockInfo.reason : "",
        blockIds: fullDayBlockInfo.blockIds || [],
      });

      cursor.setDate(cursor.getDate() + 1);
    }

    return res.json({
      ok: true,
      from,
      to,
      service: normalizedServiceName,
      serviceKey: normalizedServiceKey,
      days,
      blockedDays: days
        .filter((day) => day.dayBlocked)
        .map((day) => day.date),
    });
  } catch (err) {
    console.error("Error en GET /appointments/availability/month:", err);
    return res.status(500).json({ error: "Error calculando disponibilidad mensual." });
  }
});

/* =========================
   GET /appointments/availability
========================= */
router.get("/availability", async (req, res) => {
  try {
    const date = String(req.query?.date || "").slice(0, 10);
    const service = String(req.query?.service || "").trim();
    const serviceKey = String(req.query?.serviceKey || "").trim();

    const identity = normalizeServiceIdentity({ service, serviceKey });

    if (!date || !identity?.serviceKey) {
      return res.status(400).json({ error: "Faltan params: date y service." });
    }

    const normalizedServiceKey = identity.serviceKey;
    const normalizedServiceName = identity.serviceName;
    const allowedTimes = getAllowedTimesForService(normalizedServiceKey, date);

    const times =
      Array.isArray(req.query?.times) && req.query.times.length
        ? req.query.times
            .map((x) => String(x).slice(0, 5))
            .filter((t) => allowedTimes.includes(t))
        : allowedTimes;

    const requesterId = req.user?._id || req.user?.id;
    const requesterRole = String(req.user?.role || "");
    const staffAvailabilityRequest = isStaffActor(req);
    const ignoreScheduleBlocks =
      staffAvailabilityRequest &&
      ["1", "true", "yes", "si", "sí"].includes(
        String(req.query?.ignoreScheduleBlocks || "").toLowerCase().trim()
      );
    const bypassWindowForAvailability =
      staffAvailabilityRequest &&
      ["1", "true", "yes", "si", "sí"].includes(
        String(req.query?.bypassWindow || req.query?.adminFixed || "").toLowerCase().trim()
      );

    if (requesterId && !staffAvailabilityRequest) {
      await syncPastAppointmentsForUserId(requesterId);

      const me = await User.findById(requesterId)
        .select("role suspended suspendedReason aptoPath aptoStatus medicalClearance createdAt credits creditLots firstEvaluationCompleted firstEvaluationCompletedAt")
        .lean();

      if (!me) {
        return res.status(403).json({ error: "Usuario no encontrado." });
      }

      if (me.suspended) {
        return res.json({
          date,
          service: normalizedServiceName,
          serviceKey: normalizedServiceKey,
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
          service: normalizedServiceName,
          serviceKey: normalizedServiceKey,
          slots: times.map((t) => ({
            time: t,
            state: "closed",
            reason: "Falta apto médico",
          })),
        });
      }

      // La primera evaluación ya no es obligatoria para reservar otros servicios.
      // El admin puede marcarla como completada, pero no bloquea disponibilidad.
    }

    if (isSunday(date) || isSaturday(date)) {
      return res.json({
        date,
        service: normalizedServiceName,
        serviceKey: normalizedServiceKey,
        dayState: "closed",
        dayBlocked: false,
        dayDisabled: true,
        reason: isSunday(date)
          ? "Domingos no disponibles"
          : "Sábados no disponibles para este servicio",
        slots: times.map((t) => ({
          time: t,
          state: "closed",
          reason: isSunday(date)
            ? "Domingos no disponibles"
            : "Sábados no disponibles para este servicio",
        })),
      });
    }

    if (!ignoreScheduleBlocks) {
      const fullDayBlockInfo = await getFullDayScheduleBlockInfo({
        date,
        serviceKey: normalizedServiceKey,
        times,
      });

      if (fullDayBlockInfo.blocked) {
        return res.json({
          date,
          service: normalizedServiceName,
          serviceKey: normalizedServiceKey,
          dayState: "blocked",
          dayBlocked: true,
          dayDisabled: true,
          reason: fullDayBlockInfo.reason,
          blockIds: fullDayBlockInfo.blockIds || [],
          slots: buildScheduleBlockedSlots(times, fullDayBlockInfo),
        });
      }
    }

    const out = [];

    for (const time of times) {
      const t = String(time).slice(0, 5);
      const basic = bypassWindowForAvailability
        ? validateBasicSlotRulesAdmin({
            date,
            time: t,
            service: normalizedServiceName,
            serviceKey: normalizedServiceKey,
            bypassWindow: true,
          })
        : validateBasicSlotRules({
            date,
            time: t,
            service: normalizedServiceName,
            serviceKey: normalizedServiceKey,
          });

      if (!basic.ok) {
        out.push({ time: t, state: "closed", reason: basic.error });
        continue;
      }

      if (!ignoreScheduleBlocks) {
        const block = await findActiveScheduleBlock({
          date,
          time: t,
          serviceKey: normalizedServiceKey,
        });

        if (block) {
          out.push({
            time: t,
            state: "blocked",
            reason: scheduleBlockReason(block),
            totalReserved: 0,
            capacity: 0,
            reserved: 0,
            available: 0,
            availableVacancies: 0,
            blockId: String(block._id || block.id || ""),
          });
          continue;
        }
      }

      if (requesterId && !staffAvailabilityRequest) {
        const me = await User.findById(requesterId)
          .select("credits creditLots firstEvaluationCompleted")
          .lean();

        if (!hasValidCreditsForServiceAndSlot(me, normalizedServiceKey, basic.slotDate)) {
          out.push({
            time: t,
            state: "closed",
            reason: "No tenés sesiones válidas para ese día y horario",
          });
          continue;
        }
      }

      const existing = await Appointment.find(buildReservedSlotQuery(date, t))
        .select("service serviceKey serviceName")
        .lean();

      const stats = getSlotReservationStats(existing, date, t);
      const isTherapy = isTherapyService(normalizedServiceKey);
      if (basic.isPeService) {
        if (stats.peReserved >= stats.peCap) {
          out.push({
            time: t,
            state: "full",
            reason: "Sin cupo disponible",
            totalReserved: stats.totalReserved,
            peReserved: stats.peReserved,
            peCap: stats.peCap,
            epReserved: stats.epReserved,
            epCap: stats.epCap,
            therapyReserved: stats.therapyReserved,
            therapyCap: stats.therapyCap,
            raReserved: stats.raReserved,
            rfReserved: stats.rfReserved,
            kdReserved: stats.kdReserved,
            nutReserved: stats.nutReserved,
            nutCap: stats.nutCap,
            synReserved: stats.synReserved,
            synCap: stats.synCap,
            capacity: stats.peCap,
            reserved: stats.peReserved,
            available: Math.max(0, stats.peCap - stats.peReserved),
            availableVacancies: Math.max(0, stats.peCap - stats.peReserved),
            slotGroup: "PE",
          });
          continue;
        }
      } else if (basic.isEpService) {
        if (stats.epReserved >= stats.epCap) {
          const waitlistCheck = validateWaitlistOpen(basic.slotDate, normalizedServiceKey);

          out.push({
            time: t,
            state: waitlistCheck.ok ? "waitlist" : "waitlist_closed",
            reason: waitlistCheck.ok ? "" : waitlistCheck.error,
            totalReserved: stats.totalReserved,
            peReserved: stats.peReserved,
            peCap: stats.peCap,
            epReserved: stats.epReserved,
            epCap: stats.epCap,
            therapyReserved: stats.therapyReserved,
            therapyCap: stats.therapyCap,
            raReserved: stats.raReserved,
            rfReserved: stats.rfReserved,
            kdReserved: stats.kdReserved,
            nutReserved: stats.nutReserved,
            nutCap: stats.nutCap,
            synReserved: stats.synReserved,
            synCap: stats.synCap,
            capacity: stats.epCap,
            reserved: stats.epReserved,
            available: Math.max(0, stats.epCap - stats.epReserved),
            availableVacancies: Math.max(0, stats.epCap - stats.epReserved),
            slotGroup: "EP",
          });
          continue;
        }
      } else if (isTherapy) {
        if (stats.therapyReserved >= stats.therapyCap) {
          const waitlistCheck = validateWaitlistOpen(basic.slotDate, normalizedServiceKey);

          out.push({
            time: t,
            state: waitlistCheck.ok ? "waitlist" : "waitlist_closed",
            reason: waitlistCheck.ok ? "" : waitlistCheck.error,
            totalReserved: stats.totalReserved,
            epReserved: stats.epReserved,
            epCap: stats.epCap,
            therapyReserved: stats.therapyReserved,
            therapyCap: stats.therapyCap,
            raReserved: stats.raReserved,
            rfReserved: stats.rfReserved,
            kdReserved: stats.kdReserved,
            nutReserved: stats.nutReserved,
            nutCap: stats.nutCap,
            synReserved: stats.synReserved,
            synCap: stats.synCap,
            capacity: stats.therapyCap,
            reserved: stats.therapyReserved,
            available: Math.max(0, stats.therapyCap - stats.therapyReserved),
            availableVacancies: Math.max(0, stats.therapyCap - stats.therapyReserved),
            slotGroup: "THERAPY_SHARED",
          });
          continue;
        }
      } else if (normalizedServiceKey === "NUT") {
        if (stats.nutReserved >= stats.nutCap) {
          out.push({
            time: t,
            state: "full",
            reason: "Sin cupo disponible",
            totalReserved: stats.totalReserved,
            peReserved: stats.peReserved,
            peCap: stats.peCap,
            epReserved: stats.epReserved,
            epCap: stats.epCap,
            therapyReserved: stats.therapyReserved,
            therapyCap: stats.therapyCap,
            raReserved: stats.raReserved,
            rfReserved: stats.rfReserved,
            kdReserved: stats.kdReserved,
            nutReserved: stats.nutReserved,
            nutCap: stats.nutCap,
            synReserved: stats.synReserved,
            synCap: stats.synCap,
            capacity: stats.nutCap,
            reserved: stats.nutReserved,
            available: Math.max(0, stats.nutCap - stats.nutReserved),
            availableVacancies: Math.max(0, stats.nutCap - stats.nutReserved),
            slotGroup: "NUT",
          });
          continue;
        }
      }

      const slotCapacity = basic.isPeService
        ? stats.peCap
        : basic.isEpService
          ? stats.epCap
          : isTherapy
            ? stats.therapyCap
            : normalizedServiceKey === "NUT"
              ? stats.nutCap
              : 0;
      const slotReserved = basic.isPeService
        ? stats.peReserved
        : basic.isEpService
          ? stats.epReserved
          : isTherapy
            ? stats.therapyReserved
            : normalizedServiceKey === "NUT"
              ? stats.nutReserved
              : stats.totalReserved;
      const availableVacancies = Math.max(0, slotCapacity - slotReserved);

      out.push({
        time: t,
        state: "available",
        totalReserved: stats.totalReserved,
        peReserved: stats.peReserved,
        peCap: stats.peCap,
        epReserved: stats.epReserved,
        epCap: stats.epCap,
        therapyReserved: stats.therapyReserved,
        therapyCap: stats.therapyCap,
        raReserved: stats.raReserved,
        rfReserved: stats.rfReserved,
        kdReserved: stats.kdReserved,
        nutReserved: stats.nutReserved,
        nutCap: stats.nutCap,
        synReserved: stats.synReserved,
        synCap: stats.synCap,
        capacity: slotCapacity,
        reserved: slotReserved,
        available: availableVacancies,
        availableVacancies,
        slotGroup: basic.isPeService ? "PE" : basic.isEpService ? "EP" : isTherapy ? "THERAPY_SHARED" : normalizedServiceKey === "NUT" ? "NUT" : "OTHER",
      });
    }

    return res.json({ date, service: normalizedServiceName, serviceKey: normalizedServiceKey, slots: out });
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
          ? [{ date: req.body.date, time: req.body.time, service: req.body.service, serviceKey: req.body.serviceKey }]
          : [];

    if (!items.length) {
      return res.status(400).json({ error: "Faltan items para asignar." });
    }

    const created = [];
    const conflicts = [];

    for (const it of items) {
      const itemSession = await mongoose.startSession();
      try {
        let ap = null;

        await itemSession.withTransaction(async () => {
          ap = await createAppointmentForTargetUser({
            userId,
            actorReq: req,
            date: String(it?.date || "").slice(0, 10),
            time: String(it?.time || "").slice(0, 5),
            service: String(it?.service || "").trim(),
            serviceKey: String(it?.serviceKey || "").trim(),
            notes,
            bypassWindow: true,
            bypassCredits: false,
            allowDebtIfNoCredits: true,
            skipActivityLog: true,
            session: itemSession,
          });
        });

        created.push(ap);
      } catch (e) {
        conflicts.push({
          date: String(it?.date || "").slice(0, 10),
          time: String(it?.time || "").slice(0, 5),
          service: String(it?.service || "").trim(),
          serviceKey: String(it?.serviceKey || "").trim(),
          error: e?.message || "No se pudo asignar.",
        });
      } finally {
        await itemSession.endSession();
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

    if (created.length) {
      const targetUserForLog = await User.findById(userId)
        .select("name lastName email role")
        .lean()
        .catch(() => null);

      await logActivity({
        req,
        category: "appointments",
        action: "appointments_assigned_by_admin_batch",
        entity: "appointment",
        entityId: created.map((x) => x.id).filter(Boolean).join(","),
        title: "Turnos asignados por admin",
        description: `Se asignaron ${created.length} turno(s) a un usuario desde administración.`,
        subject: buildUserSubject(targetUserForLog || { _id: userId }),
        meta: {
          assignedByAdmin: true,
          createdCount: created.length,
          conflictsCount: conflicts.length,
          user: {
            id: String(targetUserForLog?._id || userId),
            name: [targetUserForLog?.name, targetUserForLog?.lastName].filter(Boolean).join(" ").trim(),
            email: targetUserForLog?.email || "",
          },
          items: created.map((x) => ({
            id: x.id,
            date: x.date,
            time: x.time,
            service: x.service,
            serviceKey: x.serviceKey,
            userId: x.userId || String(targetUserForLog?._id || userId),
            userFullName: x.userFullName || [targetUserForLog?.name, targetUserForLog?.lastName].filter(Boolean).join(" ").trim(),
            userEmail: x.userEmail || targetUserForLog?.email || "",
          })),
        },
      });
    }

    const billingSummary = {
      debited: created.filter((x) => x?.manualBillingAction === "debited" || x?.billingAction === "debited").length,
      debt: created.filter((x) => x?.manualBillingAction === "debt" || x?.billingAction === "debt").length,
      skipped: created.filter((x) => ["skipped", "none"].includes(String(x?.manualBillingAction || x?.billingAction || ""))).length,
    };

    return res.status(201).json({
      ok: true,
      items: created,
      createdCount: created.length,
      conflictsCount: conflicts.length,
      billingSummary,
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
        error: "Solo staff, profesor o admin pueden crear o actualizar turnos fijos.",
      });
    }

    const userId = String(req.body?.userId || "").trim();
    const service = String(req.body?.service || "").trim();
    const serviceKey = String(req.body?.serviceKey || "").trim();
    const fixedScheduleId = String(req.body?.fixedScheduleId || "").trim();
    const notes = String(req.body?.notes || "").trim();
    const months = Math.max(1, Math.min(12, Number(req.body?.months || 1)));
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const assignmentMoment = new Date();

    if (!userId) return res.status(400).json({ error: "Falta userId." });
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: "userId inválido." });
    }

    const serviceIdentity = normalizeServiceIdentity({ service, serviceKey });
    if (!serviceIdentity?.serviceKey) return res.status(400).json({ error: "Falta service." });
    if (!items.length) return res.status(400).json({ error: "Faltan días fijos." });

    const cleanItems = items
      .map((it) => ({
        weekday: Number(it?.weekday || 0),
        time: String(it?.time || "").slice(0, 5),
      }))
      .filter((it) => it.weekday >= 1 && it.weekday <= 6 && !!it.time)
      .sort((a, b) => a.weekday - b.weekday);

    if (!cleanItems.length) {
      return res.status(400).json({ error: "No hay items válidos para guardar." });
    }

    const seenWeekdays = new Set();
    for (const it of cleanItems) {
      if (seenWeekdays.has(it.weekday)) {
        return res.status(400).json({
          error: "Para turnos fijos solo puede haber un horario por día de la semana.",
        });
      }
      seenWeekdays.add(it.weekday);
    }

    const startDate = ymdAR(assignmentMoment);
    const endDate = addMonthsYmd(startDate, months);

    let fixed = null;

    if (fixedScheduleId && mongoose.Types.ObjectId.isValid(fixedScheduleId)) {
      fixed = await FixedSchedule.findOne({
        _id: fixedScheduleId,
        user: userId,
        serviceKey: serviceIdentity.serviceKey,
      });
    }

    if (!fixed) {
      fixed = await FixedSchedule.findOne({
        user: userId,
        serviceKey: serviceIdentity.serviceKey,
        active: true,
      }).sort({ createdAt: -1 });
    }

    const updated = !!fixed;
    let cancelledOldCount = 0;
    const cancelledOldFinancialResults = [];

    if (fixed) {
      const oldAppointmentsToCancel = await Appointment.find({
        fixedScheduleId: fixed._id,
        status: "reserved",
        date: { $gte: startDate },
      }).sort({ date: 1, time: 1 });

      // Al actualizar/reasignar un plan fijo, los turnos viejos que quedan por delante
      // también deben revertir su impacto financiero. Antes se cancelaban sin devolver
      // crédito ni liberar/compensar deuda, por eso algunos EP quedaban consumidos.
      let currentUserForOldCancellations = await User.findById(userId);
      if (!currentUserForOldCancellations) {
        return res.status(404).json({ error: "Usuario no encontrado." });
      }

      for (const oldAp of oldAppointmentsToCancel) {
        if (!isSlotStrictlyAfterMoment(oldAp.date, oldAp.time, assignmentMoment)) continue;

        const financial = await reverseFixedAppointmentBillingForPlanDelete({
          user: currentUserForOldCancellations,
          appointment: oldAp,
          req,
        });

        if (financial?.user) currentUserForOldCancellations = financial.user;

        cancelledOldFinancialResults.push({
          appointmentId: String(oldAp._id),
          date: oldAp.date,
          time: oldAp.time,
          service: oldAp.service,
          serviceKey: serviceToKey(oldAp.serviceKey || oldAp.service || ""),
          changed: !!financial.changed,
          refundApplied: !!financial.refundApplied,
          refundMode: financial.refundMode || "none",
          refundReason: financial.refundReason || "",
          amount: Number(financial.amount || 0),
        });

        oldAp.status = "cancelled";
        oldAp.cancelledAt = new Date();
        oldAp.cancelledByRole = role || "admin";
        oldAp.cancelledByUser = req.user?._id || req.user?.id || null;
        oldAp.cancelReason = financial?.refundReason || "FIXED_SCHEDULE_UPDATED";
        oldAp.refundApplied = !!financial?.refundApplied;
        oldAp.refundMode = financial?.refundMode || "none";
        await oldAp.save();
        cancelledOldCount += 1;
      }

      fixed.serviceKey = serviceIdentity.serviceKey;
      fixed.service = serviceIdentity.serviceName;
      fixed.items = cleanItems;
      fixed.months = months;
      fixed.startDate = fixed.startDate || startDate;
      fixed.endDate = endDate;
      fixed.notes = notes;
      fixed.active = true;
      fixed.updatedBy = req.user?._id || req.user?.id || null;
      fixed.updatedAt = new Date();
      await fixed.save();
    } else {
      fixed = await FixedSchedule.create({
        user: userId,
        createdBy: req.user?._id || req.user?.id,
        serviceKey: serviceIdentity.serviceKey,
        service: serviceIdentity.serviceName,
        items: cleanItems,
        months,
        startDate,
        endDate,
        notes,
        active: true,
      });
    }

    const currentMonthRange = getCurrentMonthRangeYmd(assignmentMoment);
    const occurrences = buildOccurrencesForFixedSchedule({
      startDate,
      months,
      items: cleanItems,
    }).filter((occ) =>
      isYmdInsideRange(occ.date, currentMonthRange.startYmd, currentMonthRange.endYmd) &&
      isSlotStrictlyAfterMoment(occ.date, occ.time, assignmentMoment)
    );

    const created = [];
    const conflicts = [];
    const billingResults = [];

    for (const occ of occurrences) {
      try {
        const existingSameFixed = await Appointment.findOne({
          user: userId,
          fixedScheduleId: fixed._id,
          date: occ.date,
          time: occ.time,
          status: "reserved",
        }).lean();

        if (existingSameFixed) continue;

        const ap = await createAppointmentForTargetUser({
          userId,
          actorReq: req,
          date: occ.date,
          time: occ.time,
          service: serviceIdentity.serviceName,
          serviceKey: serviceIdentity.serviceKey,
          notes,
          bypassWindow: true,
          bypassCredits: true,
          bypassScheduleBlocks: true,
          fixedScheduleId: fixed._id,
          skipActivityLog: true,
        });
        created.push(ap);

        const apDoc = ap?.id ? await Appointment.findById(ap.id) : null;
        if (apDoc) {
          const billing = await applyFixedAppointmentMonthlyBilling({
            appointment: apDoc,
            actorReq: req,
          });
          billingResults.push(billing);
        }
      } catch (e) {
        conflicts.push({
          date: occ.date,
          time: occ.time,
          service: serviceIdentity.serviceName,
          serviceKey: serviceIdentity.serviceKey,
          error: e?.message || "No se pudo crear.",
        });
      }
    }

    if (created.length || cancelledOldCount) {
      const targetUserForLog = await User.findById(userId)
        .select("name lastName email role")
        .lean()
        .catch(() => null);

      await logActivity({
        req,
        category: "appointments",
        action: "fixed_schedule_assigned_by_admin",
        entity: "fixedSchedule",
        entityId: String(fixed._id),
        title: "Turnos fijos asignados por admin",
        description: `Se ${updated ? "actualizó" : "asignó"} un plan de turnos fijos con ${created.length} turno(s) del mes actual.`,
        subject: buildUserSubject(targetUserForLog || { _id: userId }),
        meta: {
          fixedScheduleId: String(fixed._id),
          updated,
          service: serviceIdentity.serviceName,
          serviceKey: serviceIdentity.serviceKey,
          months,
          currentMonthKey: currentMonthRange.monthKey,
          generatedFrom: currentMonthRange.startYmd,
          generatedTo: currentMonthRange.endYmd,
          createdCount: created.length,
          cancelledOldCount,
          conflictsCount: conflicts.length,
          billingSummary: {
            debited: billingResults.filter((x) => x?.action === "debited").length,
            debt: billingResults.filter((x) => x?.action === "debt").length,
            skipped: billingResults.filter((x) => x?.skipped).length,
            oldRefunded: cancelledOldFinancialResults.filter((x) => x?.refundMode === "fixed-plan-delete-refund").length,
            oldDebtSettled: cancelledOldFinancialResults.filter((x) => x?.refundMode === "fixed-debt-settlement").length,
            oldDebtReleased: cancelledOldFinancialResults.filter((x) => x?.refundMode === "fixed-debt-release").length,
          },
          cancelledOldFinancialResults,
          user: {
            id: String(targetUserForLog?._id || userId),
            name: [targetUserForLog?.name, targetUserForLog?.lastName].filter(Boolean).join(" ").trim(),
            email: targetUserForLog?.email || "",
          },
          fixedItems: cleanItems,
          items: created.map((x) => ({
            id: x.id,
            date: x.date,
            time: x.time,
            service: x.service,
            serviceKey: x.serviceKey,
            userId: x.userId || String(targetUserForLog?._id || userId),
            userFullName: x.userFullName || [targetUserForLog?.name, targetUserForLog?.lastName].filter(Boolean).join(" ").trim(),
            userEmail: x.userEmail || targetUserForLog?.email || "",
          })),
        },
      });
    }

    return res.status(updated ? 200 : 201).json({
      ok: true,
      updated,
      fixedScheduleId: String(fixed._id),
      cancelledOldCount,
      createdCount: created.length,
      conflictsCount: conflicts.length,
      generatedMonthKey: currentMonthRange.monthKey,
      generatedFrom: currentMonthRange.startYmd,
      generatedTo: currentMonthRange.endYmd,
      billingResults,
      billingSummary: {
        debited: billingResults.filter((x) => x?.action === "debited").length,
        debt: billingResults.filter((x) => x?.action === "debt").length,
        skipped: billingResults.filter((x) => x?.skipped).length,
      },
      items: created,
      conflicts,
      fixedSchedule: {
        id: String(fixed._id),
        user: String(fixed.user),
        service: fixed.service || serviceIdentity.serviceName,
        serviceKey: fixed.serviceKey || serviceIdentity.serviceKey,
        items: fixed.items || cleanItems,
        months: Number(fixed.months || months),
        startDate: fixed.startDate || startDate,
        endDate: fixed.endDate || endDate,
        notes: fixed.notes || "",
        active: !!fixed.active,
      },
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
    const { date, time, service, serviceKey, notes = "" } = req.body || {};
    const basic = validateBasicSlotRules({ date, time, service, serviceKey });
    if (!basic.ok) return res.status(400).json({ error: basic.error });

    const userId = req.user._id || req.user.id;
    let out = null;

    await session.withTransaction(async () => {
      let user = await User.findById(userId).session(session);
      if (!user) throw new Error("USER_NOT_FOUND");

      user = (await syncPastAppointmentsForUserId(userId, session)) || user;

      if (user.suspended) throw new Error("USER_SUSPENDED");
      if (requiresApto(user)) throw new Error("APTO_REQUIRED");
      // La primera evaluación ya no bloquea la reserva de otros servicios.

      recalcUserCredits(user);

      const requestedSk = basic.serviceKey;
      if ((user.credits || 0) <= 0 || getServiceBalance(user, requestedSk, basic.slotDate) <= 0) throw new Error("NO_CREDITS");

      if (!hasValidCreditsForServiceAndSlot(user, requestedSk, basic.slotDate)) {
        throw new Error(`NO_CREDITS_FOR_SLOT_${requestedSk}`);
      }

      const t = String(time).slice(0, 5);

      await assertSlotNotBlocked({
        date,
        time: t,
        serviceKey: basic.serviceKey,
        session,
      });

      const alreadyByUser = await Appointment.findOne(
        buildReservedSlotQuery(date, t, { user: user._id })
      ).session(session).lean();

      if (alreadyByUser) throw new Error("ALREADY_HAVE_SLOT");

      const existingAtSlot = await Appointment.find(
        buildReservedSlotQuery(date, t)
      ).session(session).lean();

      let willWaitlist = false;
      const stats = getSlotReservationStats(existingAtSlot, date, t);

      if (basic.isEpService) {
        if (stats.epReserved >= stats.epCap) {
          willWaitlist = true;
        }
      } else if (isTherapyService(requestedSk)) {
        if (stats.therapyReserved >= stats.therapyCap) {
          willWaitlist = true;
        }
      } else if (requestedSk === "NUT") {
        if (stats.nutReserved >= stats.nutCap) {
          throw new Error("SERVICE_CAP_REACHED");
        }
      }

      if (willWaitlist && isWaitlistableService(requestedSk)) {
        const wlWindow = validateWaitlistOpen(basic.slotDate, requestedSk);
        if (!wlWindow.ok) throw new Error("WAITLIST_CLOSED");

        const queueMatch = buildWaitlistQueueMatch(requestedSk);

        const wlExists = await WaitlistEntry.findOne({
          user: user._id,
          date,
          time: t,
          ...queueMatch,
          status: { $in: ACTIVE_WAITLIST_STATUSES },
        }).session(session);

        if (wlExists) throw new Error("ALREADY_IN_WAITLIST");

        const lastPriority = await WaitlistEntry.findOne({
          date,
          time: t,
          ...queueMatch,
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
            serviceKey: requestedSk,
            service: basic.serviceName,
            status: "waiting",
            notes: String(notes || "").trim(),
            priorityOrder: nextPriority,
            createdByUser: user._id,
            createdByRole: normalizeCreatedByRole(req.user?.role, "client"),
          }],
          { session }
        );

        recalcUserCredits(user);

        out = {
          kind: "waitlist",
          id: String(createdWaitlist._id),
          date,
          time: t,
          service: basic.serviceName,
          serviceKey: requestedSk,
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
        serviceKey: basic.serviceKey,
        serviceName: basic.serviceName,
        historyItem: {
          action: "reservado",
          date,
          time: t,
          service: basic.serviceName,
          serviceName: basic.serviceName,
          serviceKey: basic.serviceKey,
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
          service: basic.serviceName,
          serviceKey: basic.serviceKey,
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
      mailAp = { date, time: t, service: basic.serviceName };
      mailServiceName = basic.serviceName;
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
          await sendBookedMailRespectingActor({
            req,
            user: mailUser,
            ap: mailAp,
            serviceName: mailServiceName,
          });
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
    if (msg.startsWith("SCHEDULE_BLOCKED:")) {
      return res.status(409).json({
        error: msg.replace("SCHEDULE_BLOCKED:", "") || "Agenda bloqueada para ese horario.",
      });
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
        const serviceKey = String(it?.serviceKey || "").trim();

        const basic = validateBasicSlotRules({ date, time, service, serviceKey });
        if (!basic.ok) {
          const e = new Error(basic.error);
          e.http = 400;
          throw e;
        }

        return {
          date,
          time,
          service: basic.serviceName,
          serviceKey: basic.serviceKey,
          ...basic,
        };
      });

      // La primera evaluación ya no bloquea reservas múltiples de otros servicios.

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
        const requestedSk = it.serviceKey;
        if (!hasValidCreditsForServiceAndSlot(user, requestedSk, it.slotDate)) {
          throw new Error(`NO_CREDITS_FOR_SLOT_${requestedSk}`);
        }

        await assertSlotNotBlocked({
          date: it.date,
          time: it.time,
          serviceKey: requestedSk,
          session,
        });

        const alreadyByUser = await Appointment.findOne(
          buildReservedSlotQuery(it.date, it.time, { user: user._id })
        ).session(session).lean();

        if (alreadyByUser) throw new Error("ALREADY_HAVE_SLOT");

        const existingAtSlot = await Appointment.find(
          buildReservedSlotQuery(it.date, it.time)
        ).session(session).lean();

        const stats = getSlotReservationStats(existingAtSlot, it.date, it.time);

        if (it.isEpService) {
          if (stats.epReserved >= stats.epCap) {
            throw new Error("SERVICE_CAP_REACHED");
          }
        } else if (isTherapyService(requestedSk)) {
          if (stats.therapyReserved >= stats.therapyCap) {
            throw new Error("SERVICE_CAP_REACHED");
          }
        } else if (requestedSk === "NUT") {
          if (stats.nutReserved >= stats.nutCap) {
            throw new Error("SERVICE_CAP_REACHED");
          }
        }
      }

      for (const it of basicItems) {
        const consumed = await consumeCreditAtomic({
          userId: user._id,
          serviceKey: it.serviceKey,
          serviceName: it.service,
          historyItem: {
            action: "reservado",
            date: it.date,
            time: it.time,
            service: it.service,
            serviceName: it.service,
            serviceKey: it.serviceKey,
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
            serviceKey: it.serviceKey,
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
          await sendBookedBatchMailRespectingActor({
            req,
            user: mailUser,
            items: mailItems,
          });
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
    if (msg.startsWith("SCHEDULE_BLOCKED:")) {
      return res.status(409).json({
        error: msg.replace("SCHEDULE_BLOCKED:", "") || "Agenda bloqueada para ese horario.",
      });
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
   POST /appointments/admin/cancel/:id
   Cancelación administrativa sin afectar políticas
========================= */
router.post("/admin/cancel/:id", ensureStaff, async (req, res) => {
  const session = await mongoose.startSession();

  let mailUser = null;
  let mailAp = null;
  let responsePayload = null;

  try {
    const appointmentId = String(req.params?.id || "").trim();
    const mode = String(req.body?.mode || "admin_no_policy").toLowerCase().trim();

    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return res.status(400).json({ error: "ID de turno inválido." });
    }

    if (!["admin_no_policy", "no_policy", "sin_politica", "sin_termino"].includes(mode)) {
      return res.status(400).json({ error: "Modo de cancelación inválido." });
    }

    const tokenUserId = req.user?._id || req.user?.id;
    const role = String(req.user?.role || "admin").toLowerCase();

    await session.withTransaction(async () => {
      const ap = await Appointment.findById(appointmentId).session(session);
      if (!ap) throw new Error("APPOINTMENT_NOT_FOUND");

      if (String(ap.status || "") !== "reserved") {
        throw new Error("APPOINTMENT_NOT_RESERVED");
      }

      const user = await User.findById(ap.user).session(session);
      if (!user) throw new Error("USER_NOT_FOUND");

      const historyItem = {
        action: "cancelado_por_admin_sin_politica",
        title: "Cancelación administrativa sin política",
        message: "Cancelado por administración. No afecta políticas de cancelación del usuario.",
        date: ap.date,
        time: ap.time,
        service: ap.service,
        serviceName: ap.service,
        serviceKey: serviceToKey(ap.service),
      };

      let updatedUser = user;
      let refundApplied = false;
      let refundMode = "none";
      let refundReason = "ADMIN_NO_POLICY";

      if (ap.creditLotId) {
        const debtSettlement = await settleFixedScheduleDebtWithCancelledCreditOnCancel({
          user: updatedUser,
          appointment: ap,
          historyItem: {
            ...historyItem,
            action: "debt_settled_by_admin_cancelled_credit",
            title: "Deuda compensada por cancelación administrativa",
            message:
              "Se canceló administrativamente un turno ya debitado. Como existía deuda del mismo servicio, se compensó la deuda pendiente.",
          },
          session,
        });

        if (debtSettlement.settled) {
          updatedUser = debtSettlement.user;
          refundApplied = true;
          refundMode = "admin-debt-settlement";
          refundReason = "ADMIN_DEBT_SETTLEMENT";
        } else {
          updatedUser = await refundCreditAtomicToOriginalLotOrNewLot({
            userId: user._id,
            lotId: ap.creditLotId,
            apService: ap.service,
            historyItem,
            session,
          });
          refundApplied = true;
          refundMode = "admin-no-policy";
        }
      } else if (isUnpaidDebtAppointment(ap)) {
        const debtRelease = await releaseFixedAppointmentDebtOnCancel({
          user: updatedUser,
          appointment: ap,
          historyItem: {
            ...historyItem,
            action: "manual_or_fixed_debt_released_by_admin_cancel",
            title: "Deuda liberada por cancelación administrativa",
            message: "Se canceló administrativamente un turno marcado como deuda. Se bajó la deuda pendiente del servicio.",
          },
          session,
        });

        updatedUser = user;
        refundApplied = !!debtRelease.released;
        refundMode = debtRelease.released ? "admin-debt-release" : "none";
        refundReason = debtRelease.released ? "ADMIN_DEBT_RELEASE" : refundReason;
      } else if (isSettledDebtAppointmentWithoutLot(ap)) {
        const refunded = await refundCreditAtomicNewLot({
          userId: user._id,
          apService: ap.service,
          historyItem: {
            ...historyItem,
            action: "settled_debt_refunded_by_admin_cancel",
            title: "Crédito devuelto por cancelación administrativa",
            message: "El turno había nacido como deuda y luego fue saldado. Al cancelarlo administrativamente, se generó un crédito de reintegro.",
          },
          session,
        });
        updatedUser = refunded.user;
        refundApplied = true;
        refundMode = "admin-settled-debt-refund";
        refundReason = "ADMIN_SETTLED_DEBT_REFUND";
      } else if (!ap.assignedManually && !ap.fixedScheduleId) {
        const refunded = await refundCreditAtomicNewLot({
          userId: user._id,
          apService: ap.service,
          historyItem,
          session,
        });
        updatedUser = refunded.user;
        refundApplied = true;
        refundMode = "admin-no-policy-new-lot";
      } else {
        updatedUser.history = Array.isArray(updatedUser.history) ? updatedUser.history : [];
        updatedUser.history.push({
          ...historyItem,
          createdAt: new Date(),
        });
        recalcUserCredits(updatedUser);
        await updatedUser.save({ session });
      }

      ap.status = "cancelled";
      ap.cancelledAt = new Date();
      ap.cancelledByRole = role || "admin";
      ap.cancelledByUser = tokenUserId || null;
      ap.cancelReason = refundReason;
      ap.refundApplied = refundApplied;
      ap.refundMode = refundMode;
      await ap.save({ session });

      responsePayload = {
        ok: true,
        id: String(ap._id),
        adminNoPolicy: true,
        refundApplied,
        refundMode,
        refundReason,
        cancelReason: refundReason,
        cancellationMessage: refundApplied
          ? "Cancelación administrativa realizada sin afectar políticas. Se devolvió el crédito."
          : "Cancelación administrativa realizada sin afectar políticas.",
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
        refund: refundApplied,
        refundApplied,
        refundMode,
        refundCutoffHours: 0,
        cancelReason: refundReason,
      };
    });

    await logActivity({
      req,
      category: "appointments",
      action: "appointment_cancelled_admin_no_policy",
      entity: "appointment",
      entityId: appointmentId,
      title: "Turno cancelado sin política",
      description: "Se canceló un turno desde administración sin afectar las políticas de cancelación del usuario.",
      subject: buildUserSubject(mailUser || req.user),
      meta: {
        refundApplied: !!responsePayload?.refundApplied,
        refundMode: responsePayload?.refundMode || "none",
        adminNoPolicy: true,
      },
    });

    res.json(responsePayload);

    if (mailUser && mailAp) {
      fireAndForget(async () => {
        try {
          await sendCancelledMailRespectingActor({
            req,
            user: mailUser,
            ap: mailAp,
          });
        } catch (e) {
          console.log("[MAIL] admin no-policy cancelled error:", e?.message || e);
          await sendAdminCopy({ kind: "cancelled_admin_no_policy", user: mailUser, ap: mailAp });
        }
      }, "MAIL_CANCELLED_ADMIN_NO_POLICY");
    }
  } catch (err) {
    console.error("Error en POST /appointments/admin/cancel/:id:", err);
    const msg = String(err?.message || "");

    if (msg === "APPOINTMENT_NOT_FOUND") {
      return res.status(404).json({ error: "Turno no encontrado." });
    }
    if (msg === "APPOINTMENT_NOT_RESERVED") {
      return res.status(409).json({ error: "El turno ya no está reservado." });
    }
    if (msg === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }
    if (msg === "REFUND_FAILED") {
      return res.status(500).json({ error: "No se pudo devolver el crédito al lote original." });
    }
    if (msg === "ORIGINAL_LOT_ALREADY_FULL_ON_REFUND") {
      return res.status(409).json({
        error: "El lote original ya estaba completo. No se canceló el turno para evitar duplicar créditos.",
      });
    }

    return res.status(500).json({ error: "No se pudo cancelar el turno sin política." });
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
    const appointmentId = String(req.params?.id || "").trim();

    console.log("[DELETE APPOINTMENT HIT]", {
      appointmentId,
      userId: String(req.user?._id || req.user?.id || ""),
      role: String(req.user?.role || ""),
    });

    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return res.status(400).json({
        error: "ID de turno inválido. No se puede cancelar un preview de turno fijo.",
      });
    }

    const tokenUserId = req.user?._id || req.user?.id;
    const role = String(req.user?.role || "").toLowerCase();

    await session.withTransaction(async () => {
      const ap = await Appointment.findById(appointmentId).session(session);
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
      const cancelPolicy = getCancellationPolicyForService(ap.service);
      const minCancelHours = Number(cancelPolicy?.refundCutoffHours || 0);

      if (!isStaff && (!Number.isFinite(hoursToStart) || hoursToStart < minCancelHours)) {
        throw new Error("CANCELLATION_WINDOW_CLOSED");
      }

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
        if (!ap.creditLotId && (isUnpaidDebtAppointment(ap) || isSettledDebtAppointmentWithoutLot(ap))) {
          const debtRelease = await releaseFixedAppointmentDebtOnCancel({
            user: updatedUser,
            appointment: ap,
            historyItem: {
              action: "appointment_debt_released_by_cancel",
              title: "Deuda de turno manual/fijo liberada",
              message: "Se canceló un turno manual/fijo que estaba marcado como deuda. Se bajó la deuda antes de generar crédito positivo.",
              date: ap.date,
              time: ap.time,
              service: ap.service,
              serviceName: ap.service,
              ...historyMeta,
            },
            session,
          });

          if (debtRelease.released) {
            decision.refund = true;
            decision.refundMode = "debt-release";
            decision.reason = "APPOINTMENT_DEBT_RELEASED_BY_CANCEL";
            updatedUser = user;
          } else if (isSettledDebtAppointmentWithoutLot(ap)) {
            // Caso especial:
            // El turno fijo había nacido como deuda, pero luego el admin agregó
            // créditos y esa deuda se saldó. En ese momento el turno queda
            // marcado como monthly_reserved sin creditLotId. Si el usuario lo
            // cancela dentro de política, corresponde generar un crédito de
            // reintegro nuevo, no dejarlo sin devolución.
            const refunded = await refundCreditAtomicNewLot({
              userId: user._id,
              apService: ap.service,
              historyItem: {
                action: decision.historyAction,
                title: "Crédito devuelto por cancelación de turno manual/fijo saldado",
                message:
                  "Se canceló un turno manual/fijo cuya deuda ya había sido saldada con créditos cargados por el admin. Se generó un crédito de reintegro.",
                date: ap.date,
                time: ap.time,
                service: ap.service,
                serviceName: ap.service,
                ...historyMeta,
              },
              session,
            });

            updatedUser = refunded.user;
            decision.refund = true;
            decision.refundMode = "fixed-settled-debt-refund";
            decision.reason = "FIXED_SCHEDULE_SETTLED_DEBT_REFUNDED_BY_CANCEL";
          } else {
            decision.refund = false;
            decision.refundMode = "none";
            decision.reason = "Turno manual/fijo sin crédito consumido: no corresponde reintegro automático.";
          }
        } else if (ap.creditLotId) {
          const fixedDebtSettlement = await settleFixedScheduleDebtWithCancelledCreditOnCancel({
            user: updatedUser,
            appointment: ap,
            historyItem: {
              action: "fixed_schedule_debt_settled_by_cancelled_credit",
              title: "Deuda de turno fijo compensada",
              message:
                "Se canceló un turno fijo ya debitado. Como existía deuda del mismo servicio, no se generó crédito positivo: se compensó la deuda pendiente.",
              date: ap.date,
              time: ap.time,
              service: ap.service,
              serviceName: ap.service,
              ...historyMeta,
            },
            session,
          });

          if (fixedDebtSettlement.settled) {
            updatedUser = fixedDebtSettlement.user;
            decision.refund = true;
            decision.refundMode = "fixed-debt-settlement";
            decision.reason = "FIXED_SCHEDULE_DEBT_SETTLED_BY_CANCEL";
          } else {
            updatedUser = await refundCreditAtomicToOriginalLotOrNewLot({
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
          }
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
      entityId: String(appointmentId),
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
          await sendCancelledMailRespectingActor({
            req,
            user: mailUser,
            ap: mailAp,
          });
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
    if (msg === "CANCELLATION_WINDOW_CLOSED") {
      return res.status(409).json({
        error: "El turno ya no se puede cancelar desde el panel porque no cumple con la anticipación mínima del servicio.",
      });
    }
    if (msg === "REFUND_FAILED") {
      return res.status(500).json({ error: "No se pudo devolver el crédito al lote original." });
    }
    if (msg === "ORIGINAL_LOT_ALREADY_FULL_ON_REFUND") {
      return res.status(409).json({
        error: "El lote original ya estaba completo. No se canceló el turno para evitar duplicar créditos.",
      });
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
        serviceKey: entry.serviceKey || "EP",
        notes: entry.notes || "",
        bypassWindow: true,
      });

      entry.status = "claimed";
      entry.claimedAt = new Date();
      entry.claimedBy = req.user?._id || req.user?.id || null;
      entry.assignedAppointmentId = createdAppointment?.id || null;
      entry.notifyToken = null;
      entry.tokenExpiresAt = null;
      entry.closeReason = "CLAIMED_BY_STAFF";
      await entry.save({ session });

      // La sala de espera queda bajo gestión manual del admin.
      // No cerramos automáticamente el resto de la cola: puede quedar cupo
      // disponible para más de una persona o para otro servicio del pool RA/RF/KD/SYN.
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
    if (msg.startsWith("SCHEDULE_BLOCKED:")) {
      return res.status(409).json({
        error: msg.replace("SCHEDULE_BLOCKED:", "") || "Agenda bloqueada para ese horario.",
      });
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
router.get("/admin/fixed-schedules", ensureStaff, async (req, res) => {
  try {
    const userId = String(req.query?.userId || "").trim();
    const activeParam = String(req.query?.active ?? "1").trim();

    const q = {};

    if (activeParam !== "all") {
      q.active = activeParam === "0" || activeParam === "false" ? false : true;
    }

    if (userId) {
      if (!mongoose.Types.ObjectId.isValid(userId)) {
        return res.status(400).json({ error: "userId inválido." });
      }
      q.user = userId;
    }

    const items = await FixedSchedule.find(q)
      .populate("user", "name lastName email")
      .sort({ serviceKey: 1, createdAt: -1 })
      .lean();

    const today = ymdAR(new Date());

    async function deriveFixedItemsFromAppointments(schedule) {
      const rawItems = Array.isArray(schedule?.items) ? schedule.items : [];
      const cleanRawItems = rawItems
        .map((x) => ({
          weekday: Number(x?.weekday || 0),
          time: String(x?.time || "").slice(0, 5),
        }))
        .filter((x) => x.weekday >= 1 && x.weekday <= 6 && !!x.time);

      if (cleanRawItems.length) return cleanRawItems;

      // Compatibilidad con turnos fijos viejos: si el FixedSchedule quedó activo
      // pero no tiene items guardados, reconstruimos el patrón desde los turnos
      // futuros reservados asociados al fixedScheduleId.
      const fixedId = schedule?._id;
      if (!fixedId) return [];

      const aps = await Appointment.find({
        fixedScheduleId: fixedId,
        status: "reserved",
        date: { $gte: today },
      })
        .select("date time")
        .sort({ date: 1, time: 1 })
        .lean();

      const byWeekday = new Map();
      for (const ap of aps || []) {
        const day = String(ap?.date || "").slice(0, 10);
        const time = String(ap?.time || "").slice(0, 5);
        if (!day || !time) continue;
        const weekday = getWeekdayMondayFirst(day);
        if (weekday < 1 || weekday > 6) continue;
        if (!byWeekday.has(weekday)) byWeekday.set(weekday, time);
      }

      return [...byWeekday.entries()]
        .map(([weekday, time]) => ({ weekday, time }))
        .sort((a, b) => a.weekday - b.weekday);
    }

    const payload = [];
    for (const it of items) {
      const normalizedItems = await deriveFixedItemsFromAppointments(it);
      payload.push({
        id: String(it._id),
        user: it.user
          ? {
              _id: String(it.user._id || it.user),
              name: it.user.name || "",
              lastName: it.user.lastName || "",
              email: it.user.email || "",
            }
          : null,
        service: it.service || "",
        serviceKey: String(it.serviceKey || "").toUpperCase().trim(),
        items: normalizedItems,
        months: Number(it.months || 1),
        startDate: it.startDate || null,
        endDate: it.endDate || null,
        notes: it.notes || "",
        active: !!it.active,
        createdAt: it.createdAt || null,
        updatedAt: it.updatedAt || null,
      });
    }

    return res.json(payload);
  } catch (err) {
    console.error("Error en GET /appointments/admin/fixed-schedules:", err);
    return res.status(500).json({ error: "No se pudieron cargar los turnos fijos." });
  }
});

/* =========================
   DELETE /appointments/admin/fixed-schedules/:id
========================= */
router.delete("/admin/fixed-schedules/:id", ensureStaff, async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const scheduleId = String(req.params?.id || "").trim();

    if (!mongoose.Types.ObjectId.isValid(scheduleId)) {
      return res.status(400).json({ error: "ID de turno fijo inválido." });
    }

    const role = String(req.user?.role || "admin").toLowerCase();
    const actorId = req.user?._id || req.user?.id || null;
    const deletionMoment = new Date();
    const today = ymdAR(deletionMoment);

    let responsePayload = null;
    let activityMeta = null;
    let activitySubject = null;

    await session.withTransaction(async () => {
      const schedule = await FixedSchedule.findById(scheduleId).session(session);
      if (!schedule) {
        throw new Error("FIXED_SCHEDULE_NOT_FOUND");
      }

      const targetUser = await User.findById(schedule.user).session(session);
      if (!targetUser) {
        throw new Error("USER_NOT_FOUND");
      }

      const appointmentsToCancelRaw = await Appointment.find({
        fixedScheduleId: schedule._id,
        status: "reserved",
        date: { $gte: today },
      })
        .sort({ date: 1, time: 1 })
        .session(session);

      const appointmentsToCancel = appointmentsToCancelRaw.filter((ap) =>
        isSlotStrictlyAfterMoment(ap.date, ap.time, deletionMoment)
      );

      let currentUser = targetUser;
      const cancelledItems = [];
      const financialResults = [];

      for (const ap of appointmentsToCancel) {
        const financial = await reverseFixedAppointmentBillingForPlanDelete({
          user: currentUser,
          appointment: ap,
          req,
          session,
        });

        if (financial.user) currentUser = financial.user;
        financialResults.push({
          appointmentId: String(ap._id),
          date: ap.date,
          time: ap.time,
          service: ap.service,
          serviceKey: serviceToKey(ap.serviceKey || ap.service || ""),
          changed: !!financial.changed,
          refundApplied: !!financial.refundApplied,
          refundMode: financial.refundMode || "none",
          refundReason: financial.refundReason || "",
          amount: Number(financial.amount || 0),
        });

        ap.status = "cancelled";
        ap.cancelledAt = new Date();
        ap.cancelledByRole = role || "admin";
        ap.cancelledByUser = actorId;
        ap.cancelReason = financial.refundReason || "FIXED_SCHEDULE_DELETED";
        ap.refundApplied = !!financial.refundApplied;
        ap.refundMode = financial.refundMode || "none";
        await ap.save({ session });

        cancelledItems.push({
          id: String(ap._id),
          date: ap.date,
          time: ap.time,
          service: ap.service,
          serviceKey: serviceToKey(ap.serviceKey || ap.service || ""),
          refundApplied: !!financial.refundApplied,
          refundMode: financial.refundMode || "none",
          refundReason: financial.refundReason || "",
        });
      }

      // No vaciamos schedule.items: el schema exige al menos un ítem.
      // Vaciarlo hacía fallar la validación y devolvía 500 al borrar turnos fijos.
      schedule.active = false;
      schedule.deactivatedAt = new Date();
      schedule.deactivatedBy = actorId;
      await schedule.save({ session });

      const finalUser = await User.findById(schedule.user).session(session);
      if (finalUser) {
        recalcUserCredits(finalUser);
        await finalUser.save({ session });
        currentUser = finalUser;
      }

      const refundCount = financialResults.filter((x) => x.refundMode === "fixed-plan-delete-refund").length;
      const debtSettledCount = financialResults.filter((x) => x.refundMode === "fixed-debt-settlement").length;
      const debtReleasedCount = financialResults.filter((x) => x.refundMode === "fixed-debt-release").length;
      const noFinancialImpactCount = financialResults.filter((x) => !x.changed).length;

      activitySubject = currentUser;
      activityMeta = {
        fixedScheduleId: String(schedule._id),
        service: schedule.service || serviceKeyToName(schedule.serviceKey),
        serviceKey: String(schedule.serviceKey || "").toUpperCase().trim(),
        cancelledAppointmentsCount: cancelledItems.length,
        refundCount,
        debtSettledCount,
        debtReleasedCount,
        noFinancialImpactCount,
        userCredits: Number(currentUser?.credits || 0),
        fixedScheduleDebt: currentUser?.fixedScheduleDebt || {},
        items: cancelledItems,
        financialResults,
      };

      responsePayload = {
        ok: true,
        deactivated: true,
        fixedScheduleId: String(schedule._id),
        cancelledAppointmentsCount: cancelledItems.length,
        financialSummary: {
          refundCount,
          debtSettledCount,
          debtReleasedCount,
          noFinancialImpactCount,
        },
        userCredits: Number(currentUser?.credits || 0),
        fixedScheduleDebt: currentUser?.fixedScheduleDebt || {},
        cancelledItems,
      };
    });

    await logActivity({
      req,
      category: "appointments",
      action: "fixed_schedule_deleted_by_admin",
      entity: "fixedSchedule",
      entityId: scheduleId,
      title: "Plan de turnos fijos dado de baja",
      description: "Se dio de baja un plan de turnos fijos y se ajustaron créditos/deuda de sus turnos futuros.",
      subject: buildUserSubject(activitySubject || { _id: "" }),
      meta: activityMeta || {},
    });

    return res.json(responsePayload);
  } catch (err) {
    console.error("Error en DELETE /appointments/admin/fixed-schedules/:id:", err);

    if (String(err?.message || "") === "FIXED_SCHEDULE_NOT_FOUND") {
      return res.status(404).json({ error: "Turno fijo no encontrado." });
    }

    if (String(err?.message || "") === "USER_NOT_FOUND") {
      return res.status(404).json({ error: "Usuario del turno fijo no encontrado." });
    }

    if (String(err?.message || "") === "REFUND_FAILED") {
      return res.status(500).json({ error: "No se pudo devolver el crédito al lote original." });
    }

    if (String(err?.message || "") === "ORIGINAL_LOT_ALREADY_FULL_ON_REFUND") {
      return res.status(409).json({
        error: "El lote original ya estaba completo. No se dio de baja el plan para evitar duplicar créditos.",
      });
    }

    return res.status(500).json({ error: "No se pudo eliminar el turno fijo." });
  } finally {
    await session.endSession();
  }
});

export default router;
