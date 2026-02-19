// backend/src/jobs/startWaitlist.js
import WaitlistEntry from "../models/WaitlistEntry.js";
import { notifyWaitlistForSlot } from "../routes/waitlist.js";

/**
 * Scheduler:
 * - Revisa periódicamente si hay slots con gente esperando (status=waiting)
 * - Si el slot tiene disponibilidad REAL (según reglas), notifica a TODOS y les genera token.
 * - No hay orden: se notifica a todos juntos, como pediste.
 *
 * Nota:
 * - Para evitar spam, una vez notificado pasa a status="notified".
 * - El claim consume crédito recién cuando el usuario confirma.
 */
export function startWaitlistScheduler({ everyMinutes = 2 } = {}) {
  const mins = Math.max(1, Number(everyMinutes || 2));
  console.log("[WAITLIST] scheduler start", { everyMinutes: mins });

  async function tick() {
    try {
      // agarramos slots únicos con waiting
      const slots = await WaitlistEntry.aggregate([
        { $match: { status: "waiting" } },
        { $group: { _id: { date: "$date", time: "$time" } } },
        { $limit: 200 }, // seguridad
      ]);

      for (const s of slots) {
        const date = s?._id?.date;
        const time = s?._id?.time;
        if (!date || !time) continue;

        // notifyWaitlistForSlot ya valida disponibilidad real + crea tokens + manda mails
        await notifyWaitlistForSlot({ date, time });
      }
    } catch (e) {
      console.log("[WAITLIST] tick error:", e?.message || e);
    }
  }

  // primer tick pronto
  setTimeout(tick, 1500);

  // luego cada N minutos
  setInterval(tick, mins * 60 * 1000);
}
