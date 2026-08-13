import assert from "node:assert/strict";

import {
  addMonthsToMonthKey,
  periodDates,
  renewalPreviewDate,
  monthKeyFromDateArgentina,
} from "../src/services/subscriptions/subscriptionLifecycle.js";

function isoDay(date) {
  return date.toISOString().slice(0, 10);
}

assert.equal(addMonthsToMonthKey("2026-08", 1), "2026-09");
assert.equal(addMonthsToMonthKey("2026-12", 1), "2027-01");
assert.equal(addMonthsToMonthKey("2026-01", -1), "2025-12");

const september = periodDates("2026-09");
assert.equal(isoDay(september.start), "2026-09-01");
assert.equal(isoDay(september.dueAt), "2026-09-11"); // 10/09 23:59 ARG = 11/09 UTC
assert.equal(isoDay(september.suspendAt), "2026-09-11");
assert.equal(isoDay(september.fixedSlotsProtectedUntil), "2026-09-21"); // 20/09 23:59 ARG
assert.equal(isoDay(september.terminateAt), "2026-09-21");

const preview = renewalPreviewDate("2026-09");
assert.equal(isoDay(preview), "2026-08-25");

assert.equal(
  monthKeyFromDateArgentina(new Date("2026-09-01T01:00:00Z")),
  "2026-08",
  "01:00 UTC todavía es agosto en Argentina"
);
assert.equal(
  monthKeyFromDateArgentina(new Date("2026-09-01T04:00:00Z")),
  "2026-09"
);

console.log("✅ subscriptionLifecycle: pruebas básicas pasaron.");
