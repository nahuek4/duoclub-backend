// backend/src/jobs/monthlyRollover.js
// Renovación mensual DUO.
// - Expira créditos vencidos.
// - Asegura turnos fijos activos del mes.
// - Al reservar el mes, genera deuda mensual por servicio según la cantidad de turnos fijos creados.
// - Al llegar cada horario fijo, el job solo marca el turno como completado; no vuelve a debitar.

import User from "../models/User.js";
import FixedSchedule from "../models/FixedSchedule.js";
import Appointment from "../models/Appointment.js";

const TZ = "America/Argentina/Buenos_Aires";

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  NUT: "Nutrición",
};

const THERAPY_KEYS = new Set(["RA", "RF", "KD"]);
const EP_CAP = 12;
const THERAPY_SHARED_CAP = 8;

let schedulerStarted = false;
let schedulerTimer = null;

function pad2(n) {
  return String(n).padStart(2, "0");
}

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeServiceKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const up = stripAccents(raw).toUpperCase().trim();
  if (up === "AR") return "RA";
  if (up === "KINEDEPO" || up === "KINE-DEPO") return "KD";
  if (SERVICE_KEY_TO_NAME[up]) return up;

  const s = stripAccents(raw).toLowerCase().trim();
  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("kinefilaxia") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("nutric")) return "NUT";

  return "";
}

function serviceName(serviceKey) {
  return SERVICE_KEY_TO_NAME[normalizeServiceKey(serviceKey)] || String(serviceKey || "").trim();
}

function arParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function ymdFromParts(p) {
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function monthKeyFromParts(p) {
  return `${p.year}-${pad2(p.month)}`;
}

function currentHmFromParts(p) {
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

function isPastOccurrence(date, time, now = new Date()) {
  const p = arParts(now);
  const today = ymdFromParts(p);
  const hm = currentHmFromParts(p);
  const d = String(date || "").slice(0, 10);
  const t = String(time || "").slice(0, 5);
  if (d < today) return true;
  if (d > today) return false;
  return t <= hm;
}

function ensureFixedDebt(user) {
  user.fixedScheduleDebt = user.fixedScheduleDebt || {};
  for (const k of ["EP", "RA", "RF", "KD"]) {
    const n = Number(user.fixedScheduleDebt?.[k] || 0);
    user.fixedScheduleDebt[k] = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  }
}

function parseYmd(ymd) {
  const [y, m, d] = String(ymd || "").slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

function ymdLocal(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function monthStartEnd(monthKey) {
  const [year, month] = String(monthKey || "").split("-").map(Number);
  const start = new Date(year, month - 1, 1, 12, 0, 0, 0);
  const end = new Date(year, month, 0, 12, 0, 0, 0);
  return { start, end, startYmd: ymdLocal(start), endYmd: ymdLocal(end) };
}

function weekdayMondayFirst(ymd) {
  const d = parseYmd(ymd);
  if (!d) return 0;
  const js = d.getDay();
  return js === 0 ? 7 : js;
}

function isBusinessDayYmd(ymd) {
  const w = weekdayMondayFirst(ymd);
  return w >= 1 && w <= 5;
}

function isMonthlyRunWindow(date = new Date()) {
  const p = arParts(date);
  const today = ymdFromParts(p);

  // Corre durante la primera semana hábil, desde las 06:00 ARG.
  // Cada usuario queda marcado por monthKey para no repetir el proceso.
  return p.day <= 7 && p.hour >= 6 && isBusinessDayYmd(today);
}

function buildOccurrencesForMonth({ monthKey, items = [] }) {
  const { start, end } = monthStartEnd(monthKey);
  const out = [];

  const cursor = new Date(start);
  while (cursor <= end) {
    const date = ymdLocal(cursor);
    const weekday = weekdayMondayFirst(date);

    for (const item of items || []) {
      const itemWeekday = Number(item?.weekday || 0);
      const time = String(item?.time || "").slice(0, 5);
      if (itemWeekday === weekday && /^\d{2}:\d{2}$/.test(time)) {
        out.push({ date, time });
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return out;
}

function recalcUserCredits(user) {
  const now = new Date();
  const lots = Array.isArray(user?.creditLots) ? user.creditLots : [];
  const sum = lots.reduce((acc, lot) => {
    const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return acc;
    return acc + Math.max(0, Number(lot?.remaining || 0));
  }, 0);
  user.credits = sum;
}

async function expirePastCreditsForUser(user) {
  if (!user) return false;

  const now = new Date();
  let changed = false;

  if (Array.isArray(user.creditLots)) {
    for (const lot of user.creditLots) {
      const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
      if (exp && exp <= now && Number(lot.remaining || 0) > 0) {
        lot.remaining = 0;
        changed = true;
      }
    }
  }

  recalcUserCredits(user);
  return changed;
}

async function slotHasCapacity({ date, time, serviceKey }) {
  const sk = normalizeServiceKey(serviceKey);
  if (!sk) return false;

  const existing = await Appointment.find({
    date,
    time: String(time || "").slice(0, 5),
    status: "reserved",
  })
    .select("serviceKey service user")
    .lean();

  const epReserved = existing.filter((ap) => normalizeServiceKey(ap.serviceKey || ap.service) === "EP").length;
  const therapyReserved = existing.filter((ap) => THERAPY_KEYS.has(normalizeServiceKey(ap.serviceKey || ap.service))).length;

  if (sk === "EP") return epReserved < EP_CAP;
  if (THERAPY_KEYS.has(sk)) return therapyReserved < THERAPY_SHARED_CAP;

  // Servicios fuera del pool principal: permitir si el usuario no duplica horario.
  return true;
}

async function ensureFixedAppointmentsForMonth(monthKey, { now = new Date() } = {}) {
  const { startYmd, endYmd } = monthStartEnd(monthKey);
  const debtCounts = new Map();

  const schedules = await FixedSchedule.find({
    active: true,
    startDate: { $lte: endYmd },
    endDate: { $gte: startYmd },
  }).lean();

  let created = 0;
  let skipped = 0;

  for (const schedule of schedules) {
    const userId = schedule.user;
    const sk = normalizeServiceKey(schedule.serviceKey || schedule.service);
    if (!userId || !sk || !["EP", "RA", "RF", "KD"].includes(sk)) {
      skipped += 1;
      continue;
    }

    const occurrences = buildOccurrencesForMonth({
      monthKey,
      items: Array.isArray(schedule.items) ? schedule.items : [],
    });

    for (const occ of occurrences) {
      if (occ.date < startYmd || occ.date > endYmd) continue;
      if (schedule.startDate && occ.date < schedule.startDate) continue;
      if (schedule.endDate && occ.date > schedule.endDate) continue;
      if (isPastOccurrence(occ.date, occ.time, now)) {
        skipped += 1;
        continue;
      }

      const alreadyForUser = await Appointment.findOne({
        user: userId,
        date: occ.date,
        time: occ.time,
        status: "reserved",
      }).lean();

      if (alreadyForUser) {
        skipped += 1;
        continue;
      }

      const hasCapacity = await slotHasCapacity({ date: occ.date, time: occ.time, serviceKey: sk });
      if (!hasCapacity) {
        skipped += 1;
        continue;
      }

      try {
        await Appointment.create({
          user: userId,
          date: occ.date,
          time: occ.time,
          serviceKey: sk,
          service: serviceName(sk),
          status: "reserved",
          createdByRole: "admin",
          assignedManually: true,
          fixedScheduleId: schedule._id,
          monthlyRolloverMonthKey: monthKey,
          creditDebitStatus: "debt",
          fixedDebtAmount: 1,
          notes: schedule.notes
            ? `Turno fijo mensual. ${String(schedule.notes).trim()}`
            : "Turno fijo mensual.",
        });
        created += 1;
        const debtKey = `${String(userId)}__${sk}`;
        debtCounts.set(debtKey, { userId, serviceKey: sk, count: (debtCounts.get(debtKey)?.count || 0) + 1 });
      } catch (err) {
        // Conflictos por índice único u otro proceso paralelo: no tumbar el job.
        skipped += 1;
        console.log("[MONTHLY] fixed appointment skipped", {
          scheduleId: String(schedule._id || ""),
          userId: String(userId || ""),
          date: occ.date,
          time: occ.time,
          serviceKey: sk,
          error: err?.message || err,
        });
      }
    }
  }

  let monthlyDebtAdded = 0;

  for (const item of debtCounts.values()) {
    const user = await User.findById(item.userId).select("fixedScheduleDebt credits creditLots history");
    if (!user) continue;

    ensureFixedDebt(user);
    user.fixedScheduleDebt[item.serviceKey] = Math.max(0, Number(user.fixedScheduleDebt?.[item.serviceKey] || 0)) + item.count;
    user.markModified?.("fixedScheduleDebt");
    user.history = Array.isArray(user.history) ? user.history : [];
    user.history.push({
      action: "fixed_schedule_monthly_reserved",
      title: `Deuda mensual de turnos fijos ${item.serviceKey}`,
      message: `Se reservaron ${item.count} turno${item.count === 1 ? "" : "s"} fijo${item.count === 1 ? "" : "s"} de ${serviceName(item.serviceKey)} para ${monthKey}. Se generó deuda mensual de ${item.count} sesión${item.count === 1 ? "" : "es"}.`,
      serviceKey: item.serviceKey,
      serviceName: serviceName(item.serviceKey),
      service: serviceName(item.serviceKey),
      qty: -item.count,
      createdAt: now,
    });
    recalcUserCredits(user);
    await user.save();
    monthlyDebtAdded += item.count;
  }

  return { schedules: schedules.length, created, skipped, monthlyDebtAdded };
}

export async function runMonthlyRollover({ force = false } = {}) {
  const now = new Date();
  const p = arParts(now);
  const monthKey = monthKeyFromParts(p);

  if (!force && !isMonthlyRunWindow(now)) {
    return {
      ok: true,
      skipped: true,
      reason: "OUTSIDE_RUN_WINDOW",
      monthKey,
    };
  }

  const users = await User.find({}).select("creditLots credits monthlyAutomation history");

  let usersTouched = 0;
  let expiredLotsChanged = 0;

  for (const user of users) {
    user.monthlyAutomation = user.monthlyAutomation || {};

    if (user.monthlyAutomation.lastMonthlyResetMonthKey === monthKey) {
      continue;
    }

    const changed = await expirePastCreditsForUser(user);
    if (changed) expiredLotsChanged += 1;

    user.monthlyAutomation.lastMonthlyResetMonthKey = monthKey;
    user.monthlyAutomation.lastRunAt = now;

    user.history = Array.isArray(user.history) ? user.history : [];
    user.history.push({
      action: "monthly_rollover",
      title: "Renovación mensual aplicada",
      message: "Se actualizó el vencimiento mensual de créditos y se aseguraron los turnos fijos del mes, generando la deuda mensual correspondiente por servicio.",
      createdAt: now,
    });

    await user.save();
    usersTouched += 1;
  }

  const fixed = await ensureFixedAppointmentsForMonth(monthKey, { now });

  return {
    ok: true,
    monthKey,
    usersTouched,
    expiredLotsChanged,
    fixed,
  };
}

export async function monthlyRolloverTick(options = {}) {
  try {
    const result = await runMonthlyRollover(options);
    console.log("[MONTHLY] tick", result);
    return result;
  } catch (err) {
    console.log("[MONTHLY] tick error", err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

export function startMonthlyRolloverScheduler({ everyMinutes } = {}) {
  if (schedulerStarted) return;

  schedulerStarted = true;

  const enabled = String(process.env.MONTHLY_ROLLOVER_ENABLED || "true") !== "false";
  const minutes = Math.max(
    5,
    Number(everyMinutes || process.env.MONTHLY_ROLLOVER_EVERY_MINUTES || 60)
  );

  console.log("[MONTHLY] scheduler starting", { enabled, everyMinutes: minutes });

  if (!enabled) return;

  const delayMs = minutes * 60 * 1000;

  // Primer tick diferido para no bloquear el arranque.
  setTimeout(() => monthlyRolloverTick(), 10_000);

  schedulerTimer = setInterval(() => monthlyRolloverTick(), delayMs);
  schedulerTimer.unref?.();
}

export const startMonthlyScheduler = startMonthlyRolloverScheduler;
export const startMonthlyRollover = startMonthlyRolloverScheduler;

export default startMonthlyRolloverScheduler;
