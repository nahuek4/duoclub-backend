// backend/src/routes/appointments.js
import express from "express";
import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

// Todas las rutas requieren estar logueado
router.use(protect);

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
    date: json.date,              // "YYYY-MM-DD"
    time: json.time,              // "HH:mm"
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
 * GET /appointments?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Lista turnos por rango de fechas
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
      .populate("user", "name email") // 👈 acá traemos nombre y mail
      .lean();

    const normalized = list.map(serializeAppointment);
    res.json(normalized);
  } catch (err) {
    console.error("Error en GET /appointments:", err);
    res.status(500).json({ error: "Error al obtener turnos." });
  }
});

/**
 * POST /appointments
 * body: { date, time, service }
 *
 * - Chequea créditos / apto / suspensión SOLO para clientes.
 * - Admin puede reservar sin restricciones de créditos/apto.
 * - Resta 1 crédito a cliente al reservar.
 * - Usa el índice único del schema para evitar duplicados (date+time+service+status=reserved).
 */
router.post("/", async (req, res) => {
  try {
    const { date, time, service } = req.body || {};

    if (!date || !time || !service) {
      return res.status(400).json({
        error: "Faltan campos: date, time y service son obligatorios.",
      });
    }

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

    // Creamos el turno
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

      // Historial en el user
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

    // Error de índice único (slot ya reservado)
    if (err?.code === 11000) {
      return res
        .status(409)
        .json({ error: "Ese servicio en ese horario ya está reservado." });
    }

    res.status(500).json({ error: "Error al crear el turno." });
  }
});

/**
 * PATCH /appointments/:id/cancel
 * Cancela turno (solo dueño o admin)
 *
 * - Si cliente cancela con >24h: se marca "cancelled" y se devuelve 1 crédito.
 * - Admin puede cancelar siempre y también devuelve 1 crédito al dueño
 *   (si el dueño no es admin).
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

    // Marcamos como cancelado
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
