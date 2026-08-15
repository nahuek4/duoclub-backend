// backend/src/jobs/fixedScheduleBilling.js
// Procesamiento de ocurrencias de turnos fijos bajo el modelo de suscripciones.
// IMPORTANTE: fixedScheduleDebt es legado/histórico y nunca se lee ni modifica aquí.

import mongoose from "mongoose";
import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import { getSubscriptionAccessState } from "../services/subscriptions/subscriptionAccess.js";

const TZ = "America/Argentina/Buenos_Aires";
const FIXED_SERVICE_KEYS = ["EP", "RA", "RF", "KD", "SYN"];
const SERVICE_KEY_TO_NAME = {
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
};

let schedulerStarted = false;
let schedulerTimer = null;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function normalizeServiceKey(value) {
  const sk = String(value || "").toUpperCase().trim();
  if (sk === "AR") return "RA";
  if (sk === "KINEDEPO" || sk === "KINE-DEPO") return "KD";
  if (sk === "SYNERGY" || sk === "SINERGIA") return "SYN";
  return FIXED_SERVICE_KEYS.includes(sk) ? sk : "";
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

function hmFromParts(p) {
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

function slotDue(date, time, now = new Date()) {
  const p = arParts(now);
  const today = ymdFromParts(p);
  const currentHm = hmFromParts(p);
  const d = String(date || "").slice(0, 10);
  const t = String(time || "").slice(0, 5);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^\d{2}:\d{2}$/.test(t)) return false;
  if (d < today) return true;
  if (d > today) return false;
  return t <= currentHm;
}

function serviceName(sk) {
  return SERVICE_KEY_TO_NAME[sk] || sk;
}

function activeLots(user, serviceKey) {
  const sk = normalizeServiceKey(serviceKey);
  const now = new Date();

  return (Array.isArray(user?.creditLots) ? user.creditLots : [])
    .filter((lot) => normalizeServiceKey(lot?.serviceKey || lot?.service || lot?.serviceName) === sk)
    .filter((lot) => Math.max(0, Number(lot?.remaining || 0)) > 0)
    .filter((lot) => !lot?.expiresAt || new Date(lot.expiresAt) > now)
    .sort((a, b) => {
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

async function processAppointment(apId, now = new Date()) {
  const session = await mongoose.startSession();

  try {
    let result = null;

    await session.withTransaction(async () => {
      const ap = await Appointment.findOne({
        _id: apId,
        fixedDebitProcessedAt: null,
      }).session(session);

      if (!ap || !ap.fixedScheduleId || !slotDue(ap.date, ap.time, now)) return;

      if (String(ap.status || "") === "cancelled") {
        ap.fixedDebitProcessedAt = now;
        ap.creditDebitStatus = ap.creditDebitStatus || "skipped";
        await ap.save({ session });
        result = { ok: true, skipped: true, reason: "CANCELLED" };
        return;
      }

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

      const subscriptionAccess = await getSubscriptionAccessState({
        userId: user._id,
        serviceKey: sk,
        session,
      });

      if (!subscriptionAccess.allowed) {
        ap.status = "cancelled";
        ap.cancelledAt = now;
        ap.cancelReason =
          subscriptionAccess.subscription?.status === "suspended"
            ? "Servicio suspendido por pago mensual pendiente."
            : "Servicio no disponible por estado de la suscripción.";
        ap.creditDebitStatus = "skipped";
        ap.fixedDebtAmount = 0;
        ap.fixedDebitProcessedAt = now;
        await ap.save({ session });

        result = {
          ok: true,
          status: "subscription_blocked",
          serviceKey: sk,
          subscriptionStatus: subscriptionAccess.subscription?.status || "",
        };
        return;
      }

      user.history = Array.isArray(user.history) ? user.history : [];
      const billingStatus = String(ap.creditDebitStatus || "").trim();

      // Ya estaba cubierto por un débito previo. Solo completamos la ocurrencia.
      if (ap.creditLotId || ["monthly_reserved", "debited"].includes(billingStatus)) {
        ap.status = "completed";
        ap.completedAt = ap.completedAt || now;
        ap.fixedDebitProcessedAt = now;
        ap.fixedDebtAmount = 0;
        await ap.save({ session });
        result = { ok: true, status: "already_covered", serviceKey: sk };
        return;
      }

      // Un marcador legacy "debt" NO se cobra ni se compensa. Se conserva el
      // dato histórico del appointment y solo cerramos la ocurrencia.
      if (billingStatus === "debt" || Number(ap.fixedDebtAmount || 0) > 0) {
        ap.status = "completed";
        ap.completedAt = ap.completedAt || now;
        ap.fixedDebitProcessedAt = now;
        await ap.save({ session });
        result = { ok: true, status: "legacy_debt_ignored", serviceKey: sk };
        return;
      }

      const lot = activeLots(user, sk)[0] || null;

      if (lot) {
        lot.remaining = Math.max(0, Number(lot.remaining || 0) - 1);
        ap.creditLotId = lot._id || null;
        ap.creditExpiresAt = lot.expiresAt || null;
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
        // Sin crédito: queda pendiente de cobertura. La diferencia se gestiona
        // mediante SubscriptionExtraSessionNotice; jamás mediante deuda.
        ap.creditDebitStatus = "pending";
        ap.creditDebitedAt = null;
        ap.fixedDebtAmount = 0;

        user.history.push({
          action: "fixed_schedule_pending_coverage",
          title: `Turno fijo pendiente de cobertura ${sk}`,
          message: `El turno fijo de ${serviceName(sk)} (${ap.date} ${ap.time} hs) se procesó sin generar deuda.`,
          date: ap.date,
          time: ap.time,
          serviceKey: sk,
          serviceName: serviceName(sk),
          service: serviceName(sk),
          qty: 0,
          createdAt: now,
        });

        result = { ok: true, status: "pending", serviceKey: sk };
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
  const today = ymdFromParts(arParts(now));

  const candidates = await Appointment.find({
    fixedScheduleId: { $ne: null },
    fixedDebitProcessedAt: null,
    status: { $in: ["reserved", "completed", "cancelled"] },
    date: { $lte: today },
  })
    .sort({ date: 1, time: 1 })
    .limit(limit)
    .select("_id date time status")
    .lean();

  const counters = {
    checked: 0,
    debited: 0,
    pending: 0,
    alreadyCovered: 0,
    legacyIgnored: 0,
    subscriptionBlocked: 0,
    skipped: 0,
  };

  for (const ap of candidates) {
    if (!slotDue(ap.date, ap.time, now)) continue;
    counters.checked += 1;

    try {
      const result = await processAppointment(ap._id, now);
      if (result?.status === "debited") counters.debited += 1;
      else if (result?.status === "pending") counters.pending += 1;
      else if (result?.status === "already_covered") counters.alreadyCovered += 1;
      else if (result?.status === "legacy_debt_ignored") counters.legacyIgnored += 1;
      else if (result?.status === "subscription_blocked") counters.subscriptionBlocked += 1;
      else counters.skipped += 1;
    } catch (error) {
      counters.skipped += 1;
      console.log("[FIXED BILLING] appointment error", {
        apId: String(ap._id),
        error: error?.message || error,
      });
    }
  }

  const out = { ok: true, ...counters, today, legacyDebt: "disabled" };
  console.log("[FIXED BILLING] tick", out);
  return out;
}

export async function releaseUnpaidFixedSchedules() {
  // Compatibilidad de export. La liberación ahora depende exclusivamente del
  // lifecycle de suscripciones (día 21 por falta de pago del ciclo mensual).
  return { ok: true, skipped: true, reason: "LEGACY_DEBT_DISABLED" };
}

export async function sendWeeklyFixedDebtSummary() {
  // Compatibilidad de export. Ya no se envían resúmenes de deuda legacy.
  return { ok: true, sent: false, skipped: true, reason: "LEGACY_DEBT_DISABLED" };
}

export function startFixedScheduleBillingScheduler({ everyMinutes = 2 } = {}) {
  if (schedulerStarted) return;
  schedulerStarted = true;

  const enabled = String(process.env.FIXED_SCHEDULE_BILLING_ENABLED || "true") !== "false";
  const minutes = Math.max(
    1,
    Number(everyMinutes || process.env.FIXED_SCHEDULE_BILLING_EVERY_MINUTES || 2)
  );

  console.log("[FIXED BILLING] scheduler starting", {
    enabled,
    everyMinutes: minutes,
    legacyDebt: "disabled",
  });

  if (!enabled) return;

  setTimeout(() => {
    runFixedScheduleBillingTick().catch((e) =>
      console.log("[FIXED BILLING] first tick error", e?.message || e)
    );
  }, 5000);

  schedulerTimer = setInterval(() => {
    runFixedScheduleBillingTick().catch((e) =>
      console.log("[FIXED BILLING] tick error", e?.message || e)
    );
  }, minutes * 60 * 1000);

  schedulerTimer.unref?.();
}

export default startFixedScheduleBillingScheduler;
