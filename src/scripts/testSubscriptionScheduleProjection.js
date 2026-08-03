import assert from "node:assert/strict";
import { calculateServiceMonthCoverage } from "../src/services/subscriptions/fixedScheduleCoverage.js";
import {
  projectActiveFixedSchedulesForMonth,
  scheduleLegacyOverlapsMonth,
} from "../src/services/subscriptions/subscriptionScheduleProjection.js";

const expiredButActive = {
  _id: "64a000000000000000000001",
  user: "64a000000000000000000002",
  serviceKey: "EP",
  service: "Entrenamiento Personal",
  active: true,
  startDate: "2026-07-12",
  endDate: "2026-08-12",
  items: [
    { weekday: 1, time: "08:00" },
    { weekday: 3, time: "08:00" },
  ],
};

assert.equal(scheduleLegacyOverlapsMonth(expiredButActive, "2026-09"), false);

const projection = projectActiveFixedSchedulesForMonth({
  schedules: [expiredButActive],
  monthKey: "2026-09",
  serviceKey: "EP",
});

assert.equal(projection.projectedSchedules.length, 1);
assert.equal(projection.diagnostics.legacyExpiredBeforeMonth, 1);
assert.equal(projection.projectedSchedules[0].startDate, "2026-09-01");
assert.equal(projection.projectedSchedules[0].endDate, "2026-09-30");
assert.equal(
  projection.projectedSchedules[0]._subscriptionProjection.legacyEndDate,
  "2026-08-12"
);

const coverage = calculateServiceMonthCoverage({
  schedules: projection.projectedSchedules,
  blocks: [],
  monthKey: "2026-09",
  serviceKey: "EP",
  monthlySessions: 8,
});

// Septiembre 2026 tiene 4 lunes y 5 miércoles.
assert.equal(coverage.fixedOccurrencesCount, 9);
assert.equal(coverage.additionalSessionsStillNeeded, 1);

const future = projectActiveFixedSchedulesForMonth({
  schedules: [
    {
      ...expiredButActive,
      _id: "64a000000000000000000003",
      startDate: "2026-10-05",
      endDate: "2026-11-05",
    },
  ],
  monthKey: "2026-09",
  serviceKey: "EP",
});

assert.equal(future.projectedSchedules.length, 0);
assert.equal(future.excludedSchedules[0].reason, "NOT_STARTED_YET");

console.log("✅ subscriptionScheduleProjection: todas las pruebas pasaron.");
