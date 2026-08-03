// backend/src/services/subscriptions/subscriptionScheduleProjection.js
// Proyección controlada para migración: interpreta un FixedSchedule active:true
// como patrón semanal renovable, sin modificar el documento legacy.

import {
  isValidMonthKey,
  monthRangeFromKey,
  normalizeServiceKey,
} from "./fixedScheduleCoverage.js";

function clean(value) {
  return String(value || "").trim();
}

function idOf(value) {
  return clean(value?._id || value?.id || value);
}

function cleanTime(value) {
  const time = clean(value).slice(0, 5);
  return /^\d{2}:\d{2}$/.test(time) ? time : "";
}

function validItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      ...item,
      weekday: Number(item?.weekday || 0),
      time: cleanTime(item?.time),
    }))
    .filter(
      (item) =>
        Number.isInteger(item.weekday) &&
        item.weekday >= 1 &&
        item.weekday <= 7 &&
        Boolean(item.time)
    );
}

function dateYmd(value) {
  return clean(value).slice(0, 10);
}

export function scheduleLegacyOverlapsMonth(schedule = {}, monthKey) {
  const range = monthRangeFromKey(monthKey);
  const startDate = dateYmd(schedule?.startDate);
  const endDate = dateYmd(schedule?.endDate);

  if (startDate && startDate > range.endYmd) return false;
  if (endDate && endDate < range.startYmd) return false;
  return schedule?.active !== false;
}

export function projectActiveFixedSchedulesForMonth({
  schedules = [],
  monthKey,
  serviceKey = "",
} = {}) {
  if (!isValidMonthKey(monthKey)) {
    throw new Error(`INVALID_MONTH_KEY:${clean(monthKey)}`);
  }

  const range = monthRangeFromKey(monthKey);
  const requestedServiceKey = normalizeServiceKey(serviceKey);
  const projectedSchedules = [];
  const excludedSchedules = [];

  for (const schedule of Array.isArray(schedules) ? schedules : []) {
    const scheduleId = idOf(schedule);
    const normalizedServiceKey = normalizeServiceKey(
      schedule?.serviceKey || schedule?.service
    );
    const legacyStartDate = dateYmd(schedule?.startDate);
    const legacyEndDate = dateYmd(schedule?.endDate);
    const items = validItems(schedule?.items);

    const baseDiagnostic = {
      fixedScheduleId: scheduleId,
      serviceKey: normalizedServiceKey,
      legacyStartDate,
      legacyEndDate,
      active: schedule?.active !== false,
    };

    if (schedule?.active === false) {
      excludedSchedules.push({ ...baseDiagnostic, reason: "INACTIVE" });
      continue;
    }

    if (!normalizedServiceKey) {
      excludedSchedules.push({ ...baseDiagnostic, reason: "INVALID_SERVICE" });
      continue;
    }

    if (requestedServiceKey && normalizedServiceKey !== requestedServiceKey) {
      continue;
    }

    if (!items.length) {
      excludedSchedules.push({ ...baseDiagnostic, reason: "EMPTY_PATTERN" });
      continue;
    }

    if (legacyStartDate && legacyStartDate > range.endYmd) {
      excludedSchedules.push({ ...baseDiagnostic, reason: "NOT_STARTED_YET" });
      continue;
    }

    const projectedStartDate =
      legacyStartDate && legacyStartDate > range.startYmd
        ? legacyStartDate
        : range.startYmd;

    projectedSchedules.push({
      ...schedule,
      serviceKey: normalizedServiceKey,
      active: true,
      startDate: projectedStartDate,
      endDate: range.endYmd,
      items,
      _subscriptionProjection: {
        mode: "active_pattern_full_month",
        monthKey,
        legacyStartDate,
        legacyEndDate,
        projectedStartDate,
        projectedEndDate: range.endYmd,
        legacyExpiredBeforeMonth:
          Boolean(legacyEndDate) && legacyEndDate < range.startYmd,
        legacyEndsDuringMonth:
          Boolean(legacyEndDate) &&
          legacyEndDate >= range.startYmd &&
          legacyEndDate < range.endYmd,
      },
    });
  }

  return {
    monthKey,
    range: { startYmd: range.startYmd, endYmd: range.endYmd },
    projectedSchedules,
    excludedSchedules,
    diagnostics: {
      inputSchedules: Array.isArray(schedules) ? schedules.length : 0,
      projectedSchedules: projectedSchedules.length,
      excludedSchedules: excludedSchedules.length,
      legacyExpiredBeforeMonth: projectedSchedules.filter(
        (schedule) => schedule?._subscriptionProjection?.legacyExpiredBeforeMonth
      ).length,
      legacyEndsDuringMonth: projectedSchedules.filter(
        (schedule) => schedule?._subscriptionProjection?.legacyEndsDuringMonth
      ).length,
    },
  };
}
