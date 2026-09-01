// backend/src/jobs/startWaitlist.js
import WaitlistEntry from "../models/WaitlistEntry.js";
import { notifyWaitlistForSlot } from "../routes/waitlist.js";

/**
 * Scheduler:
 * - Revisa periódicamente slots/servicios con gente esperando.
 * - La disponibilidad real la resuelve waitlist.js con el catálogo dinámico.
 * - No escribe reservas ni consume créditos; solo notifica.
 */
export function startWaitlistScheduler({ everyMinutes = 2 } = {}) {
  const mins = Math.max(1, Number(everyMinutes || 2));
  console.log("[WAITLIST] scheduler start", { everyMinutes: mins });

  async function tick() {
    try {
      const slots = await WaitlistEntry.aggregate([
        { $match: { status: "waiting" } },
        {
          $group: {
            _id: {
              date: "$date",
              time: "$time",
              serviceKey: "$serviceKey",
            },
          },
        },
        { $limit: 300 },
      ]);

      for (const item of slots) {
        const date = item?._id?.date;
        const time = item?._id?.time;
        const serviceKey = item?._id?.serviceKey;

        if (!date || !time || !serviceKey) continue;

        await notifyWaitlistForSlot({
          date,
          time,
          serviceKey,
        });
      }
    } catch (e) {
      console.log("[WAITLIST] tick error:", e?.message || e);
    }
  }

  setTimeout(tick, 1500);
  setInterval(tick, mins * 60 * 1000);
}
