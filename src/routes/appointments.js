// backend/src/routes/appointments.js
import express from "express";
import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

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

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addOneMonthExact(d) {
  const base = new Date(d);
  const day = base.getDate();

  const next = new Date(base);
  next.setDate(1);
  next.setMonth(next.getMonth() + 1);

  const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(day, lastDay));
  return next;
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
  // si está plus activo => 40, si no => 30 (como venías manejando)
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
  const [hStr] = time.split(":");
  const h = Number(hStr);

  if (h >= 7 && h <= 12) return "maniana";
  if (h >= 14 && h <= 17) return "tarde";
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
  try {
    const { date, time, service } = req.body || {};
    if (!date || !time || !service) {
      return res.status(400).json({ error: "Faltan campos: date, time y service." });
    }

    const turno = getTurnoFromTime(time);
    if (!turno) {
      return res.status(400).json({ error: "Horario fuera del rango permitido." });
    }

    // ✅ Sábado: 08..12
    if (isSaturday(date)) {
      const [hStr] = String(time).split(":");
      const h = Number(hStr);
      if (h < 8 || h > 12) {
        return res.status(400).json({
          error: "Los sábados solo se puede reservar de 08:00 a 12:00.",
        });
      }
    }

    const slotDate = buildSlotDate(date, time);
    if (!slotDate) return res.status(400).json({ error: "Fecha/hora inválida." });

    const diffMs = slotDate.getTime() - Date.now();
    const hoursToStart = diffMs / (1000 * 60 * 60);
    if (hoursToStart < 0) {
      return res.status(400).json({ error: "No se puede reservar un turno pasado." });
    }

    const isEpService = service === EP_NAME;

    // ✅ tarde: SOLO EP (regla dura)
    if (turno === "tarde" && !isEpService) {
      return res.status(409).json({
        error: "En el turno tarde solo está disponible Entrenamiento Personal.",
      });
    }

    // si llega un servicio que no conocemos:
    // lo tratamos como "otro" (1 cupo) pero sin permitir duplicarlo
    const treatAsOther = !isEpService;

    const userId = req.user._id || req.user.id;
    const user = await User.findById(userId);
    if (!user) return res.status(403).json({ error: "Usuario no encontrado." });

    const isAdmin = user.role === "admin";

    if (!isAdmin) {
      if (user.suspended) return res.status(403).json({ error: "Cuenta suspendida." });
      if (requiresApto(user))
        return res.status(403).json({ error: "Cuenta suspendida por falta de apto médico." });

      recalcUserCredits(user);
      if ((user.credits || 0) <= 0)
        return res.status(403).json({ error: "Sin créditos disponibles." });
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

    const existingAtSlot = await Appointment.find({
      date,
      time,
      status: "reserved",
    }).lean();

    const totalCount = existingAtSlot.length;
    if (totalCount >= TOTAL_CAP) {
      return res.status(409).json({
        error: "Se alcanzó el cupo total disponible para este horario.",
      });
    }

    const epCount = existingAtSlot.filter((a) => a.service === EP_NAME).length;
    const arTaken = existingAtSlot.some((a) => a.service === "Alto Rendimiento") ? 1 : 0;
    const raTaken = existingAtSlot.some((a) => a.service === "Rehabilitacion Activa") ? 1 : 0;

    const otherReservedCount = arTaken + raTaken;

    // ✅ Otros servicios: máximo 1 por servicio por hora
    if (treatAsOther) {
      const alreadyService = existingAtSlot.some((a) => a.service === service);
      if (alreadyService) {
        return res.status(409).json({ error: "Ese servicio ya está ocupado en este horario." });
      }
    }

    // ✅ EP cap rule
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
      const sk = serviceToKey(service); // EP/AR/RA/NUT

      const lot = pickLotToConsume(user, sk);
      if (!lot) {
        recalcUserCredits(user);
        return res.status(403).json({
          error: `No tenés créditos válidos para este servicio (${sk}).`,
        });
      }

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
        error: "Conflicto: ese turno o ese servicio ya fue reservado. Actualizá y probá de nuevo.",
      });
    }

    res.status(500).json({ error: "Error al crear el turno." });
  }
});

/* =========================
   PATCH /appointments/:id/cancel
   ✅ SIN LÍMITE DE CANCELACIONES
   ✅ DEVOLUCIÓN SOLO SI >= 12HS
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
      return res.status(403).json({
        error: "Solo el dueño del turno o un admin pueden cancelarlo.",
      });
    }

    if (ap.status === "cancelled") {
      return res.status(400).json({ error: "El turno ya estaba cancelado." });
    }

    const apDate = buildSlotDate(ap.date, ap.time);
    if (!apDate) return res.status(400).json({ error: "Turno con fecha/hora inválida." });

    const diffMs = apDate.getTime() - Date.now();
    const hours = diffMs / (1000 * 60 * 60);

    // ✅ no se puede cancelar un turno pasado
    if (hours < 0) {
      return res.status(400).json({ error: "No se puede cancelar un turno que ya pasó." });
    }

    const user = await User.findById(ap.user);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    // ✅ cancelamos siempre
    ap.status = "cancelled";
    await ap.save();

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
      await user.save();
    }

    const populated = await Appointment.findById(ap._id).populate("user", "name email");
    return res.json({
      ...serializeAppointment(populated),
      refund: shouldRefund,
      refundCutoffHours: REFUND_CUTOFF_HOURS,
    });
  } catch (err) {
    console.error("Error en PATCH /appointments/:id/cancel:", err);
    return res.status(500).json({ error: "Error al cancelar el turno." });
  }
});

export default router;
  