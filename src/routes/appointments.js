// backend/src/routes/appointments.js
import express from "express";
import mongoose from "mongoose";

import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import WaitlistEntry from "../models/WaitlistEntry.js";

import { notifyWaitlistForSlot } from "./waitlist.js";
import { protect } from "../middleware/auth.js";

import {
  fireAndForget,
  sendAppointmentBookedEmail,
  sendAppointmentBookedBatchEmail,
  sendAppointmentCancelledEmail,
} from "../mail.js";

const router = express.Router();

/* =========================
   CONFIG: ventana de reserva
========================= */
const MAX_ADVANCE_DAYS = 14;

// ✅ mínimo de anticipación (en minutos)
const MIN_BOOKING_MINUTES = Number(process.env.MIN_BOOKING_MINUTES || 60);

/* =========================
   ✅ CRÉDITOS: vencen SI O SI a 30 días
========================= */
const CREDITS_EXPIRE_DAYS = 30;

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

// ✅ regla mínima de anticipación
function validateMinAdvance(slotDate) {
  const now = new Date();
  const limit = new Date(now.getTime() + MIN_BOOKING_MINUTES * 60 * 1000);
  if (slotDate.getTime() < limit.getTime()) {
    return {
      ok: false,
      error: `El turno debe reservarse con al menos ${MIN_BOOKING_MINUTES} minutos de anticipación.`,
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

/**
 * Match con front:
 * - mañana: 07..12
 * - bloqueado: 12:01..13:29
 * - 13:30 permitido
 * - tarde:  14..17 (solo EP)
 * - noche: 18..20
 */
function getTurnoFromTime(time) {
  if (!time) return "";
  const [hStr, mStr] = String(time).split(":");
  const h = Number(hStr);
  const m = Number(mStr);

  // 13:30 permitido
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

function pickLotToConsume(user, wantedServiceKey) {
  const now = nowDate();
  const want = String(wantedServiceKey || "").toUpperCase().trim() || "EP";

  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];

  const sorted = lots
    .filter((l) => Number(l.remaining || 0) > 0)
    .filter((l) => !l.expiresAt || new Date(l.expiresAt) > now)
    .filter((l) => {
      const lk = normalizeLotServiceKey(l);
      return lk === want;
    })
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

function findLotById(user, lotId) {
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
  return lots.find((l) => String(l._id) === String(lotId)) || null;
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

function requiresApto(user) {
  if (!user?.createdAt) return false;
  const created = new Date(user.createdAt);
  const days = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
  return days > 20 && !user.aptoPath;
}

/* =========================
   Cupos (TU REGLA EXACTA)
========================= */
const TOTAL_CAP = 6;

// ⚠️ Nombres “humanos” (pueden venir con acentos desde el front)
// Lo importante: se comparan con sameService()
const EP_NAME = "Entrenamiento Personal";
const RA_NAME = "Rehabilitación activa";
const RF_NAME = "Reeducación funcional";

/**
 * TU REGLA:
 * - TOTAL 6 por horario
 * - Antes de 12hs: EP máximo 4 (dejando 1 RA + 1 RF “reservables”)
 * - Dentro de 12hs:
 *    - si NO hay RA NI RF -> EP puede 6
 *    - si hay 1 de (RA/RF) -> EP puede 5
 *    - si hay ambos -> EP queda en 4
 * - Además: si RA o RF ya ocupan, reducen el máximo total disponible para EP
 */
function calcEpCap({ hoursToStart, hasRF, hasRA, otherReservedCount }) {
  let cap = 4;

  // ✅ 12 horas (no 2)
  if (Number(hoursToStart) <= 12) {
    if (!hasRF && !hasRA) cap = 6;
    else if (!!hasRF !== !!hasRA) cap = 5; // XOR (solo uno tomado)
    else cap = 4; // ambos tomados
  }

  // nunca superar el total restante según RA/RF ocupando
  const totalLimit = Math.max(0, TOTAL_CAP - Number(otherReservedCount || 0));
  cap = Math.min(cap, totalLimit);

  return Math.max(0, cap);
}

/* =========================
   CANCELACIÓN (REINTEGRO)
========================= */
const REFUND_POLICY = {
  EP: { cutoffHours: 2, inclusive: false },
  RA: { cutoffHours: 12, inclusive: true },
  RF: { cutoffHours: 12, inclusive: true },
  OTHER: { cutoffHours: 12, inclusive: true },
};

function refundHoursEligible(hoursToStart, policy) {
  const h = Number(hoursToStart);
  if (!Number.isFinite(h)) return false;
  if (h <= 0) return false;
  const cutoff = Number(policy?.cutoffHours || 0);
  const inclusive = Boolean(policy?.inclusive);
  return inclusive ? h >= cutoff : h > cutoff;
}

function serviceRefundKey(serviceName) {
  const k = serviceToKey(serviceName);
  if (k === "EP") return "EP";
  if (k === "RA") return "RA";
  if (k === "RF") return "RF";
  return "OTHER";
}

function getRefundPolicy(serviceName) {
  const k = serviceRefundKey(serviceName);
  const p = REFUND_POLICY[k] || REFUND_POLICY.OTHER;
  return {
    key: k,
    cutoffHours: p.cutoffHours,
    inclusive: p.inclusive,
    isEligible(hoursToStart) {
      return refundHoursEligible(hoursToStart, p);
    },
  };
}

/* =========================
   Helpers: validación de item
========================= */
function validateBasicSlotRules({ date, time, service }) {
  if (!date || !time || !service) {
    return { ok: false, error: "Faltan campos: date, time y service." };
  }

  // ✅ sábado OFF
  if (isSaturday(date)) {
    return { ok: false, error: "Los sábados no hay turnos disponibles." };
  }

  // ✅ 13:xx inválido salvo 13:30
  const timeNorm = String(time).slice(0, 5);
  if (timeNorm.startsWith("13:") && timeNorm !== "13:30") {
    return { ok: false, error: "Horario inválido." };
  }

  const turno = getTurnoFromTime(timeNorm);
  if (!turno) {
    return { ok: false, error: "Horario fuera del rango permitido." };
  }

  const slotDate = buildSlotDate(date, timeNorm);
  if (!slotDate) return { ok: false, error: "Fecha/hora inválida." };

  const w = validateBookingWindow(slotDate);
  if (!w.ok) return w;

  const adv = validateMinAdvance(slotDate);
  if (!adv.ok) return adv;

  const isEpService = sameService(service, EP_NAME);

  // tarde solo EP
  if (turno === "tarde" && !isEpService) {
    return { ok: false, error: "En el turno tarde solo está disponible Entrenamiento Personal." };
  }

  return { ok: true, turno, slotDate, isEpService };
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

/* =========================
   AUTH required
========================= */
router.use(protect);

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

    // sábado => closed
    if (isSaturday(date)) {
      const timesForced =
        Array.isArray(req.query?.times) && req.query.times.length
          ? req.query.times.map((x) => String(x).slice(0, 5))
          : [
              "07:00","08:00","09:00","10:00",
              "11:00","12:00","13:30",
              "14:00","15:00","16:00","17:00",
              "18:00","19:00","20:00",
            ];

      return res.json({
        date,
        service,
        slots: timesForced.map((t) => ({
          time: t,
          state: "closed",
          reason: "Sábados no disponibles",
        })),
      });
    }

    const times =
      Array.isArray(req.query?.times) && req.query.times.length
        ? req.query.times.map((x) => String(x).slice(0, 5))
        : [
            "07:00","08:00","09:00","10:00",
            "11:00","12:00","13:30",
            "14:00","15:00","16:00","17:00",
            "18:00","19:00","20:00",
          ];

    const out = [];

    for (const time of times) {
      const t = String(time).slice(0, 5);
      const basic = validateBasicSlotRules({ date, time: t, service });

      if (!basic.ok) {
        out.push({ time: t, state: "closed", reason: basic.error });
        continue;
      }

      const existing = await Appointment.find({ date, time: t, status: "reserved" })
        .select("service")
        .lean();

      const total = existing.length;

      // total full
      if (total >= TOTAL_CAP) {
        if (basic.isEpService) {
          out.push({
            time: t,
            state: "waitlist",
            totalReserved: total,
            epReserved: existing.filter((a) => sameService(a.service, EP_NAME)).length,
          });
        } else {
          out.push({ time: t, state: "full", totalReserved: total });
        }
        continue;
      }

      // RF 1 por hora
      if (sameService(service, RF_NAME)) {
        const hasRF = existing.some((a) => sameService(a.service, RF_NAME));
        if (hasRF) {
          out.push({ time: t, state: "full", totalReserved: total });
          continue;
        }
      }

      // RA 1 por hora
      if (sameService(service, RA_NAME)) {
        const hasRA = existing.some((a) => sameService(a.service, RA_NAME));
        if (hasRA) {
          out.push({ time: t, state: "full", totalReserved: total });
          continue;
        }
      }

      // EP cap dinámico
      if (basic.isEpService) {
        const epCount = existing.filter((a) => sameService(a.service, EP_NAME)).length;
        const rfTaken = existing.some((a) => sameService(a.service, RF_NAME)) ? 1 : 0;
        const raTaken = existing.some((a) => sameService(a.service, RA_NAME)) ? 1 : 0;
        const otherReservedCount = rfTaken + raTaken;

        const hoursToStart = (basic.slotDate.getTime() - Date.now()) / (1000 * 60 * 60);
        const epCap = calcEpCap({
          hoursToStart,
          hasRF: !!rfTaken,
          hasRA: !!raTaken,
          otherReservedCount,
        });

        if (epCount >= epCap) {
          out.push({
            time: t,
            state: "waitlist",
            totalReserved: total,
            epReserved: epCount,
            epCap,
          });
          continue;
        }
      }

      out.push({ time: t, state: "available", totalReserved: total });
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
    const isAdmin = req.user?.role === "admin";

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
      if (!isAdmin) return res.status(403).json({ error: "No autorizado." });

      const q = {};
      if (hasFrom && hasTo) q.date = { $gte: from, $lt: to };
      else if (hasFrom) q.date = { $gte: from };

      const list = await Appointment.find(q)
        .populate("user", "name lastName email")
        .lean();

      return res.json((list || []).map(serializeAppointment));
    }

    // mine default
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
   POST /appointments
========================= */
router.post("/", async (req, res) => {
  const session = await mongoose.startSession();

  let mailUser = null;
  let mailAp = null;
  let mailServiceName = null;

  try {
    const { date, time, service, notes } = req.body || {};
    const basic = validateBasicSlotRules({ date, time, service });
    if (!basic.ok) return res.status(400).json({ error: basic.error });

    const userId = req.user._id || req.user.id;
    let out = null;

    await session.withTransaction(async () => {
      const user = await User.findById(userId).session(session);
      if (!user) throw new Error("USER_NOT_FOUND");

      const isAdmin = user.role === "admin";

      if (!isAdmin) {
        if (user.suspended) throw new Error("USER_SUSPENDED");
        if (requiresApto(user)) throw new Error("APTO_REQUIRED");

        recalcUserCredits(user);
        if ((user.credits || 0) <= 0) throw new Error("NO_CREDITS");
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

      // total cap
      if (existingAtSlot.length >= TOTAL_CAP) {
        if (basic.isEpService) willWaitlist = true;
        else throw new Error("TOTAL_CAP_REACHED");
      }

      const epCount = existingAtSlot.filter((a) => sameService(a.service, EP_NAME)).length;
      const rfTaken = existingAtSlot.some((a) => sameService(a.service, RF_NAME)) ? 1 : 0;
      const raTaken = existingAtSlot.some((a) => sameService(a.service, RA_NAME)) ? 1 : 0;
      const otherReservedCount = rfTaken + raTaken;

      // RF/RA solo 1 por hora (acá también, por seguridad)
      if (sameService(service, RF_NAME) && rfTaken) throw new Error("SERVICE_CAP_REACHED");
      if (sameService(service, RA_NAME) && raTaken) throw new Error("SERVICE_CAP_REACHED");

      if (basic.isEpService) {
        const hoursToStart = (basic.slotDate.getTime() - Date.now()) / (1000 * 60 * 60);

        const epCap = calcEpCap({
          hoursToStart,
          hasRF: !!rfTaken,
          hasRA: !!raTaken,
          otherReservedCount,
        });

        if (epCount >= epCap) willWaitlist = true;
      }

      // ✅ WAITLIST EP (sin consumir crédito)
      if (willWaitlist && basic.isEpService) {
        const wlExists = await WaitlistEntry.findOne({
          user: user._id,
          date,
          time: t,
          service: EP_NAME,
          status: { $in: ["waiting", "notified"] },
        }).session(session);

        if (wlExists) throw new Error("ALREADY_IN_WAITLIST");

        await WaitlistEntry.create(
          [{ user: user._id, date, time: t, service: EP_NAME, status: "waiting" }],
          { session }
        );

        out = { kind: "waitlist", date, time: t, service: EP_NAME, status: "waiting" };
        return;
      }

      // consumir crédito
      let usedLotId = null;
      let usedLotExp = null;

      if (!isAdmin) {
        const sk = serviceToKey(service);
        const lot = pickLotToConsume(user, sk);
        if (!lot) throw new Error(`NO_CREDITS_FOR_${sk}`);

        lot.remaining = Number(lot.remaining || 0) - 1;
        usedLotId = lot._id;
        usedLotExp = lot.expiresAt || null;

        recalcUserCredits(user);

        user.history = user.history || [];
        user.history.push({
          action: "reservado",
          date,
          time: t,
          service,
          notes: String(notes || "").trim(),
          createdAt: new Date(),
        });

        await user.save({ session });
      }

      const created = await Appointment.create(
        [{
          date,
          time: t,
          service,
          user: user._id,
          status: "reserved",
          creditLotId: usedLotId,
          creditExpiresAt: usedLotExp,
        }],
        { session }
      );

      const populated = await Appointment.findById(created[0]._id)
        .populate("user", "name lastName email")
        .session(session);

      out = serializeAppointment(populated);

      mailUser = { ...user.toObject(), _id: user._id };
      mailAp = { date, time: t, service };
      mailServiceName = service;
    });

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

    if (msg === "ALREADY_HAVE_SLOT")
      return res.status(409).json({ error: "Ya tenés un turno reservado en ese horario." });

    if (msg === "ALREADY_IN_WAITLIST")
      return res.status(409).json({ error: "Ya estás en lista de espera para ese horario." });

    if (msg === "TOTAL_CAP_REACHED")
      return res.status(409).json({ error: "Se alcanzó el cupo total disponible para este horario." });

    if (msg === "SERVICE_CAP_REACHED")
      return res.status(409).json({ error: "Ese servicio ya alcanzó su cupo para ese horario." });

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

    await session.withTransaction(async () => {
      const user = await User.findById(userId).session(session);
      if (!user) throw new Error("USER_NOT_FOUND");

      const isAdmin = user.role === "admin";

      if (!isAdmin) {
        if (user.suspended) throw new Error("USER_SUSPENDED");
        if (requiresApto(user)) throw new Error("APTO_REQUIRED");

        recalcUserCredits(user);
        if ((user.credits || 0) <= 0) throw new Error("NO_CREDITS");
      }

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

      // marcar waitlist / validar cupos
      for (const it of normalized) {
        const k = slotKey(it.date, it.time);
        const cur = bySlot.get(k) || [];

        if (cur.length >= TOTAL_CAP) {
          if (it.isEpService) {
            it.waitlist = true;
            continue;
          }
          const e = new Error("TOTAL_CAP_REACHED");
          e.http = 409;
          throw e;
        }

        // RF/RA 1 por hora
        if (sameService(it.service, RF_NAME)) {
          if (cur.some((a) => sameService(a.service, RF_NAME))) {
            const e = new Error("SERVICE_CAP_REACHED");
            e.http = 409;
            throw e;
          }
        }
        if (sameService(it.service, RA_NAME)) {
          if (cur.some((a) => sameService(a.service, RA_NAME))) {
            const e = new Error("SERVICE_CAP_REACHED");
            e.http = 409;
            throw e;
          }
        }

        if (it.isEpService) {
          const epCount = cur.filter((a) => sameService(a.service, EP_NAME)).length;
          const rfTaken = cur.some((a) => sameService(a.service, RF_NAME)) ? 1 : 0;
          const raTaken = cur.some((a) => sameService(a.service, RA_NAME)) ? 1 : 0;
          const otherReservedCount = rfTaken + raTaken;

          const hoursToStart = (it.slotDate.getTime() - Date.now()) / (1000 * 60 * 60);

          const epCap = calcEpCap({
            hoursToStart,
            hasRF: !!rfTaken,
            hasRA: !!raTaken,
            otherReservedCount,
          });

          if (epCount >= epCap) {
            it.waitlist = true;
            continue;
          }
        }

        cur.push({ date: it.date, time: it.time, service: it.service });
        bySlot.set(k, cur);
      }

      createdItems = [];
      waitlistedItems = [];

      const toReserve = normalized.filter((x) => !x.waitlist);

      if (!isAdmin) {
        recalcUserCredits(user);
        if ((user.credits || 0) < toReserve.length) {
          const e = new Error("NO_CREDITS");
          e.http = 403;
          throw e;
        }
      }

      for (const it of normalized) {
        if (it.waitlist) {
          const wlExists = await WaitlistEntry.findOne({
            user: user._id,
            date: it.date,
            time: it.time,
            service: EP_NAME,
            status: { $in: ["waiting", "notified"] },
          }).session(session);

          if (!wlExists) {
            await WaitlistEntry.create(
              [{
                user: user._id,
                date: it.date,
                time: it.time,
                service: EP_NAME,
                status: "waiting",
              }],
              { session }
            );
          }

          waitlistedItems.push({
            kind: "waitlist",
            date: it.date,
            time: it.time,
            service: EP_NAME,
            status: "waiting",
          });
          continue;
        }

        let usedLotId = null;
        let usedLotExp = null;

        if (!isAdmin) {
          const sk = serviceToKey(it.service);
          const lot = pickLotToConsume(user, sk);
          if (!lot) {
            const e = new Error(`NO_CREDITS_FOR_${sk}`);
            e.http = 403;
            throw e;
          }

          lot.remaining = Number(lot.remaining || 0) - 1;
          usedLotId = lot._id;
          usedLotExp = lot.expiresAt || null;

          user.history = user.history || [];
          user.history.push({
            action: "reservado",
            date: it.date,
            time: it.time,
            service: it.service,
            createdAt: new Date(),
          });
        }

        const created = await Appointment.create(
          [{
            date: it.date,
            time: it.time,
            service: it.service,
            user: user._id,
            status: "reserved",
            creditLotId: usedLotId,
            creditExpiresAt: usedLotExp,
          }],
          { session }
        );

        const populated = await Appointment.findById(created[0]._id)
          .populate("user", "name lastName email")
          .session(session);

        createdItems.push(serializeAppointment(populated));
      }

      if (!isAdmin) {
        recalcUserCredits(user);
        await user.save({ session });
      }

      mailUser = { ...user.toObject(), _id: user._id };
      mailItems = createdItems.map((x) => ({ date: x.date, time: x.time, service: x.service }));
    });

    res.status(201).json({ items: createdItems, waitlisted: waitlistedItems });

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
========================= */
router.post("/waitlist/claim", async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const token = String(req.body?.token || "").trim();
    if (!token) return res.status(400).json({ error: "Falta token." });

    let payload = null;

    await session.withTransaction(async () => {
      const wl = await WaitlistEntry.findOne({
        notifyToken: token,
        status: "notified",
      }).session(session);

      if (!wl) {
        const e = new Error("TOKEN_INVALID");
        e.http = 404;
        throw e;
      }

      if (wl.tokenExpiresAt && new Date(wl.tokenExpiresAt) <= new Date()) {
        wl.status = "expired";
        await wl.save({ session });
        const e = new Error("TOKEN_EXPIRED");
        e.http = 410;
        throw e;
      }

      const user = await User.findById(wl.user).session(session);
      if (!user) {
        const e = new Error("USER_NOT_FOUND");
        e.http = 404;
        throw e;
      }

      const basic = validateBasicSlotRules({ date: wl.date, time: wl.time, service: EP_NAME });
      if (!basic.ok) {
        const e = new Error("SLOT_NOT_VALID");
        e.http = 409;
        throw e;
      }

      const existingAtSlot = await Appointment.find({
        date: wl.date,
        time: wl.time,
        status: "reserved",
      }).session(session).lean();

      if (existingAtSlot.length >= TOTAL_CAP) {
        const e = new Error("NO_LONGER_AVAILABLE");
        e.http = 409;
        throw e;
      }

      const epCount = existingAtSlot.filter((a) => sameService(a.service, EP_NAME)).length;
      const rfTaken = existingAtSlot.some((a) => sameService(a.service, RF_NAME)) ? 1 : 0;
      const raTaken = existingAtSlot.some((a) => sameService(a.service, RA_NAME)) ? 1 : 0;
      const otherReservedCount = rfTaken + raTaken;

      const hoursToStart = (basic.slotDate.getTime() - Date.now()) / (1000 * 60 * 60);
      const epCap = calcEpCap({
        hoursToStart,
        hasRF: !!rfTaken,
        hasRA: !!raTaken,
        otherReservedCount,
      });

      if (epCount >= epCap) {
        const e = new Error("NO_LONGER_AVAILABLE");
        e.http = 409;
        throw e;
      }

      const alreadyByUser = await Appointment.findOne({
        date: wl.date,
        time: wl.time,
        user: user._id,
        status: "reserved",
      }).session(session).lean();

      if (alreadyByUser) {
        wl.status = "claimed";
        wl.claimedAt = new Date();
        await wl.save({ session });
        payload = { ok: true, alreadyHadIt: true };
        return;
      }

      if (user.role !== "admin") {
        if (user.suspended) throw new Error("USER_SUSPENDED");
        if (requiresApto(user)) throw new Error("APTO_REQUIRED");

        recalcUserCredits(user);
        if ((user.credits || 0) <= 0) throw new Error("NO_CREDITS");

        const sk = serviceToKey(EP_NAME);
        const lot = pickLotToConsume(user, sk);
        if (!lot) throw new Error(`NO_CREDITS_FOR_${sk}`);

        lot.remaining = Number(lot.remaining || 0) - 1;

        user.history = user.history || [];
        user.history.push({
          action: "reservado_desde_waitlist",
          date: wl.date,
          time: wl.time,
          service: EP_NAME,
          createdAt: new Date(),
        });

        recalcUserCredits(user);
        await user.save({ session });
      }

      const created = await Appointment.create(
        [{
          date: wl.date,
          time: wl.time,
          service: EP_NAME,
          user: user._id,
          status: "reserved",
          creditLotId: null,
          creditExpiresAt: null,
        }],
        { session }
      );

      wl.status = "claimed";
      wl.claimedAt = new Date();
      await wl.save({ session });

      payload = { ok: true, appointmentId: String(created[0]._id) };
    });

    res.json(payload);
  } catch (err) {
    const http = err?.http || 500;
    const msg = String(err?.message || "");

    if (msg === "TOKEN_INVALID") return res.status(404).json({ error: "Token inválido." });
    if (msg === "TOKEN_EXPIRED") return res.status(410).json({ error: "El link expiró." });
    if (msg === "NO_LONGER_AVAILABLE") return res.status(409).json({ error: "El cupo ya no está disponible." });

    if (msg === "USER_NOT_FOUND") return res.status(404).json({ error: "Usuario no encontrado." });
    if (msg === "USER_SUSPENDED") return res.status(403).json({ error: "Cuenta suspendida." });
    if (msg === "APTO_REQUIRED")
      return res.status(403).json({ error: "Cuenta suspendida por falta de apto médico." });
    if (msg === "NO_CREDITS") return res.status(403).json({ error: "Sin créditos disponibles." });
    if (msg.startsWith("NO_CREDITS_FOR_")) return res.status(403).json({ error: "No tenés créditos válidos." });

    console.error("Error en POST /appointments/waitlist/claim:", err);
    return res.status(http).json({ error: "No se pudo confirmar el turno." });
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
  let mailServiceName = null;
  let mailMeta = null;

  try {
    const { id } = req.params;
    let payload = null;

    await session.withTransaction(async () => {
      const ap = await Appointment.findById(id).session(session);
      if (!ap) {
        const e = new Error("NOT_FOUND");
        e.http = 404;
        throw e;
      }

      const tokenUserId = req.user._id || req.user.id;
      const isOwner = ap.user?.toString?.() === String(tokenUserId);
      const isAdmin = req.user.role === "admin";

      if (!isOwner && !isAdmin) {
        const e = new Error("FORBIDDEN");
        e.http = 403;
        throw e;
      }

      if (ap.status === "cancelled") {
        const e = new Error("ALREADY_CANCELLED");
        e.http = 400;
        throw e;
      }

      const apDate = buildSlotDate(ap.date, ap.time);
      if (!apDate) {
        const e = new Error("INVALID_AP_DATE");
        e.http = 400;
        throw e;
      }

      const diffMs = apDate.getTime() - Date.now();
      const hours = diffMs / (1000 * 60 * 60);

      if (hours < 0) {
        const e = new Error("PAST_APPOINTMENT");
        e.http = 400;
        throw e;
      }

      const user = await User.findById(ap.user).session(session);
      if (!user) {
        const e = new Error("USER_NOT_FOUND");
        e.http = 404;
        throw e;
      }

      ap.status = "cancelled";
      await ap.save({ session });

      const policy = getRefundPolicy(ap.service);
      const cutoff = policy.cutoffHours;

      const shouldRefund = user.role !== "admin" && policy.isEligible(hours);

      if (user.role !== "admin") {
        user.history = user.history || [];
        user.history.push({
          action: shouldRefund ? "cancelado" : "cancelado_sin_reintegro",
          date: ap.date,
          time: ap.time,
          service: ap.service,
          createdAt: new Date(),
        });

        if (shouldRefund) {
          const now = nowDate();
          const sk = serviceToKey(ap.service);

          const lot = ap.creditLotId ? findLotById(user, ap.creditLotId) : null;

          if (lot) {
            const exp = lot.expiresAt ? new Date(lot.expiresAt) : null;
            if (!exp || exp > now) {
              lot.remaining = Number(lot.remaining || 0) + 1;
            }
          } else {
            const exp = new Date(now);
            exp.setDate(exp.getDate() + Number(getCreditsExpireDays(user) || 30));

            user.creditLots = user.creditLots || [];
            user.creditLots.push({
              serviceKey: sk,
              amount: 1,
              remaining: 1,
              expiresAt: exp,
              source: "refund",
              orderId: null,
              createdAt: now,
            });
          }
        }

        recalcUserCredits(user);
        await user.save({ session });
      }

      const populated = await Appointment.findById(ap._id)
        .populate("user", "name lastName email")
        .session(session);

      payload = {
        ...serializeAppointment(populated),
        refund: shouldRefund,
        refundCutoffHours: cutoff,
      };

      mailUser = { ...user.toObject(), _id: user._id };
      mailAp = { date: ap.date, time: ap.time, service: ap.service };
      mailServiceName = ap.service;
      mailMeta = { refund: shouldRefund, refundCutoffHours: cutoff };
    });

    res.json(payload);

    if (mailAp?.date && mailAp?.time) {
      fireAndForget(async () => {
        await notifyWaitlistForSlot({ date: mailAp.date, time: mailAp.time });
      }, "WAITLIST_NOTIFY");
    }

    if (mailUser && mailAp) {
      fireAndForget(async () => {
        try {
          await sendAppointmentCancelledEmail(mailUser, mailAp, mailServiceName, mailMeta);
        } catch (e) {
          console.log("[MAIL] cancelled error:", e?.message || e);
          await sendAdminCopy({
            kind: "cancelled",
            user: mailUser,
            ap: { ...mailAp, refund: mailMeta?.refund },
          });
        }
      }, "MAIL_CANCELLED");
    }
  } catch (err) {
    console.error("Error en PATCH /appointments/:id/cancel:", err);
    const http = err?.http;

    if (http) {
      const msg = String(err?.message || "");
      if (msg === "NOT_FOUND") return res.status(404).json({ error: "Turno no encontrado." });
      if (msg === "FORBIDDEN")
        return res.status(403).json({ error: "Solo el dueño del turno o un admin pueden cancelarlo." });
      if (msg === "ALREADY_CANCELLED") return res.status(400).json({ error: "El turno ya estaba cancelado." });
      if (msg === "INVALID_AP_DATE") return res.status(400).json({ error: "Turno con fecha/hora inválida." });
      if (msg === "PAST_APPOINTMENT")
        return res.status(400).json({ error: "No se puede cancelar un turno que ya pasó." });
      if (msg === "USER_NOT_FOUND") return res.status(404).json({ error: "Usuario no encontrado." });
      return res.status(http).json({ error: "Error al cancelar el turno." });
    }

    return res.status(500).json({ error: "Error al cancelar el turno." });
  } finally {
    session.endSession();
  }
});

export default router;