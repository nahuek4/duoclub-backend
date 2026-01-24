// backend/src/jobs/startReminders.js
import { runAppointmentReminderTick } from "./appointmentReminders.js";

let intervalHandle = null;

export function startAppointmentReminderScheduler({
  everyMinutes = 10,
  aheadHours = 24,
  windowMinutes = 10,
} = {}) {
  if (intervalHandle) return intervalHandle;

  const ms = Math.max(1, Number(everyMinutes || 10)) * 60 * 1000;

  console.log("[REMINDER] scheduler starting", {
    everyMinutes,
    aheadHours,
    windowMinutes,
  });

  // correr una vez al boot
  runAppointmentReminderTick({ aheadHours, windowMinutes }).catch((e) =>
    console.log("[REMINDER] first tick error:", e?.message || e)
  );

  intervalHandle = setInterval(() => {
    runAppointmentReminderTick({ aheadHours, windowMinutes }).catch((e) =>
      console.log("[REMINDER] tick error:", e?.message || e)
    );
  }, ms);

  return intervalHandle;
}

export function stopAppointmentReminderScheduler() {
  if (!intervalHandle) return;
  clearInterval(intervalHandle);
  intervalHandle = null;
}
