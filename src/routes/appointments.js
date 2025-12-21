import express from "express";
import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

/**
 * Normaliza un turno para el frontend
 */
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
    date: json.date, // "YYYY-MM-DD"
    time: json.time, // "HH:mm"
    service: json.service || "",
    status: json.status || "reserved",
    coach: json.coach || "",
    userId,
    userName: userObj.name || "",
    userEmail: userObj.email || "",
  };
}

/**
 * ¿El usuario necesita apto y no lo tiene?
 * Regla: si pasaron > 20 días desde createdAt y no tiene aptoPath => requiere apto.
 */
function requiresApto(user) {
  if (!user?.createdAt) return false;
  const created = new Date(user.createdAt);
  const days = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
  return days > 20 && !user.aptoPath;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isPlusActive(user) {
  const exp = user?.plus?.expiresAt ? new Date(user.plus.expiresAt) : null;
  if (!user?.plus?.active) return false;
  if (!exp) return true;
  return exp.getTime() > Date.now();
}

async function ensureCancelPeriod(user) {
  const start = user.cancelationsPeriodStart ? new Date(user.cancelationsPeriodStart) : null;
  if (!start) {
    user.cancelationsPeriodStart = new Date();
    user.cancelationsUsed = 0;
    await user.save();
    return;
  }

  const diffDays = (Date.now() - start.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays >= 30) {
    user.cancelationsPeriodStart = new Date();
    user.cancelationsUsed = 0;
    await user.save();
  }
}

/**
 * Determina el turno según la hora
 */
function getTurnoFromTime(time) {
  if (!time) return "";
  const [hStr] = time.split(":");
  const h = Number(hStr);
  if (h >= 7 && h < 13) return "maniana";
  if (h >= 14 && h < 18) return "tarde";
  if (h >= 18 && h <= 20) return "noche";
  return "";
}

function buildSlotDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, hour || 0, minute || 0);
}

/**
 * ✅ Equilibrador (regla final)
 */
const TOTAL_CAP = 7;
const EP_KEY = "Entrenamiento Personal";
const OTHER_SERVICES = new Set([
  "Reeducacion Funcional",
  "Rehabilitacion Activa",
  "Alto Rendimiento",
]);

function calcEpCap({ hoursToStart, otherReservedCount }) {
  const base = hoursToStart > 12 ? 4 : 7;
  const dynamic = TOTAL_CAP - otherReservedCount;
  return Math.max(0, Math.min(base, dynamic));
}

/**
 * GET /appointments?from=YYYY-MM-DD&to=YYYY-MM-DD
 * 🔓 RUTA PÚBLICA
 */
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

/**
 * ⛔ A partir de acá, TODO requiere estar logueado
 */
router.use(protect);

/**
 * POST /appointments
 */
router.post("/", async (req, res) => {
  try {
    const { date, time, service } = req.body || {};

    if (!date || !time || !service) {
      return res.status(400).json({
        error: "Faltan campos: date, time y service son obligatorios.",
      });
    }

    const turno = getTurnoFromTime(time);
    if (!turno) {
      return res.status(400).json({ error: "Horario fuera del rango permitido para turnos." });
    }

    const slotDate = buildSlotDate(date, time);
    if (!slotDate) return res.status(400).json({ error: "Fecha/hora inválida." });

    const diffMs = slotDate.getTime() - Date.now();
    const hoursToStart = diffMs / (1000 * 60 * 60);

    if (hoursToStart < 0) {
      return res.status(400).json({ error: "No se puede reservar un turno pasado." });
    }

    // ✅ (Opcional) Reserva solo dentro de 31 días (para ambos: “reservas para todo el mes”)
    // Si querés más, subimos el número.
    const maxDate = addDays(new Date(), 31).getTime();
    if (slotDate.getTime() > maxDate) {
      return res.status(400).json({
        error: "Podés reservar hasta 31 días en adelante.",
      });
    }

    const isEpService = service === EP_KEY;
    const treatAsOther = !isEpService;

    const userId = req.user._id || req.user.id;
    const user = await User.findById(userId);

    if (!user) return res.status(403).json({ error: "Usuario no encontrado." });

    const isAdmin = user.role === "admin";

    if (!isAdmin) {
      // si el PLUS venció, lo apagamos (limpio)
      if (user.plus?.active && user.plus?.expiresAt) {
        const exp = new Date(user.plus.expiresAt).getTime();
        if (exp <= Date.now()) {
          user.plus.active = false;
          await user.save();
        }
      }

      if (user.suspended) return res.status(403).json({ error: "Cuenta suspendida." });

      if (requiresApto(user)) {
        return res.status(403).json({ error: "Cuenta suspendida por falta de apto médico." });
      }

      if ((user.credits || 0) <= 0) {
        return res.status(403).json({ error: "Sin créditos disponibles." });
      }
    }

    const alreadyByUser = await Appointment.findOne({
      date,
      time,
      user: user._id,
      status: "reserved",
    }).lean();

    if (alreadyByUser) {
      return res.status(409).json({ error: "Ya tenés un turno reservado en ese horario." });
    }

    const existingAtSlot = await Appointment.find({
      date,
      time,
      status: "reserved",
    }).lean();

    const totalCount = existingAtSlot.length;
    const epCount = existingAtSlot.filter((a) => a.service === EP_KEY).length;
    const otherReservedCount = totalCount - epCount;

    if (totalCount >= TOTAL_CAP) {
      return res.status(409).json({ error: "Se alcanzó el cupo total disponible para este horario." });
    }

    if (treatAsOther) {
      const alreadyService = existingAtSlot.some((a) => a.service === service);
      if (alreadyService) {
        return res.status(409).json({ error: "Ese servicio ya está ocupado en este horario." });
      }
    }

    if (isEpService) {
      const epCap = calcEpCap({ hoursToStart, otherReservedCount });
      if (epCount >= epCap) {
        return res.status(409).json({
          error:
            hoursToStart > 12
              ? "Se alcanzó el cupo de Entrenamiento Personal (máx 4 hasta 12hs antes)."
              : "Se alcanzó el cupo de Entrenamiento Personal para este horario.",
        });
      }
    }

    const ap = await Appointment.create({
      date,
      time,
      service,
      user: user._id,
      status: "reserved",
    });

    if (!isAdmin) {
      user.credits = (user.credits || 0) - 1;
      user.history = user.history || [];
      user.history.push({
        action: "reservado",
        date,
        time,
        service,
        createdAt: new Date(),
      });
      await user.save();
    }

    res.status(201).json(serializeAppointment(ap));
  } catch (err) {
    console.error("Error en POST /appointments:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        error: "Ese turno ya fue reservado (conflicto). Actualizá y probá de nuevo.",
      });
    }

    res.status(500).json({ error: "Error al crear el turno." });
  }
});

/**
 * PATCH /appointments/:id/cancel
 * Cancela turno (solo dueño o admin)
 */
router.patch("/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params;

    const ap = await Appointment.findById(id);
    if (!ap) return res.status(404).json({ error: "Turno no encontrado." });

    const tokenUserId = req.user._id || req.user.id;
    const isOwner = ap.user?.toString?.() === String(tokenUserId);
    const isAdmin = req.user.role === "admin";

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: "Solo el dueño del turno o un admin pueden cancelarlo." });
    }

    if (ap.status === "cancelled") {
      return res.status(400).json({ error: "El turno ya estaba cancelado." });
    }

    // Chequeo anticipo (PLUS 12hs / normal 24hs)
    const apDate = buildSlotDate(ap.date, ap.time);
    if (!apDate) return res.status(400).json({ error: "Fecha/hora inválida." });

    const hours = (apDate.getTime() - Date.now()) / (1000 * 60 * 60);

    // buscamos al usuario dueño para validar PLUS y cancelaciones
    const apUser = await User.findById(ap.user);
    if (!apUser) return res.status(404).json({ error: "Usuario no encontrado." });

    // si venció PLUS, lo apagamos
    if (apUser.plus?.active && apUser.plus?.expiresAt) {
      const exp = new Date(apUser.plus.expiresAt).getTime();
      if (exp <= Date.now()) {
        apUser.plus.active = false;
        await apUser.save();
      }
    }

    const plusActive = isPlusActive(apUser);

    const minHours = plusActive ? 12 : 24;
    if (hours < minHours && !isAdmin) {
      return res.status(400).json({
        error: plusActive
          ? "Solo podés cancelar hasta 12 horas antes del turno (DUO+)."
          : "Solo podés cancelar hasta 24 horas antes del turno.",
      });
    }

    // ✅ Ventana de cancelaciones (30 días)
    if (!isAdmin && apUser.role !== "admin") {
      await ensureCancelPeriod(apUser);

      const limit = plusActive ? 2 : 1;
      const used = Number(apUser.cancelationsUsed || 0);

      if (used >= limit) {
        return res.status(400).json({
          error: plusActive
            ? "Alcanzaste el límite de 2 cancelaciones en los últimos 30 días (DUO+)."
            : "Alcanzaste el límite de 1 cancelación en los últimos 30 días.",
        });
      }

      apUser.cancelationsUsed = used + 1;
      await apUser.save();
    }

    // cancelar
    ap.status = "cancelled";
    await ap.save();

    // devolver crédito al dueño si no es admin
    if (apUser.role !== "admin") {
      apUser.credits = (apUser.credits || 0) + 1;
      apUser.history = apUser.history || [];
      apUser.history.push({
        action: "cancelado",
        date: ap.date,
        time: ap.time,
        service: ap.service,
        createdAt: new Date(),
      });
      await apUser.save();
    }

    res.json(serializeAppointment(ap));
  } catch (err) {
    console.error("Error en PATCH /appointments/:id/cancel:", err);
    res.status(500).json({ error: "Error al cancelar el turno." });
  }
});

export default router;
