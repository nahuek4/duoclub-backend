// backend/src/services/subscriptions/fixedScheduleCoverage.js
// Calculador puro: no escribe en MongoDB y no modifica turnos.

const SERVICE_KEYS = ["PE", "EP", "RA", "RF", "KD", "SYN", "NUT"];
const SERVICE_KEY_SET = new Set(SERVICE_KEYS);

function pad2(value) {
  return String(value).padStart(2, "0");
}

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function normalizeServiceKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const upper = stripAccents(raw).toUpperCase().trim();
  if (upper === "AR") return "RA";
  if (upper === "KINEDEPO" || upper === "KINE-DEPO") return "KD";
  if (upper === "SYNERGY" || upper === "SINERGIA") return "SYN";
  if (SERVICE_KEY_SET.has(upper)) return upper;

  const text = stripAccents(raw).toLowerCase().trim();
  if (text.includes("primera") && text.includes("evaluacion")) return "PE";
  if (text.includes("entrenamiento") && text.includes("personal")) return "EP";
  if (text.includes("rehabilitacion") && text.includes("activa")) return "RA";
  if (text.includes("reeducacion") && text.includes("funcional")) return "RF";
  if (text.includes("kinefilaxia") || (text.includes("kine") && text.includes("deport"))) return "KD";
  if (text.includes("synergy") || text.includes("sinergia")) return "SYN";
  if (text.includes("nutric")) return "NUT";
  return "";
}

export function isValidMonthKey(value) {
  if (!/^\d{4}-\d{2}$/.test(String(value || ""))) return false;
  const [, month] = String(value).split("-").map(Number);
  return month >= 1 && month <= 12;
}

function parseYmdLocal(value) {
  const [year, month, day] = String(value || "")
    .slice(0, 10)
    .split("-")
    .map(Number);

  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function ymd(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

export function monthRangeFromKey(monthKey) {
  if (!isValidMonthKey(monthKey)) {
    throw new Error(`INVALID_MONTH_KEY:${String(monthKey || "")}`);
  }

  const [year, month] = monthKey.split("-").map(Number);
  const start = new Date(year, month - 1, 1, 12, 0, 0, 0);
  const end = new Date(year, month, 0, 12, 0, 0, 0);

  return {
    start,
    end,
    startYmd: ymd(start),
    endYmd: ymd(end),
  };
}

export function weekdayMondayFirst(dateOrYmd) {
  const date = dateOrYmd instanceof Date ? dateOrYmd : parseYmdLocal(dateOrYmd);
  if (!date) return 0;
  const jsDay = date.getDay();
  return jsDay === 0 ? 7 : jsDay;
}

function cleanTime(value) {
  const time = String(value || "").slice(0, 5);
  return /^\d{2}:\d{2}$/.test(time) ? time : "";
}

function getId(value) {
  return String(value?._id || value?.id || "").trim();
}

function scheduleAppliesToDate(schedule, dateYmd) {
  if (!schedule || schedule.active === false) return false;

  const startDate = String(schedule.startDate || "").slice(0, 10);
  const endDate = String(schedule.endDate || "").slice(0, 10);

  if (startDate && dateYmd < startDate) return false;
  if (endDate && dateYmd > endDate) return false;
  return true;
}

function blockMatchesService(block, serviceKey) {
  if (!block || block.active === false) return false;
  if (block.allServices === true) return true;

  const keys = (Array.isArray(block.serviceKeys) ? block.serviceKeys : [])
    .map(normalizeServiceKey)
    .filter(Boolean);

  return keys.includes(serviceKey);
}

function blockMatchesDate(block, dateYmd) {
  const from = String(block?.dateFrom || "").slice(0, 10);
  const to = String(block?.dateTo || block?.dateFrom || "").slice(0, 10);

  if (!from || dateYmd < from) return false;
  if (!block?.indefinite && to && dateYmd > to) return false;

  const weekdays = Array.isArray(block?.weekdays)
    ? block.weekdays.map(Number).filter((n) => Number.isInteger(n))
    : [];

  if (weekdays.length && !weekdays.includes(weekdayMondayFirst(dateYmd))) {
    return false;
  }

  return true;
}

function blockMatchesTime(block, time) {
  if (block?.allDay !== false) return true;

  const from = cleanTime(block?.timeFrom);
  const to = cleanTime(block?.timeTo);
  if (!from || !to) return true;

  return time >= from && time < to;
}

export function findBlockingScheduleBlock(blocks, occurrence) {
  const list = Array.isArray(blocks) ? blocks : [];
  const serviceKey = normalizeServiceKey(occurrence?.serviceKey);
  const date = String(occurrence?.date || "").slice(0, 10);
  const time = cleanTime(occurrence?.time);

  if (!serviceKey || !date || !time) return null;

  return (
    list.find(
      (block) =>
        blockMatchesService(block, serviceKey) &&
        blockMatchesDate(block, date) &&
        blockMatchesTime(block, time)
    ) || null
  );
}

export function buildFixedOccurrencesForMonth({
  schedules = [],
  blocks = [],
  monthKey,
  serviceKey = "",
} = {}) {
  const range = monthRangeFromKey(monthKey);
  const requestedServiceKey = normalizeServiceKey(serviceKey);
  const activeSchedules = (Array.isArray(schedules) ? schedules : []).filter((schedule) => {
    if (!schedule || schedule.active === false) return false;
    const scheduleServiceKey = normalizeServiceKey(schedule.serviceKey || schedule.service);
    if (!scheduleServiceKey) return false;
    return !requestedServiceKey || scheduleServiceKey === requestedServiceKey;
  });

  const occurrencesBySlot = new Map();
  const blockedOccurrences = [];
  const duplicateOccurrences = [];

  const cursor = new Date(range.start);
  while (cursor <= range.end) {
    const date = ymd(cursor);
    const weekday = weekdayMondayFirst(cursor);

    for (const schedule of activeSchedules) {
      if (!scheduleAppliesToDate(schedule, date)) continue;

      const scheduleServiceKey = normalizeServiceKey(schedule.serviceKey || schedule.service);
      const items = Array.isArray(schedule.items) ? schedule.items : [];

      for (let scheduleItemIndex = 0; scheduleItemIndex < items.length; scheduleItemIndex += 1) {
        const item = items[scheduleItemIndex];
        const itemWeekday = Number(item?.weekday || 0);
        const time = cleanTime(item?.time);

        if (!time || itemWeekday !== weekday) continue;

        const occurrence = {
          fixedScheduleId: getId(schedule),
          scheduleItemIndex,
          serviceKey: scheduleServiceKey,
          date,
          time,
          weekday,
        };

        const block = findBlockingScheduleBlock(blocks, occurrence);
        if (block) {
          blockedOccurrences.push({
            ...occurrence,
            status: "blocked",
            coverageSource: "none",
            blockId: getId(block),
            blockReason:
              String(block.reason || "").trim() ||
              String(block.title || "").trim() ||
              "Agenda bloqueada",
          });
          continue;
        }

        const key = `${scheduleServiceKey}__${date}__${time}`;
        if (occurrencesBySlot.has(key)) {
          duplicateOccurrences.push({
            ...occurrence,
            duplicateOfFixedScheduleId: occurrencesBySlot.get(key).fixedScheduleId,
          });
          continue;
        }

        occurrencesBySlot.set(key, occurrence);
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  const occurrences = [...occurrencesBySlot.values()].sort((a, b) =>
    `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)
  );

  blockedOccurrences.sort((a, b) =>
    `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)
  );

  duplicateOccurrences.sort((a, b) =>
    `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)
  );

  return {
    monthKey,
    serviceKey: requestedServiceKey,
    range: { startYmd: range.startYmd, endYmd: range.endYmd },
    occurrences,
    blockedOccurrences,
    duplicateOccurrences,
  };
}

function cleanSessionCount(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

export function calculateMonthlyCoverage({
  monthlySessions = 0,
  extraSessionsSelected = 0,
  occurrences = [],
} = {}) {
  const baseSessions = cleanSessionCount(monthlySessions);
  const selectedExtras = cleanSessionCount(extraSessionsSelected);
  const totalSessions = baseSessions + selectedExtras;
  const list = (Array.isArray(occurrences) ? occurrences : [])
    .slice()
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

  const coveredOccurrences = list.map((occurrence, index) => {
    if (index < baseSessions) {
      return { ...occurrence, status: "covered", coverageSource: "base" };
    }
    if (index < totalSessions) {
      return { ...occurrence, status: "covered", coverageSource: "extra" };
    }
    return { ...occurrence, status: "pending_coverage", coverageSource: "none" };
  });

  const fixedOccurrencesCount = coveredOccurrences.length;
  const coveredFixedOccurrences = Math.min(fixedOccurrencesCount, totalSessions);
  const uncoveredFixedOccurrences = Math.max(0, fixedOccurrencesCount - totalSessions);
  const extraSessionsNeeded = Math.max(0, fixedOccurrencesCount - baseSessions);
  const additionalSessionsStillNeeded = Math.max(0, fixedOccurrencesCount - totalSessions);
  const freeSessions = Math.max(0, totalSessions - fixedOccurrencesCount);

  let status = "covered";
  if (additionalSessionsStillNeeded > 0) {
    status = selectedExtras > 0 ? "pending_coverage" : "extra_sessions_required";
  }

  return {
    status,
    baseSessions,
    extraSessionsSelected: selectedExtras,
    totalSessions,
    fixedOccurrencesCount,
    coveredFixedOccurrences,
    uncoveredFixedOccurrences,
    extraSessionsNeeded,
    additionalSessionsStillNeeded,
    freeSessions,
    occurrences: coveredOccurrences,
    coveredOccurrences: coveredOccurrences.filter((item) => item.status === "covered"),
    pendingOccurrences: coveredOccurrences.filter((item) => item.status === "pending_coverage"),
  };
}

export function calculateServiceMonthCoverage({
  schedules = [],
  blocks = [],
  monthKey,
  serviceKey,
  monthlySessions = 0,
  extraSessionsSelected = 0,
} = {}) {
  const normalizedServiceKey = normalizeServiceKey(serviceKey);
  if (!normalizedServiceKey) {
    throw new Error(`INVALID_SERVICE_KEY:${String(serviceKey || "")}`);
  }

  const generated = buildFixedOccurrencesForMonth({
    schedules,
    blocks,
    monthKey,
    serviceKey: normalizedServiceKey,
  });

  const coverage = calculateMonthlyCoverage({
    monthlySessions,
    extraSessionsSelected,
    occurrences: generated.occurrences,
  });

  return {
    monthKey,
    serviceKey: normalizedServiceKey,
    range: generated.range,
    ...coverage,
    blockedOccurrencesCount: generated.blockedOccurrences.length,
    blockedOccurrences: generated.blockedOccurrences,
    duplicateOccurrences: generated.duplicateOccurrences,
  };
}

export function calculateMonthlyCoverageByService({
  plans = [],
  schedules = [],
  blocks = [],
  monthKey,
} = {}) {
  const results = {};

  for (const plan of Array.isArray(plans) ? plans : []) {
    const serviceKey = normalizeServiceKey(plan?.serviceKey || plan?.service);
    if (!serviceKey) continue;

    results[serviceKey] = calculateServiceMonthCoverage({
      schedules,
      blocks,
      monthKey,
      serviceKey,
      monthlySessions: plan?.monthlySessions ?? plan?.sessions ?? plan?.credits ?? 0,
      extraSessionsSelected: plan?.extraSessionsSelected ?? plan?.extraSessions ?? 0,
    });
  }

  return results;
}
