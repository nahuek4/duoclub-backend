// backend/src/jobs/appointmentReminders.js
import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import { sendAppointmentReminderEmail } from "../mail.js";

/**
 * YYYY-MM-DD en timezone AR
 * en-CA devuelve YYYY-MM-DD (ideal para DB)
 */
function arYmd(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * Convierte date+time guardados en AR (UTC-3) a Date UTC real para comparar.
 * dateStr: "YYYY-MM-DD"
 * timeStr: "HH:mm"
 *
 * AR = UTC-3 => UTC = AR + 3 horas
 */
function apptToUtcDate(dateStr, timeStr) {
  try {
    const [y, m, d] = String(dateStr || "").split("-").map(Number);
    const [hh, mm] = String(timeStr || "").split(":").map(Number);

    if (!y || !m || !d) return null;

    const H = Number.isFinite(hh) ? hh : 0;
    const M = Number.isFinite(mm) ? mm : 0;

    return new Date(Date.UTC(y, (m || 1) - 1, d || 1, H + 3, M, 0, 0));
  } catch {
    return null;
  }
}

function addDaysYmd(baseYmd, days) {
  const [y, m, d] = String(baseYmd).split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12, 0, 0, 0)); // mediodía UTC
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return arYmd(dt);
}

/**
 * Corre una vez:
 * - busca turnos RESERVED con reminder24hSentAt null
 * - que estén a ~24hs (ventana configurable)
 * - manda mail y marca reminder24hSentAt
 */
export async function runAppointmentReminderTick({
  aheadHours = 24,
  windowMinutes = 10,
  limit = 300,
} = {}) {
  const now = new Date();
  const nowMs = now.getTime();

  const targetFromMs = nowMs + aheadHours * 60 * 60 * 1000;
  const targetToMs = targetFromMs + windowMinutes * 60 * 1000;

  // Para no traer TODA la DB: filtramos por rango de fechas AR
  // (hoy -> hoy+2) suele alcanzar porque ahead=24h
  const todayAR = arYmd(now);
  const maxAR = addDaysYmd(todayAR, 2);

  const candidates = await Appointment.find({
    status: "reserved",
    reminder24hSentAt: null,
    date: { $gte: todayAR, $lte: maxAR },
  })
    .sort({ date: 1, time: 1 })
    .limit(limit)
    .lean();

  if (!candidates.length) {
    console.log("[REMINDER] tick: no candidates", { todayAR, maxAR });
    return { ok: true, checked: 0, sent: 0 };
  }

  let sent = 0;
  let checked = 0;

  for (const ap of candidates) {
    checked++;

    // Si el usuario no existe o no tiene mail => marcamos error y seguimos
    const apUtc = apptToUtcDate(ap.date, ap.time);
    if (!apUtc) {
      await Appointment.updateOne(
        { _id: ap._id, reminder24hSentAt: null },
        { $set: { reminder24hLastError: "INVALID_AP_DATE" } }
      );
      continue;
    }

    const t = apUtc.getTime();
    if (t < targetFromMs || t > targetToMs) continue;

    // traemos user (email)
    const user = await User.findById(ap.user).lean();
    if (!user?.email) {
      await Appointment.updateOne(
        { _id: ap._id, reminder24hSentAt: null },
        { $set: { reminder24hLastError: "NO_USER_EMAIL" } }
      );
      continue;
    }

    // ✅ “claim” atómico para evitar duplicado si corren 2 instancias
    const claim = await Appointment.updateOne(
      { _id: ap._id, reminder24hSentAt: null, status: "reserved" },
      { $set: { reminder24hSentAt: new Date(), reminder24hLastError: "" } }
    );

    if (!claim?.modifiedCount) {
      // ya lo agarró otro proceso / ya estaba marcado
      continue;
    }

    try {
      await sendAppointmentReminderEmail(
        user,
        { date: ap.date, time: ap.time, service: ap.service },
        ap.service
      );

      sent++;
      console.log("[REMINDER] sent OK", {
        apId: String(ap._id),
        to: user.email,
        date: ap.date,
        time: ap.time,
      });
    } catch (e) {
      console.log("[REMINDER] send FAILED", {
        apId: String(ap._id),
        to: user.email,
        date: ap.date,
        time: ap.time,
        err: e?.message || e,
      });

      // si falló el envío: guardamos error y “desmarcamos” sentAt para reintentar después
      await Appointment.updateOne(
        { _id: ap._id },
        {
          $set: {
            reminder24hLastError: String(e?.message || "SEND_FAILED"),
            reminder24hSentAt: null,
          },
        }
      );
    }
  }

  console.log("[REMINDER] tick done", { checked, sent, todayAR, maxAR });
  return { ok: true, checked, sent };
}
