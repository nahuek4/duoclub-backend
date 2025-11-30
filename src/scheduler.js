import { db } from "./models/store.js";
import {
  sendAppointmentReminderEmail,
  sendAptoExpiredEmail,
} from "./mail.js";

function parseDateTime(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  try {
    // Asumimos zona horaria local del servidor
    return new Date(dateStr + "T" + timeStr + ":00");
  } catch {
    return null;
  }
}

export function startSchedulers() {
  // Corre cada hora
  setInterval(async () => {
    const now = new Date();

    // Recordatorios de turnos
    for (const ap of db.appointments) {
      if (ap.reminderSent) continue;
      const dt = parseDateTime(ap.date, ap.time);
      if (!dt) continue;
      const diffMs = dt.getTime() - now.getTime();
      const diffHours = diffMs / (1000 * 60 * 60);

      if (diffHours <= 25 && diffHours >= 23) {
        const u = db.users.find((x) => x.id === ap.userId);
        if (!u) continue;
        const svc = db.services.find((s) => s.key === ap.service);
        const serviceName = svc ? svc.name : ap.service;
        await sendAppointmentReminderEmail(u, ap, serviceName);
        ap.reminderSent = true;
      }
    }

    // Apto vencido
    for (const u of db.users) {
      if (u.aptoWarnSent) continue;
      if (!u.createdAt) continue;
      const created = new Date(u.createdAt);
      const days =
        (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
      if (days > 20 && !u.aptoPath) {
        await sendAptoExpiredEmail(u);
        u.aptoWarnSent = true;
      }
    }
  }, 60 * 60 * 1000);
}
