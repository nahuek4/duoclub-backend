// backend/src/jobs/startWaitlist.js
import WaitlistEntry from "../models/WaitlistEntry.js";
import { notifyWaitlistForSlot } from "../routes/waitlist.js";

/**
 * Scheduler de sala de espera.
 *
 * - Agrupa por fecha + hora + servicio.
 * - Procesa primero el grupo cuyo usuario lleva más tiempo esperando.
 * - notifyWaitlistForSlot valida el cupo general de TRAINING/PERFORMANCE,
 *   el límite individual del servicio y los tokens vigentes ya ofrecidos.
 * - Un token vigente cuenta temporalmente contra la vacante para evitar
 *   notificar a dos servicios de PERFORMANCE por el mismo lugar libre.
 */
export function startWaitlistScheduler({ everyMinutes = 2 } = {}) {
  const mins = Math.max(1, Number(everyMinutes || 2));
  console.log("[WAITLIST] scheduler start", { everyMinutes: mins });

  async function tick() {
    try {
      const slots = await WaitlistEntry.aggregate([
        { $match: { status: "waiting" } },
        { $sort: { priorityOrder: 1, createdAt: 1 } },
        {
          $group: {
            _id: {
              date: "$date",
              time: "$time",
              serviceKey: "$serviceKey",
            },
            firstCreatedAt: { $first: "$createdAt" },
            firstPriorityOrder: { $first: "$priorityOrder" },
          },
        },
        { $sort: { firstPriorityOrder: 1, firstCreatedAt: 1 } },
        { $limit: 300 },
      ]);

      for (const s of slots) {
        const date = s?._id?.date;
        const time = s?._id?.time;
        const serviceKey = String(s?._id?.serviceKey || "").toUpperCase().trim();

        if (!date || !time || !serviceKey) continue;

        // Secuencial a propósito: cada notificación genera un token vigente y la
        // siguiente iteración ya lo cuenta como lugar ofrecido del pool compartido.
        await notifyWaitlistForSlot({ date, time, serviceKey });
      }
    } catch (e) {
      console.log("[WAITLIST] tick error:", e?.message || e);
    }
  }

  setTimeout(tick, 1500);
  setInterval(tick, mins * 60 * 1000);
}
