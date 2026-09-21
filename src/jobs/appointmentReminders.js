// backend/src/jobs/appointmentReminders.js
import Appointment from "../models/Appointment.js";
import User from "../models/User.js";
import ServiceSubscription from "../models/ServiceSubscription.js";
import { sendAppointmentReminderEmail } from "../mail.js";

const SESSION_PLAN_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);

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
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1, 12, 0, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return arYmd(dt);
}

function normalizeServiceKey(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const upper = raw.toUpperCase();
  if (upper === "AR") return "RA";
  if (["EP", "RA", "RF", "SYN", "KD", "PE", "NUT"].includes(upper)) {
    return upper;
  }

  const clean = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (clean.includes("entrenamiento") && clean.includes("personal")) return "EP";
  if (clean.includes("rehabilitacion") && clean.includes("activa")) return "RA";
  if (clean.includes("reeducacion") && clean.includes("funcional")) return "RF";
  if (clean.includes("synergy") || clean.includes("sinergia")) return "SYN";
  if (clean.includes("kinefilaxia") || clean.includes("kinedepo")) return "KD";
  if (clean.includes("primera") && clean.includes("evaluacion")) return "PE";
  if (clean.includes("nutric")) return "NUT";

  return "";
}

function monthBoundsYmd(dateStr) {
  const [year, month] = String(dateStr || "").slice(0, 10).split("-").map(Number);
  if (!year || !month) return { from: "", to: "", periodKey: "" };

  const next = new Date(Date.UTC(year, month, 1, 12, 0, 0, 0));
  const nextYear = next.getUTCFullYear();
  const nextMonth = String(next.getUTCMonth() + 1).padStart(2, "0");

  return {
    from: `${year}-${String(month).padStart(2, "0")}-01`,
    to: `${nextYear}-${nextMonth}-01`,
    periodKey: `${year}-${String(month).padStart(2, "0")}`,
  };
}

function formatSessionLabel(number, total) {
  const n = Number(number);
  const t = Number(total);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(t) || t <= 0) {
    return "";
  }

  return `${String(Math.trunc(n)).padStart(2, "0")}/${String(
    Math.trunc(t)
  ).padStart(2, "0")}`;
}

async function sessionProgressForAppointment(ap = {}) {
  const serviceKey = normalizeServiceKey(ap?.serviceKey || ap?.service);
  if (!SESSION_PLAN_SERVICE_KEYS.has(serviceKey)) return null;

  const { from, to, periodKey } = monthBoundsYmd(ap?.date);
  if (!from || !to || !periodKey || !ap?.user) return null;

  let subscription = await ServiceSubscription.findOne({
    user: ap.user,
    serviceKey,
    currentPeriodKey: periodKey,
  })
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  if (!subscription) {
    subscription = await ServiceSubscription.findOne({
      user: ap.user,
      serviceKey,
      status: { $in: ["active", "pending_change", "suspended"] },
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();
  }

  const sessionTotal = Math.max(
    0,
    Number(subscription?.monthlySessions || 0)
  );
  if (!sessionTotal) return null;

  const monthAppointments = await Appointment.find({
    user: ap.user,
    serviceKey,
    date: { $gte: from, $lt: to },
    status: { $in: ["reserved", "completed"] },
  })
    .select("_id date time createdAt")
    .sort({ date: 1, time: 1, createdAt: 1, _id: 1 })
    .lean();

  const targetId = String(ap?._id || "");
  let index = monthAppointments.findIndex(
    (item) => String(item?._id || "") === targetId
  );

  if (index < 0) {
    index = monthAppointments.findIndex(
      (item) =>
        String(item?.date || "") === String(ap?.date || "") &&
        String(item?.time || "") === String(ap?.time || "")
    );
  }

  if (index < 0) return null;

  const sessionNumber = index + 1;

  return {
    sessionNumber,
    sessionTotal,
    sessionLabel: formatSessionLabel(sessionNumber, sessionTotal),
  };
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

    const user = await User.findById(ap.user).lean();
    if (!user?.email) {
      await Appointment.updateOne(
        { _id: ap._id, reminder24hSentAt: null },
        { $set: { reminder24hLastError: "NO_USER_EMAIL" } }
      );
      continue;
    }

    const claim = await Appointment.updateOne(
      { _id: ap._id, reminder24hSentAt: null, status: "reserved" },
      { $set: { reminder24hSentAt: new Date(), reminder24hLastError: "" } }
    );

    if (!claim?.modifiedCount) continue;

    try {
      const progress = await sessionProgressForAppointment(ap).catch((error) => {
        console.log("[REMINDER] session progress warning:", {
          apId: String(ap._id),
          error: error?.message || error,
        });
        return null;
      });

      await sendAppointmentReminderEmail(
        user,
        {
          ...ap,
          serviceKey:
            normalizeServiceKey(ap?.serviceKey || ap?.service) ||
            ap?.serviceKey ||
            "",
          ...(progress || {}),
        },
        ap.service
      );

      sent++;
      console.log("[REMINDER] sent OK", {
        apId: String(ap._id),
        to: user.email,
        date: ap.date,
        time: ap.time,
        sessionLabel: progress?.sessionLabel || "",
      });
    } catch (e) {
      console.log("[REMINDER] send FAILED", {
        apId: String(ap._id),
        to: user.email,
        date: ap.date,
        time: ap.time,
        err: e?.message || e,
      });

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
