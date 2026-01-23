// backend/src/routes/appointments.js
import express from "express";
import mongoose from "mongoose";
import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";

import {
  sendAppointmentBookedEmail,
  sendAppointmentBookedBatchEmail,
  sendAppointmentCancelledEmail,
  // si en tu mail.js agregaste estas, podés usarlas directo:
  // sendAdminAppointmentBookedEmail,
  // sendAdminAppointmentCancelledEmail,
} from "../mail.js";

const router = express.Router();

/* =========================
   CONFIG: ventana de reserva
   ✅ desde AHORA hasta +14 días
========================= */
const MAX_ADVANCE_DAYS = 14;

/* =========================
   ADMIN MAIL (fallback)
   - si tus funciones ya mandan al admin, no pasa nada
========================= */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "duoclub.ar@gmail.com";

// fallback simple por si todavía no agregaste "admin mail" en mail.js
async function sendAdminCopy({ kind, user, ap }) {
  try {
    // si tus mailers ya lo mandan al admin, podés apagar esto seteando:
    // MAIL_ADMIN_COPY=false
    if (String(process.env.MAIL_ADMIN_COPY || "true") !== "true") return;

    // Si NO tenés SMTP, tu mailer mockuea y listo.
    // Usamos sendAppointmentBookedEmail / CancelledEmail? NO, porque eso re-enviaría al usuario.
    // Entonces, este fallback solo sirve si en ../mail.js exponés un sendMail simple.
    // Como acá NO lo importamos, dejamos solo log para no duplicar.
    //
    // 👉 Recomendación: lo correcto es que sendAppointmentBookedEmail/CanceledEmail
    // ya envíen al admin adentro (como te pasé).
    console.log("[MAIL ADMIN FALLBACK]", {
      to: ADMIN_EMAIL,
      kind,
      user: { id: user?._id?.toString?.() || user?.id, email: user?.email, name: user?.name },
      ap: { date: ap?.date, time: ap?.time, service: ap?.service },
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
  return new Date(year, month - 1, day, hour || 0, minute || 0);
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

function isSaturday(dateStr) {
  const [y, m, d] = String(dateStr || "").split("-").map(Number);
  if (!y || !m || !d) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getDay() === 6;
}

/**
 * ✅ Match con tu frontend:
 * - mañana: 07..12
 * - tarde: 14..17
 * - noche: 18..20 (incluye 20)
 */
function getTurnoFromTime(time) {
  if (!time) return "";
  const [hStr] = String(time).split(":");
  const h = Number(hStr);

  if (h >= 7 && h <= 12) return "maniana";
  if (h >= 14 && h <= 17) return "tarde";
  if (h >= 18 && h <= 20) return "noche";
  return "";
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

// ✅ RF eliminado
function serviceToKey(serviceName) {
  const s = stripAccents(serviceName).toLowerCase().trim();

  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("alto") && s.includes("rendimiento")) return "AR";
  if (s.includes("nutricion")) return "NUT";

  const up = String(serviceName || "").toUpperCase().trim();
  const allowed = new Set(["EP", "RA", "AR", "NUT"]);
  if (allowed.has(up)) return up;

  return "EP";
}

function isPlusActive(user) {
  const m = user?.membership || {};
  const tier = String(m.tier || "").toLowerCase().trim();
  if (tier !== "plus") return false;
  if (!m.activeUntil) return false;
  return new Date(m.activeUntil) > new Date();
}

// ✅ Solo para vencimiento de créditos (si querés mantener diferencia basic/plus)
function getCreditsExpireDays(user) {
  return isPlusActive(user) ? 40 : 30;
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
      return lk === "ALL" || lk === want;
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
  const json = ap.toObject ? ap.toObject() : ap;

  const userObj = json.user || {};
  const userId =
    userObj._id?.toString?.() ||
    json.userId ||
    userObj.toString?.() ||
    "";

  return {
    id: json._id?.toString?.() || json.id,
    date: json.date,
    time: json.time,
    service: json.service || "",
    status: json.status || "reserved",
    coach: json.coach || "",
    userId,
    userName: userObj.name || "",
    userEmail: userObj.email || "",
    creditExpiresAt: json.creditExpiresAt || null,
  };
}

function requiresApto(user) {
  if (!user?.createdAt) return false;
  const created = new Date(user.createdAt);
  const days = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
  return days > 20 && !user.aptoPath;
}

/* =========================
   ✅ Cupos (alineado con front)
========================= */
const TOTAL_CAP = 6;

const EP_NAME = "Entrenamiento Personal";

function calcEpCap({ hoursToStart, otherReservedCount }) {
  const base = hoursToStart > 12 ? 4 : TOTAL_CAP;
  const dynamic = TOTAL_CAP - otherReservedCount;
  return Math.max(0, Math.min(base, dynamic));
}

/* =========================
   ✅ CANCELACIÓN: regla única
   - Se puede cancelar hasta el inicio (no pasado)
   - Crédito se devuelve SOLO si faltan >= 12hs
========================= */
const REFUND_CUTOFF_HOURS = 12;

/* =========================
   Helpers: validación de item
========================= */
function validateBasicSlotRules({ date, time, service }) {
  if (!date || !time || !service) {
    return { ok: false, error: "Faltan campos: date, time y service." };
  }

  const turno = getTurnoFromTime(time);
  if (!turno) {
    return { ok: false, error: "Horario fuera del rango permitido." };
  }

  // ✅ Sábado: 08..12
  if (isSaturday(date)) {
    const [hStr] = String(time).split(":");
    const h = Number(hStr);
    if (h < 8 || h > 12) {
      return {
        ok: false,
        error: "Los sábados solo se puede reservar de 08:00 a 12:00.",
      };
    }
  }

  const slotDate = buildSlotDate(date, time);
  if (!slotDate) return { ok: false, error: "Fecha/hora inválida." };

  // ✅ ventana: AHORA -> +14 días
  const w = validateBookingWindow(slotDate);
  if (!w.ok) return w;

  const isEpService = service === EP_NAME;

  // ✅ tarde: SOLO EP (regla dura)
  if (turno === "tarde" && !isEpService) {
    return {
      ok: false,
      error: "En el turno tarde solo está disponible Entrenamiento Personal.",
    };
  }

  return { ok: true, turno, slotDate, isEpService };
}

function slotKey(date, time) {
  return `${date}__${time}`;
}

/* =========================
   PUBLIC: GET /appointments
========================= */
router.get("/", async (req, res) => {
  try {
    const { from, to } = req.query || {};
    const query = {};

    if (from && to) query.date = { $gte: from, $lt: to };
    else if (from) query.date = { $gte: from };

    const list = await Appointment.find(query)
      .populate("user", "name email")
      .lean();

    res.json(list.map(serializeAppointment));
  } catch (err) {
    console.error("Error en GET /appointments:", err);
    res.status(500).json({ error: "Error al obtener turnos." });
  }
});

/* =========================
   AUTH required
========================= */
router.use(protect);

/* =========================
   POST /appointments
   - descuenta 1 crédito desde lotes (POR SERVICIO)
========================= */
router.post("/", async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const { date, time, service } = req.body || {};

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

      // ya tiene turno a esa hora
      const alreadyByUser = await Appointment.findOne({
        date,
        time,
        user: user._id,
        status: "reserved",
      })
        .session(session)
        .lean();

      if (alreadyByUser) throw new Error("ALREADY_HAVE_SLOT");

      const existingAtSlot = await Appointment.find({
        date,
        time,
        status: "reserved",
      })
        .session(session)
        .lean();

      const totalCount = existingAtSlot.length;
      if (totalCount >= TOTAL_CAP) throw new Error("TOTAL_CAP_REACHED");

      const epCount = existingAtSlot.filter((a) => a.service === EP_NAME).length;

      // ojo con el acento: tu sistema lo está guardando como "Rehabilitacion Activa" (sin tilde)
      const arTaken = existingAtSlot.some((a) => a.service === "Alto Rendimiento") ? 1 : 0;
      const raTaken = existingAtSlot.some((a) => a.service === "Rehabilitacion Activa") ? 1 : 0;
      const otherReservedCount = arTaken + raTaken;

      // ✅ Otros servicios: máximo 1 por servicio por hora
      if (!basic.isEpService) {
        const alreadyService = existingAtSlot.some((a) => a.service === service);
        if (alreadyService) throw new Error("SERVICE_ALREADY_TAKEN");
      }

      // ✅ EP cap rule
      if (basic.isEpService) {
        const hoursToStart = (basic.slotDate.getTime() - Date.now()) / (1000 * 60 * 60);
        const epCap = calcEpCap({ hoursToStart, otherReservedCount });
        if (epCount >= epCap) throw new Error(hoursToStart > 12 ? "EP_CAP_4" : "EP_CAP_TOTAL");
      }

      // ✅ consumir crédito desde lote (solo clientes)
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
          time,
          service,
          createdAt: new Date(),
        });

        await user.save({ session });
      }

      const ap = await Appointment.create(
        [
          {
            date,
            time,
            service,
            user: user._id,
            status: "reserved",
            creditLotId: usedLotId,
            creditExpiresAt: usedLotExp,
          },
        ],
        { session }
      );

      const populated = await Appointment.findById(ap[0]._id)
        .populate("user", "name email")
        .session(session);

      out = serializeAppointment(populated);

      // mail (si no hay SMTP, tu mailer hace mock log)
      // ✅ Nota: esto debería enviar al usuario + admin si lo implementaste en mailer.
      try {
        await sendAppointmentBookedEmail(user, { date, time, service }, service);
      } catch (e) {
        console.log("[MAIL] booked error:", e?.message || e);
        // fallback admin log
        await sendAdminCopy({ kind: "booked", user, ap: { date, time, service } });
      }
    });

    return res.status(201).json(out);
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

    if (msg === "TOTAL_CAP_REACHED")
      return res.status(409).json({ error: "Se alcanzó el cupo total disponible para este horario." });

    if (msg === "SERVICE_ALREADY_TAKEN")
      return res.status(409).json({ error: "Ese servicio ya está ocupado en este horario." });

    if (msg === "EP_CAP_4")
      return res.status(409).json({
        error: "Se alcanzó el cupo de Entrenamiento Personal (máx 4 hasta 12hs antes).",
      });

    if (msg === "EP_CAP_TOTAL")
      return res.status(409).json({
        error: "Se alcanzó el cupo de Entrenamiento Personal para este horario.",
      });

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
   ✅ POST /appointments/batch
   - reserva múltiples turnos en 1 request
   - envía 1 solo mail batch
========================= */
router.post("/batch", async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) {
      return res.status(400).json({ error: "Faltan items: [{date,time,service}]." });
    }
    if (items.length > 12) {
      return res.status(400).json({ error: "Máximo 12 turnos por operación." });
    }

    // ✅ validación básica + evitar duplicados dentro del batch
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

      const key = `${date}__${time}__${service}`;
      if (seen.has(key)) {
        const e = new Error(`ITEM_${idx}_DUP`);
        e.http = 409;
        throw e;
      }
      seen.add(key);

      return { date, time, service, ...basic };
    });

    const userId = req.user._id || req.user.id;

    let result = [];

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

      // ✅ no permitir 2 reservas mismo date/time (aunque sean servicios distintos)
      const slotSet = new Set(normalized.map((x) => slotKey(x.date, x.time)));
      if (slotSet.size !== normalized.length) {
        const e = new Error("DUP_SLOT_IN_BATCH");
        e.http = 409;
        throw e;
      }

      // ✅ verificar que no tenga ya turnos en esos slots
      const orSlots = normalized.map((x) => ({ date: x.date, time: x.time }));
      const alreadyByUserAny = await Appointment.findOne({
        user: user._id,
        status: "reserved",
        $or: orSlots,
      })
        .session(session)
        .lean();

      if (alreadyByUserAny) throw new Error("ALREADY_HAVE_SLOT");

      // ✅ Traer reservas existentes de los slots involucrados
      const existing = await Appointment.find({
        status: "reserved",
        $or: orSlots,
      })
        .session(session)
        .lean();

      // index por slot
      const bySlot = new Map();
      for (const ap of existing) {
        const k = slotKey(ap.date, ap.time);
        if (!bySlot.has(k)) bySlot.set(k, []);
        bySlot.get(k).push(ap);
      }

      // ✅ Simular/validar cupos por slot considerando el batch
      for (const it of normalized) {
        const k = slotKey(it.date, it.time);
        const cur = bySlot.get(k) || [];

        // total cap
        if (cur.length >= TOTAL_CAP) {
          const e = new Error("TOTAL_CAP_REACHED");
          e.http = 409;
          throw e;
        }

        const epCount = cur.filter((a) => a.service === EP_NAME).length;
        const arTaken = cur.some((a) => a.service === "Alto Rendimiento") ? 1 : 0;
        const raTaken = cur.some((a) => a.service === "Rehabilitacion Activa") ? 1 : 0;
        const otherReservedCount = arTaken + raTaken;

        // otros servicios: 1 por servicio
        if (!it.isEpService) {
          const alreadyService = cur.some((a) => a.service === it.service);
          if (alreadyService) {
            const e = new Error("SERVICE_ALREADY_TAKEN");
            e.http = 409;
            throw e;
          }
        }

        // EP cap
        if (it.isEpService) {
          const hoursToStart = (it.slotDate.getTime() - Date.now()) / (1000 * 60 * 60);
          const epCap = calcEpCap({ hoursToStart, otherReservedCount });
          if (epCount >= epCap) {
            const e = new Error(hoursToStart > 12 ? "EP_CAP_4" : "EP_CAP_TOTAL");
            e.http = 409;
            throw e;
          }
        }

        // “agregar” el item al slot (simulación)
        cur.push({ date: it.date, time: it.time, service: it.service });
        bySlot.set(k, cur);
      }

      // ✅ consumir créditos + crear turnos
      result = [];

      for (const it of normalized) {
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
          [
            {
              date: it.date,
              time: it.time,
              service: it.service,
              user: user._id,
              status: "reserved",
              creditLotId: usedLotId,
              creditExpiresAt: usedLotExp,
            },
          ],
          { session }
        );

        const populated = await Appointment.findById(created[0]._id)
          .populate("user", "name email")
          .session(session);

        result.push(serializeAppointment(populated));
      }

      if (!isAdmin) {
        recalcUserCredits(user);
        await user.save({ session });
      }

      // ✅ 1 solo mail para todo el batch
      // 👉 Recomendación: en tu mailer hacé que este batch también copie al admin.
      try {
        await sendAppointmentBookedBatchEmail(user, result);
      } catch (e) {
        console.log("[MAIL] batch booked error:", e?.message || e);
        await sendAdminCopy({ kind: "batch_booked", user, ap: { items: result } });
      }
    });

    return res.status(201).json({ items: result });
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

    if (msg === "SERVICE_ALREADY_TAKEN")
      return res.status(409).json({ error: "Algún servicio ya está ocupado en ese horario." });

    if (msg === "EP_CAP_4")
      return res.status(409).json({
        error: "Se alcanzó el cupo de Entrenamiento Personal (máx 4 hasta 12hs antes).",
      });

    if (msg === "EP_CAP_TOTAL")
      return res.status(409).json({
        error: "Se alcanzó el cupo de Entrenamiento Personal para ese horario.",
      });

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
   PATCH /appointments/:id/cancel
   ✅ SIN LÍMITE DE CANCELACIONES
   ✅ DEVOLUCIÓN SOLO SI >= 12HS
========================= */
router.patch("/:id/cancel", async (req, res) => {
  const session = await mongoose.startSession();
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

      // ✅ no se puede cancelar un turno pasado
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

      // ✅ cancelamos siempre
      ap.status = "cancelled";
      await ap.save({ session });

      // ✅ devolver crédito SOLO si:
      // - no es admin
      // - y faltan >= 12 horas
      const shouldRefund = user.role !== "admin" && hours >= REFUND_CUTOFF_HOURS;

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
        .populate("user", "name email")
        .session(session);

      payload = {
        ...serializeAppointment(populated),
        refund: shouldRefund,
        refundCutoffHours: REFUND_CUTOFF_HOURS,
      };

      // mail cancel (si no hay SMTP => mock log)
      try {
        await sendAppointmentCancelledEmail(user, ap, ap.service);
      } catch (e) {
        console.log("[MAIL] cancelled error:", e?.message || e);
        await sendAdminCopy({ kind: "cancelled", user, ap });
      }
    });

    return res.json(payload);
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
      if (msg === "PAST_APPOINTMENT") return res.status(400).json({ error: "No se puede cancelar un turno que ya pasó." });
      if (msg === "USER_NOT_FOUND") return res.status(404).json({ error: "Usuario no encontrado." });
      return res.status(http).json({ error: "Error al cancelar el turno." });
    }

    return res.status(500).json({ error: "Error al cancelar el turno." });
  } finally {
    session.endSession();
  }
});

export default router;
