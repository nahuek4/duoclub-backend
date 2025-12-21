// backend/src/routes/appointments.js
import express from "express";
import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

/* =========================
   HELPERS: membresía + créditos
   ========================= */

function nowDate() {
  return new Date();
}

function getMembershipEffective(user) {
  const m = user?.membership || {};
  const now = nowDate();

  // si plus venció, vuelve a basic
  const plusActive = m.tier === "plus" && m.activeUntil && new Date(m.activeUntil) > now;

  if (plusActive) {
    return {
      tier: "plus",
      cancelHours: Number(m.cancelHours || 12),
      cancelsLeft: Number(m.cancelsLeft ?? 2),
      creditsExpireDays: Number(m.creditsExpireDays || 40),
      activeUntil: m.activeUntil,
    };
  }

  // basic
  return {
    tier: "basic",
    cancelHours: 24,
    cancelsLeft: Number(m.cancelsLeft ?? 1),
    creditsExpireDays: 30,
    activeUntil: null,
  };
}

function recalcUserCredits(user) {
  const now = nowDate();
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];

  const sum = lots.reduce((acc, lot) => {
    const exp = lot.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return acc;
    return acc + Number(lot.remaining || 0);
  }, 0);

  user.credits = sum; // cache para UI
}

function pickLotToConsume(user) {
  const now = nowDate();
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];

  // ordenar por expiresAt/createdAt para consumir lo más viejo primero
  const sorted = lots
    .filter((l) => Number(l.remaining || 0) > 0)
    .filter((l) => !l.expiresAt || new Date(l.expiresAt) > now)
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

/* =========================
   Normaliza turno para el frontend
   ========================= */
function serializeAppointment(ap) {
  const json = ap.toObject ? ap.toObject() : ap;

  const userObj = json.user || {};
  const userId = userObj._id?.toString?.() || json.userId || userObj.toString?.() || "";

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

/* =========================
   Reglas existentes
   ========================= */

function requiresApto(user) {
  if (!user?.createdAt) return false;
  const created = new Date(user.createdAt);
  const days = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
  return days > 20 && !user.aptoPath;
}

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

// Equilibrador
const TOTAL_CAP = 7;
const EP_KEY = "Entrenamiento Personal";
const OTHER_SERVICES = new Set(["Reeducacion Funcional", "Rehabilitacion Activa", "Alto Rendimiento"]);

function calcEpCap({ hoursToStart, otherReservedCount }) {
  const base = hoursToStart > 12 ? 4 : 7;
  const dynamic = TOTAL_CAP - otherReservedCount;
  return Math.max(0, Math.min(base, dynamic));
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

    const list = await Appointment.find(query).populate("user", "name email").lean();
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
   descuenta 1 crédito desde lotes
   ========================= */
router.post("/", async (req, res) => {
  try {
    const { date, time, service } = req.body || {};
    if (!date || !time || !service) {
      return res.status(400).json({ error: "Faltan campos: date, time y service." });
    }

    const turno = getTurnoFromTime(time);
    if (!turno) return res.status(400).json({ error: "Horario fuera del rango permitido." });

    const slotDate = buildSlotDate(date, time);
    if (!slotDate) return res.status(400).json({ error: "Fecha/hora inválida." });

    const diffMs = slotDate.getTime() - Date.now();
    const hoursToStart = diffMs / (1000 * 60 * 60);
    if (hoursToStart < 0) return res.status(400).json({ error: "No se puede reservar un turno pasado." });

    const isEpService = service === EP_KEY;
    const treatAsOther = !isEpService;

    const userId = req.user._id || req.user.id;
    const user = await User.findById(userId);
    if (!user) return res.status(403).json({ error: "Usuario no encontrado." });

    const isAdmin = user.role === "admin";

    // Reglas para clientes
    if (!isAdmin) {
      if (user.suspended) return res.status(403).json({ error: "Cuenta suspendida." });
      if (requiresApto(user)) return res.status(403).json({ error: "Cuenta suspendida por falta de apto médico." });

      // ✅ créditos por lotes
      recalcUserCredits(user);
      if ((user.credits || 0) <= 0) return res.status(403).json({ error: "Sin créditos disponibles." });
    }

    // ya tiene turno a esa hora
    const alreadyByUser = await Appointment.findOne({
      date,
      time,
      user: user._id,
      status: "reserved",
    }).lean();

    if (alreadyByUser) {
      return res.status(409).json({ error: "Ya tenés un turno reservado en ese horario." });
    }

    // cupos slot
    const existingAtSlot = await Appointment.find({ date, time, status: "reserved" }).lean();

    const totalCount = existingAtSlot.length;
    const epCount = existingAtSlot.filter((a) => a.service === EP_KEY).length;
    const otherReservedCount = totalCount - epCount;

    if (totalCount >= TOTAL_CAP) {
      return res.status(409).json({ error: "Se alcanzó el cupo total disponible para este horario." });
    }

    if (treatAsOther) {
      const alreadyService = existingAtSlot.some((a) => a.service === service);
      if (alreadyService) return res.status(409).json({ error: "Ese servicio ya está ocupado en este horario." });
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

    // ✅ consumir crédito desde lote (solo clientes)
    let usedLotId = null;
    let usedLotExp = null;

    if (!isAdmin) {
      const lot = pickLotToConsume(user);
      if (!lot) {
        recalcUserCredits(user);
        return res.status(403).json({ error: "Sin créditos disponibles (o vencidos)." });
      }

      lot.remaining = Number(lot.remaining || 0) - 1;
      usedLotId = lot._id;
      usedLotExp = lot.expiresAt || null;

      recalcUserCredits(user);
      user.history = user.history || [];
      user.history.push({ action: "reservado", date, time, service, createdAt: new Date() });

      await user.save();
    }

    const ap = await Appointment.create({
      date,
      time,
      service,
      user: user._id,
      status: "reserved",
      creditLotId: usedLotId,
      creditExpiresAt: usedLotExp,
    });

    const populated = await Appointment.findById(ap._id).populate("user", "name email");
    res.status(201).json(serializeAppointment(populated));
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

/* =========================
   PATCH /appointments/:id/cancel
   - respeta 12/24hs según membresía
   - consume cancelsLeft
   - devuelve crédito al mismo lote (si no venció)
   ========================= */
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

    const apDate = buildSlotDate(ap.date, ap.time);
    if (!apDate) return res.status(400).json({ error: "Turno con fecha/hora inválida." });

    const diffMs = apDate.getTime() - Date.now();
    const hours = diffMs / (1000 * 60 * 60);

    // para clientes: regla 12/24hs y cancelsLeft
    const user = await User.findById(ap.user);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!isAdmin) {
      const mem = getMembershipEffective(user);

      // si plus venció, forzamos basic defaults
      if (mem.tier === "basic") {
        user.membership = user.membership || {};
        user.membership.tier = "basic";
        user.membership.activeUntil = null;
        user.membership.cancelHours = 24;
        user.membership.creditsExpireDays = 30;
        if (user.membership.cancelsLeft == null) user.membership.cancelsLeft = 1;
      }

      const cancelHours = Number(mem.cancelHours || 24);
      if (hours < cancelHours) {
        return res.status(400).json({
          error: `Solo podés cancelar hasta ${cancelHours} horas antes del turno.`,
        });
      }

      // límite de cancelaciones
      const left = Number(user.membership?.cancelsLeft ?? (mem.tier === "plus" ? 2 : 1));
      if (left <= 0) {
        return res.status(400).json({
          error: "No tenés cancelaciones disponibles en este período.",
        });
      }

      user.membership.cancelsLeft = left - 1;
    }

    // cancelar turno
    ap.status = "cancelled";
    await ap.save();

    // ✅ devolver crédito si era cliente (no admin)
    if (user.role !== "admin") {
      const now = nowDate();

      // buscar lote original
      const lot = ap.creditLotId ? findLotById(user, ap.creditLotId) : null;

      if (lot) {
        const exp = lot.expiresAt ? new Date(lot.expiresAt) : null;

        // devolvemos solo si no venció
        if (!exp || exp > now) {
          lot.remaining = Number(lot.remaining || 0) + 1;
        }
      } else {
        // fallback (si no hay lote guardado): devolvemos a un lote "refund" con vencimiento según membresía actual
        const mem = getMembershipEffective(user);
        const exp = new Date(now);
        exp.setDate(exp.getDate() + Number(mem.creditsExpireDays || 30));

        user.creditLots = user.creditLots || [];
        user.creditLots.push({
          amount: 1,
          remaining: 1,
          expiresAt: exp,
          source: "refund",
          orderId: null,
          createdAt: now,
        });
      }

      user.history = user.history || [];
      user.history.push({
        action: "cancelado",
        date: ap.date,
        time: ap.time,
        service: ap.service,
        createdAt: new Date(),
      });

      recalcUserCredits(user);
      await user.save();
    }

    const populated = await Appointment.findById(ap._id).populate("user", "name email");
    return res.json(serializeAppointment(populated));
  } catch (err) {
    console.error("Error en PATCH /appointments/:id/cancel:", err);
    return res.status(500).json({ error: "Error al cancelar el turno." });
  }
});

export default router;
