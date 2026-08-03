// backend/scripts/testSubscriptionCoveragePreview.js
import assert from "node:assert/strict";
import { buildSubscriptionCoveragePreview } from "../src/services/subscriptions/subscriptionCoveragePreview.js";

const user = {
  _id: "user-1",
  name: "Usuario",
  lastName: "Prueba",
  email: "prueba@duoclub.ar",
  fixedScheduleDebt: { EP: 2 },
  creditLots: [
    {
      _id: "lot-1",
      serviceKey: "EP",
      amount: 8,
      remaining: 3,
      source: "ORDER",
      expiresAt: "2099-12-31T23:59:59.000Z",
      createdAt: "2026-08-01T10:00:00.000Z",
    },
  ],
};

const fiveTuesdays = [
  {
    _id: "fixed-1",
    user: "user-1",
    serviceKey: "EP",
    service: "Entrenamiento Personal",
    active: true,
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    items: [{ weekday: 2, time: "10:00" }],
  },
];

const plans = [
  {
    _id: "plan-4",
    serviceKey: "EP",
    payMethod: "CASH",
    credits: 4,
    price: 40000,
    label: "4 sesiones",
    active: true,
    isCustom: false,
  },
  {
    _id: "plan-8",
    serviceKey: "EP",
    payMethod: "CASH",
    credits: 8,
    price: 70000,
    label: "8 sesiones",
    active: true,
    isCustom: false,
  },
];

const preview4 = buildSubscriptionCoveragePreview({
  user,
  serviceKey: "EP",
  monthKey: "2026-09",
  schedules: fiveTuesdays,
  pricingPlans: plans,
  selectedPricingPlanId: "plan-4",
  now: new Date("2026-08-03T12:00:00.000Z"),
});

assert.equal(preview4.readOnly, true);
assert.equal(preview4.selectedPlan.source, "pricing_plan");
assert.equal(preview4.coverage.fixedOccurrencesCount, 5);
assert.equal(preview4.coverage.extraSessionsNeeded, 1);
assert.equal(preview4.coverage.additionalSessionsStillNeeded, 1);
assert.equal(preview4.coverage.pendingOccurrences.length, 1);
assert.equal(preview4.coverage.pendingOccurrences[0].date, "2026-09-29");
assert.equal(preview4.legacySnapshot.availableSessionsNow, 3);
assert.equal(preview4.legacySnapshot.legacyFixedScheduleDebt, 2);

const plan8Comparison = preview4.planComparisons.find(
  (item) => item.plan.id === "plan-8"
);
assert.ok(plan8Comparison);
assert.equal(plan8Comparison.coverage.freeSessions, 3);
assert.equal(plan8Comparison.coverage.additionalSessionsStillNeeded, 0);

const previewWithBlock = buildSubscriptionCoveragePreview({
  user,
  serviceKey: "EP",
  monthKey: "2026-09",
  schedules: fiveTuesdays,
  blocks: [
    {
      _id: "block-1",
      active: true,
      allServices: false,
      serviceKeys: ["EP"],
      dateFrom: "2026-09-15",
      dateTo: "2026-09-15",
      allDay: true,
    },
  ],
  pricingPlans: plans,
  selectedPricingPlanId: "plan-4",
  now: new Date("2026-08-03T12:00:00.000Z"),
});

assert.equal(previewWithBlock.coverage.fixedOccurrencesCount, 4);
assert.equal(previewWithBlock.coverage.blockedOccurrencesCount, 1);
assert.equal(previewWithBlock.coverage.additionalSessionsStillNeeded, 0);
assert.equal(previewWithBlock.coverage.status, "covered");

const manualPreview = buildSubscriptionCoveragePreview({
  user,
  serviceKey: "EP",
  monthKey: "2026-09",
  schedules: fiveTuesdays,
  pricingPlans: plans,
  manualMonthlySessions: 2,
  extraSessionsSelected: 1,
  now: new Date("2026-08-03T12:00:00.000Z"),
});

assert.equal(manualPreview.selectedPlan.source, "manual_preview");
assert.equal(manualPreview.coverage.totalSessions, 3);
assert.equal(manualPreview.coverage.additionalSessionsStillNeeded, 2);
assert.equal(manualPreview.coverage.status, "pending_coverage");

const unconfigured = buildSubscriptionCoveragePreview({
  user,
  serviceKey: "EP",
  monthKey: "2026-09",
  schedules: fiveTuesdays,
  pricingPlans: plans,
  now: new Date("2026-08-03T12:00:00.000Z"),
});

assert.equal(unconfigured.selectedPlan.source, "unconfigured");
assert.equal(unconfigured.coverage.baseSessions, 0);
assert.equal(unconfigured.coverage.pendingOccurrences.length, 5);
assert.ok(unconfigured.warnings.length > 0);

console.log("✅ subscriptionCoveragePreview: todas las pruebas pasaron.");
