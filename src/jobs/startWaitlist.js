// backend/src/jobs/startWaitlist.js
import WaitlistEntry from "../models/WaitlistEntry.js";
import { notifyWaitlistForSlot } from "../routes/waitlist.js";
import { EP_NAME } from "../lib/slotCapacity.js";

function buildSlotDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const [year, month, day] = String(dateStr).split("-").map(Number);
  const [hour, minute] = String(timeStr).split(":").map(Number);
  if (!year || !month || !day) return null;
  return new Date(year, month - 1, day, hour || 0, minute || 0);
}

export function startWaitlistScheduler({ everyMinutes = 2 } = {}) {
  const ms = Math.max(1, Number(everyMinutes || 2)) * 60 * 1000;

  console.log("[WAITLIST] scheduler starting", { everyMinutes: ms / 60000 });

  const tick = async () => {
    try {
      const now = new Date();

      // slots con waitlist “waiting” (no notificado aún)
      const list = await WaitlistEntry.find({
        status: "waiting",
        service: EP_NAME,
      })
        .select("date time service status")
        .lean();

      // agrupar por slot
      const slots = new Map();
      for (const w of list) {
        const slotDate = buildSlotDate(w.date, w.time);
        if (!slotDate) continue;
        if (slotDate <= now) continue;

        const k = `${w.date}__${w.time}`;
        slots.set(k, { date: w.date, time: w.time });
      }

      for (const s of slots.values()) {
        // incluye regla 2hs antes (si libera cupo, notifica)
        await notifyWaitlistForSlot(s);
      }
    } catch (e) {
      console.error("[WAITLIST] tick error:", e);
    }
  };

  tick(); // arrancar ya
  const interval = setInterval(tick, ms);
  interval.unref?.();

  return () => clearInterval(interval);
}
