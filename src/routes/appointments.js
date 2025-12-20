// backend/src/routes/appointments.js
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
    // 👇 estos dos son los que usa AdminTurnos
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
  const days = Math.floor(
    (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24)
  );
  return days > 20 && !user.aptoPath;
}

/**
 * Determina el turno según la hora
 * - "maniana" (07–12)
 * - "tarde"   (14–17)
 * - "noche"   (18–20)
 * - ""        si está fuera de rango
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
 * Capacidad total del horario: 7
 *
 * Servicios:
 * - EP = "Entrenamiento Personal"
 * - Otros (RF/RA/AR) tienen cupo 1 cada uno (si se reservó, desaparece)
 *
 * Regla EP:
 * - Si faltan > 12hs para el horario: EP máx 4 (pero nunca supera 7 - otrosReservados)
 * - Si faltan <= 12hs: EP máx = 7 - otrosReservados
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
  const dynamic = TOTAL_CAP - otherReservedCount; // lo que queda libre si los otros ya ocuparon
  return Math.max(0, Math.min(base, dynamic));
}

/**
 * GET /appointments?from=YYYY-MM-DD&to=YYYY-MM-DD
 * 🔓 RUTA PÚBLICA: lista turnos por rango de fechas
 */
router.get("/", async (req, res) => {
  try {
    const { from, to } = req.query || {};
    const query = {};

    if (from && to) {
      // [from, to)  (to excluido)
      query.date = { $gte: from, $lt: to };
    } else if (from) {
      query.date = { $gte: from };
    }

    const list = await Appointment.find(query)
      .populate("user", "name email")
      .lean();

    const normalized = list.map(serializeAppointment);
    res.json(normalized);
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
 * body: { date, time, service }
 *
 * ✅ Blindado por backend con el “equilibrador”.
 */
router.post("/", async (req, res) => {
  try {
    const { date, time, service } = req.body || {};

    if (!date || !time || !service) {
      return res.status(400).json({
        error: "Faltan campos: date, time y service son obligatorios.",
      });
    }

    // Determinar turno a partir de la hora
    const turno = getTurnoFromTime(time);
    if (!turno) {
      return res.status(400).json({
        error: "Horario fuera del rango permitido para turnos.",
      });
    }

    const slotDate = buildSlotDate(date, time);
    if (!slotDate) {
      return res.status(400).json({ error: "Fecha/hora inválida." });
    }

    const diffMs = slotDate.getTime() - Date.now();
    const hoursToStart = diffMs / (1000 * 60 * 60);

    if (hoursToStart < 0) {
      return res.status(400).json({ error: "No se puede reservar un turno pasado." });
    }

    const isEpService = service === EP_KEY;
    const isOtherService = OTHER_SERVICES.has(service);

    // Si llega un service que no está en tu set permitido, lo dejamos igual (por compat),
    // pero lo tratamos como "otro" con cupo 1 (así no rompe la lógica)
    const treatAsOther = !isEpService;

    // Usuario del token
    const userId = req.user._id || req.user.id;
    const user = await User.findById(userId);

    if (!user) {
      return res.status(403).json({ error: "Usuario no encontrado." });
    }

    const isAdmin = user.role === "admin";

    // Reglas SOLO para clientes
    if (!isAdmin) {
      if (user.suspended) {
        return res.status(403).json({ error: "Cuenta suspendida." });
      }

      if (requiresApto(user)) {
        return res.status(403).json({
          error: "Cuenta suspendida por falta de apto médico.",
        });
      }

      if ((user.credits || 0) <= 0) {
        return res.status(403).json({
          error: "Sin créditos disponibles.",
        });
      }
    }

    // ⛔ Evitar que el mismo usuario reserve 2 servicios en el mismo date+time (status reserved)
    // (Admin lo dejamos pasar si querés, pero por defecto también lo bloqueamos para que sea consistente)
    const alreadyByUser = await Appointment.findOne({
      date,
      time,
      user: user._id,
      status: "reserved",
    }).lean();

    if (alreadyByUser) {
      return res.status(409).json({
        error: "Ya tenés un turno reservado en ese horario.",
      });
    }

    // 📊 Tomamos todos los reservados del slot
    const existingAtSlot = await Appointment.find({
      date,
      time,
      status: "reserved",
    }).lean();

    const totalCount = existingAtSlot.length;

    const epCount = existingAtSlot.filter((a) => a.service === EP_KEY).length;

    // otros = cualquier cosa que NO sea EP (así incluye RF/RA/AR y también futuros servicios)
    const otherReservedCount = totalCount - epCount;

    // Regla cupo total
    if (totalCount >= TOTAL_CAP) {
      return res.status(409).json({
        error: "Se alcanzó el cupo total disponible para este horario.",
      });
    }

    // Regla: servicios no-EP cupo 1 c/u (si ya hay uno de ese service, no entra)
    if (treatAsOther) {
      const alreadyService = existingAtSlot.some((a) => a.service === service);
      if (alreadyService) {
        return res.status(409).json({
          error: "Ese servicio ya está ocupado en este horario.",
        });
      }
    }

    // ✅ Regla equilibrador para EP
    if (isEpService) {
      const epCap = calcEpCap({ hoursToStart, otherReservedCount });

      if (epCount >= epCap) {
        // antes de 12hs => cap 4 (o menos si otros ya reservaron)
        // después de 12hs => cap 7 - otrosReservados
        return res.status(409).json({
          error:
            hoursToStart > 12
              ? "Se alcanzó el cupo de Entrenamiento Personal (máx 4 hasta 12hs antes)."
              : "Se alcanzó el cupo de Entrenamiento Personal para este horario.",
        });
      }
    }

    // ✅ Si llegamos hasta acá, hay cupo => creamos el turno
    const ap = await Appointment.create({
      date,
      time,
      service,
      user: user._id,
      status: "reserved",
    });

    // Resta 1 crédito SOLO a clientes
    if (!isAdmin) {
      user.credits = (user.credits || 0) - 1;

      // Historial en el user (si existiera)
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
        error:
          "Ese turno ya fue reservado (conflicto). Actualizá y probá de nuevo.",
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
    if (!ap) {
      return res.status(404).json({ error: "Turno no encontrado." });
    }

    const tokenUserId = req.user._id || req.user.id;
    const isOwner = ap.user?.toString?.() === String(tokenUserId);
    const isAdmin = req.user.role === "admin";

    if (!isOwner && !isAdmin) {
      return res
        .status(403)
        .json({ error: "Solo el dueño del turno o un admin pueden cancelarlo." });
    }

    if (ap.status === "cancelled") {
      return res.status(400).json({ error: "El turno ya estaba cancelado." });
    }

    // Chequeo 24hs (clientes); admin puede siempre
    const [year, month, day] = ap.date.split("-").map(Number);
    const [hour, minute] = (ap.time || "00:00").split(":").map(Number);
    const apDate = new Date(year, month - 1, day, hour || 0, minute || 0);
    const diffMs = apDate.getTime() - Date.now();
    const hours = diffMs / (1000 * 60 * 60);

    if (hours < 24 && !isAdmin) {
      return res.status(400).json({
        error: "Solo podés cancelar hasta 24 horas antes del turno.",
      });
    }

    ap.status = "cancelled";
    await ap.save();

    // Devolvemos crédito al dueño del turno si NO es admin
    const apUser = await User.findById(ap.user);
    if (apUser && apUser.role !== "admin") {
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
