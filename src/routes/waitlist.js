// backend/src/routes/waitlist.js
import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";

import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import WaitlistEntry from "../models/WaitlistEntry.js";

import { protect } from "../middleware/auth.js";
import { fireAndForget } from "../mail.js";
import { sendWaitlistSlotAvailableEmail } from "../mail/appointmentEmails.js";

import { EP_NAME, analyzeSlot } from "../lib/slotCapacity.js";
import { serviceToKey, recalcUserCredits, pickLotToConsume } from "../lib/credits.js";

const router = express.Router();
router.use(protect);

/* =========================
   HELPERS
========================= */
function buildSlotDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [year, month, day] = String(dateStr).split("-").map(Number);
  const [hour, minute] = String(timeStr).split(":").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, hour || 0, minute || 0);
}

async function getReservedAtSlot({ date, time }, session = null) {
  const q = { date, time, status: "reserved" };
  const cur = session ? Appointment.find(q).session(session) : Appointment.find(q);
  return await cur.select("_id service user status date time").lean();
}

async function isEpSlotAvailable({ date, time }, session = null) {
  const slotDate = buildSlotDate(date, time);
  if (!slotDate) return { ok: false, error: "Fecha/hora inválida." };

  if (slotDate.getTime() < Date.now()) {
    return { ok: false, error: "El turno ya pasó." };
  }

  const existing = await getReservedAtSlot({ date, time }, session);
  const m = analyzeSlot(existing, slotDate);

  return { ok: true, slotDate, metrics: m, existing };
}

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function tokenExpiryForSlot(slotDate) {
  // válido hasta el comienzo del turno (o 48hs, lo que ocurra primero)
  const max48h = new Date(Date.now() + 48 * 60 * 60 * 1000);
  if (!slotDate) return max48h;
  return slotDate.getTime() < max48h.getTime() ? slotDate : max48h;
}

/* =========================
   GET /waitlist/mine
========================= */
router.get("/mine", async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;

    const list = await WaitlistEntry.find({
      user: userId,
      status: { $in: ["waiting", "notified"] },
    })
      .sort({ date: 1, time: 1 })
      .lean();

    res.json(
      (list || []).map((w) => ({
        id: w?._id?.toString?.() || String(w?._id || ""),
        date: w?.date,
        time: w?.time,
        service: w?.service,
        status: w?.status,
        notifiedAt: w?.notifiedAt || null,
        notifyToken: w?.notifyToken || "",
        notifyTokenExpiresAt: w?.notifyTokenExpiresAt || null,
      }))
    );
  } catch (e) {
    console.error("Error GET /waitlist/mine:", e);
    res.status(500).json({ error: "Error al obtener waitlist." });
  }
});

/* =========================
   GET /waitlist/claimable
   - Para mostrar modal SOLO si hay un turno notificado
     y ahora está disponible de verdad.
========================= */
router.get("/claimable", async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;

    // buscamos el "más cercano" notificado
    const w = await WaitlistEntry.findOne({
      user: userId,
      status: "notified",
      notifyToken: { $ne: "" },
      notifyTokenExpiresAt: { $gt: new Date() },
    })
      .sort({ date: 1, time: 1 })
      .lean();

    if (!w) return res.json({ item: null });

    const av = await isEpSlotAvailable({ date: w.date, time: w.time });

    if (!av.ok || !av.metrics?.epAvailableNow) {
      // si ya no hay disponibilidad, no mostramos modal
      return res.json({ item: null });
    }

    return res.json({
      item: {
        id: w?._id?.toString?.() || String(w?._id || ""),
        date: w.date,
        time: w.time,
        service: w.service,
        token: w.notifyToken,
        metrics: av.metrics,
      },
    });
  } catch (e) {
    console.error("Error GET /waitlist/claimable:", e);
    res.status(500).json({ error: "Error al verificar waitlist." });
  }
});

/* =========================
   POST /waitlist/claim
   body: { token }
   - crea turno EP y consume crédito recién acá
========================= */
router.post("/claim", async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const token = String(req.body?.token || "").trim();
    if (!token) return res.status(400).json({ error: "Falta token." });

    const userId = req.user?._id || req.user?.id;

    let payload = null;

    await session.withTransaction(async () => {
      const w = await WaitlistEntry.findOne({
        user: userId,
        status: "notified",
        notifyToken: token,
        notifyTokenExpiresAt: { $gt: new Date() },
      }).session(session);

      if (!w) {
        const e = new Error("TOKEN_INVALID");
        e.http = 404;
        throw e;
      }

      // ya tiene turno a esa hora
      const alreadyByUser = await Appointment.findOne({
        date: w.date,
        time: w.time,
        user: userId,
        status: "reserved",
      })
        .session(session)
        .lean();

      if (alreadyByUser) {
        const e = new Error("ALREADY_HAVE_SLOT");
        e.http = 409;
        throw e;
      }

      // disponibilidad REAL ahora
      const av = await isEpSlotAvailable({ date: w.date, time: w.time }, session);
      if (!av.ok || !av.metrics?.epAvailableNow) {
        const e = new Error("NOT_AVAILABLE");
        e.http = 409;
        throw e;
      }

      // consume crédito (no admin) - igual que /appointments
      const user = await User.findById(userId).session(session);
      if (!user) {
        const e = new Error("USER_NOT_FOUND");
        e.http = 403;
        throw e;
      }

      const isAdmin = user.role === "admin";

      function requiresApto(u) {
        if (!u?.createdAt) return false;
        const created = new Date(u.createdAt);
        const days = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
        return days > 20 && !u.aptoPath;
      }

      let usedLotId = null;
      let usedLotExp = null;

      if (!isAdmin) {
        if (user.suspended) {
          const e = new Error("USER_SUSPENDED");
          e.http = 403;
          throw e;
        }
        if (requiresApto(user)) {
          const e = new Error("APTO_REQUIRED");
          e.http = 403;
          throw e;
        }

        recalcUserCredits(user);
        if ((user.credits || 0) <= 0) {
          const e = new Error("NO_CREDITS");
          e.http = 403;
          throw e;
        }

        const sk = serviceToKey(EP_NAME);
        const lot = pickLotToConsume(user, sk);
        if (!lot) {
          const e = new Error("NO_CREDITS");
          e.http = 403;
          throw e;
        }

        lot.remaining = Number(lot.remaining || 0) - 1;
        usedLotId = lot._id;
        usedLotExp = lot.expiresAt || null;

        recalcUserCredits(user);

        user.history = user.history || [];
        user.history.push({
          action: "reservado",
          date: w.date,
          time: w.time,
          service: EP_NAME,
          createdAt: new Date(),
        });

        await user.save({ session });
      }

      const created = await Appointment.create(
        [
          {
            date: w.date,
            time: w.time,
            service: EP_NAME,
            user: user._id,
            status: "reserved",
            creditLotId: usedLotId,
            creditExpiresAt: usedLotExp,
          },
        ],
        { session }
      );

      // marcar waitlist como claimed
      w.status = "claimed";
      w.claimedAt = new Date();
      w.notifyToken = "";
      w.notifyTokenExpiresAt = null;
      await w.save({ session });

      payload = {
        id: created[0]?._id?.toString?.() || String(created[0]?._id || ""),
        date: created[0].date,
        time: created[0].time,
        service: created[0].service,
        status: created[0].status,
      };
    });

    res.json(payload);
  } catch (err) {
    const http = err?.http;
    const msg = String(err?.message || "");
    console.error("Error POST /waitlist/claim:", err);

    if (http) {
      if (msg === "TOKEN_INVALID") return res.status(404).json({ error: "Token inválido o vencido." });
      if (msg === "ALREADY_HAVE_SLOT") return res.status(409).json({ error: "Ya tenés un turno reservado en ese horario." });
      if (msg === "NOT_AVAILABLE") return res.status(409).json({ error: "Ese turno ya no está disponible." });
      if (msg === "USER_SUSPENDED") return res.status(403).json({ error: "Cuenta suspendida." });
      if (msg === "APTO_REQUIRED") return res.status(403).json({ error: "Cuenta suspendida por falta de apto médico." });
      if (msg === "NO_CREDITS") return res.status(403).json({ error: "Sin créditos disponibles." });
      return res.status(http).json({ error: "No se pudo confirmar el turno." });
    }

    res.status(500).json({ error: "Error al confirmar turno desde waitlist." });
  } finally {
    session.endSession();
  }
});

/* =========================
   UTIL: notificar un slot (la usa cancel y el scheduler)
========================= */
export async function notifyWaitlistForSlot({ date, time }) {
  try {
    const av = await isEpSlotAvailable({ date, time });
    if (!av.ok) return { ok: false, reason: av.error };
    if (!av.metrics?.epAvailableNow) return { ok: false, reason: "NO_ROOM" };

    const waiting = await WaitlistEntry.find({
      date,
      time,
      service: EP_NAME,
      status: "waiting",
    })
      .populate("user", "name lastName email")
      .lean();

    if (!waiting.length) return { ok: true, notified: 0 };

    const totalNotified = waiting.length;

    const bulk = waiting.map((w) => {
      const token = makeToken();
      return {
        updateOne: {
          filter: { _id: w._id, status: "waiting" },
          update: {
            $set: {
              status: "notified",
              notifiedAt: new Date(),
              notifyToken: token,
              notifyTokenExpiresAt: tokenExpiryForSlot(av.slotDate),
              lastNotifyError: "",
            },
          },
        },
        __user: w.user,
        __token: token,
      };
    });

    await WaitlistEntry.bulkWrite(bulk.map((b) => b.updateOne));

    // mails async (sin orden, a todos)
    fireAndForget(async () => {
      await Promise.all(
        bulk.map(async (b) => {
          const u = b.__user;
          const to = u?.email;
          if (!to) return;

          try {
            await sendWaitlistSlotAvailableEmail(
              u,
              { date, time, service: EP_NAME },
              { token: b.__token, totalNotified }
            );
          } catch (e) {
            console.log("[MAIL] waitlist notify error:", e?.message || e);
            await WaitlistEntry.updateOne(
              { user: u?._id, date, time, service: EP_NAME },
              { $set: { lastNotifyError: String(e?.message || e) } }
            );
          }
        })
      );
    }, "MAIL_WAITLIST_NOTIFY");

    return { ok: true, notified: totalNotified };
  } catch (e) {
    console.error("notifyWaitlistForSlot error:", e);
    return { ok: false, reason: "ERR" };
  }
}

export default router;
