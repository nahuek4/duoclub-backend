// backend/src/jobs/monthlyRollover.js
// Renovación mensual DUO.
// - Expira créditos vencidos.
// - Asegura turnos fijos activos del mes.
// - Asegura los turnos fijos del mes sin generar deuda.
// - Los turnos sin cobertura quedan pendientes y la app informa las sesiones adicionales necesarias.

import User from "../models/User.js";
import FixedSchedule from "../models/FixedSchedule.js";
import Appointment from "../models/Appointment.js";
import ServiceSubscription from "../models/ServiceSubscription.js";
import { syncExtraSessionNoticeForUserService } from "../services/subscriptions/subscriptionExtraSessions.js";
import { runSubscriptionLifecycleTick } from "../services/subscriptions/subscriptionLifecycle.js";

const TZ = "America/Argentina/Buenos_Aires";

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
  NUT: "Nutrición",
};

const FIXED_SERVICE_KEYS = ["EP", "RA", "RF", "KD", "SYN"];
const THERAPY_KEYS = new Set(["RA", "RF", "KD", "SYN"]);
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
  for (const k of FIXED_SERVICE_KEYS) {
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

  // Materialización mensual: día 1 y ventana de recuperación hasta día 3.
  // El motor de ciclo corre todo el mes; esta ventana solo controla la creación
  // de Appointment de turnos fijos y el cierre de créditos vencidos.
  return p.day <= 3 && p.hour >= 6;
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
  const affectedUserServices = new Map();

  // En el modelo nuevo, active:true representa un patrón fijo vigente.
  // endDate pertenece al esquema legacy mensual y NO debe cortar la proyección.
  const schedules = await FixedSchedule.find({
    active: true,
    startDate: { $lte: endYmd },
  }).lean();

  // Solo materializamos turnos fijos para servicios que realmente tienen una
  // suscripción renovada y activa en este período. Los 10 casos legacy sin
  // suscripción no se renuevan automáticamente.
  const subscriptions = await ServiceSubscription.find({
    autoRenew: true,
    status: { $in: ["active", "pending_change"] },
    currentPeriodKey: monthKey,
  }).select("user serviceKey").lean();
  const renewableKeys = new Set(
    subscriptions.map((sub) => `${String(sub.user)}__${String(sub.serviceKey)}`)
  );

  let created = 0;
  let skipped = 0;

  for (const schedule of schedules) {
    const userId = schedule.user;
    const sk = normalizeServiceKey(schedule.serviceKey || schedule.service);
    if (!userId || !sk || !FIXED_SERVICE_KEYS.includes(sk)) {
      skipped += 1;
      continue;
    }

    if (!renewableKeys.has(`${String(userId)}__${sk}`)) {
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
      if (isPastOccurrence(occ.date, occ.time, now)) {
        skipped += 1;
        continue;
      }

      const alreadyForSameFixedSlot = await Appointment.findOne({
        user: userId,
        fixedScheduleId: schedule._id,
        date: occ.date,
        time: occ.time,
        status: { $in: ["reserved", "completed", "cancelled"] },
      }).lean();

      if (alreadyForSameFixedSlot) {
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
          creditDebitStatus: "pending",
          fixedDebtAmount: 0,
          notes: schedule.notes
            ? `Turno fijo mensual. ${String(schedule.notes).trim()}`
            : "Turno fijo mensual.",
        });
        created += 1;
        const affectedKey = `${String(userId)}__${sk}`;
        affectedUserServices.set(affectedKey, { userId, serviceKey: sk });
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

  let noticesSynced = 0;
  let noticeErrors = 0;

  for (const item of affectedUserServices.values()) {
    try {
      await syncExtraSessionNoticeForUserService({
        userId: item.userId,
        serviceKey: item.serviceKey,
        source: "manual_refresh",
        now,
      });
      noticesSynced += 1;
    } catch (error) {
      noticeErrors += 1;
      console.log("[MONTHLY] extra notice sync skipped", {
        userId: String(item.userId || ""),
        serviceKey: item.serviceKey,
        error: error?.message || error,
      });
    }
  }

  return { schedules: schedules.length, created, skipped, monthlyDebtAdded: 0, noticesSynced, noticeErrors };
}

export async function runMonthlyRollover({ force = false } = {}) {
  const now = new Date();
  const p = arParts(now);
  const monthKey = monthKeyFromParts(p);

  // El motor de suscripciones debe correr durante todo el mes para detectar
  // preview, día 1, suspensión y baja. `force` solo fuerza la renovación/cierre
  // mensual; nunca fuerza una baja anticipada por falta de pago.
  const lifecycle = await runSubscriptionLifecycleTick({ now, force });

  if (!force && !isMonthlyRunWindow(now)) {
    return {
      ok: true,
      monthKey,
      lifecycle,
      fixed: { skipped: true, reason: "OUTSIDE_FIXED_MATERIALIZATION_WINDOW" },
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
      title: "Cierre mensual aplicado",
      message: "Se cerraron créditos vencidos y se materializaron los turnos fijos de suscripciones activas sin generar deuda.",
      createdAt: now,
    });

    await user.save();
    usersTouched += 1;
  }

  const fixed = await ensureFixedAppointmentsForMonth(monthKey, { now });

  return {
    ok: true,
    monthKey,
    lifecycle,
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
