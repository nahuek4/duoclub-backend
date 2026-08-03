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
  {
    _id: "custom-1",
    serviceKey: "EP",
    payMethod: "CASH",
    credits: 9,
    price: 90000,
    label: "Tarjeta personalizada",
    active: true,
    isCustom: true,
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
assert.equal(preview4.publishedPlan.source, "published_pricing_plan");
assert.equal(preview4.publishedPlan.monthlySessions, 4);
assert.equal(preview4.coverage.fixedOccurrencesCount, 5);
assert.equal(preview4.coverage.basePlanSessions, 4);
assert.equal(preview4.coverage.extraSessionsRequired, 1);
assert.equal(preview4.coverage.extraSessionsPending, 1);
assert.equal(preview4.coverage.pendingOccurrences.length, 1);
assert.equal(preview4.coverage.pendingOccurrences[0].date, "2026-09-29");
assert.equal(preview4.legacySnapshot.availableSessionsNow, 3);
assert.equal(preview4.legacySnapshot.legacyFixedScheduleDebt, 2);
assert.equal(preview4.publishedPlanComparisons.length, 2);
assert.equal(
  preview4.publishedPlanComparisons.some((item) => item.publishedPlan.id === "custom-1"),
  false
);

const previewWithExtra = buildSubscriptionCoveragePreview({
  user,
  serviceKey: "EP",
  monthKey: "2026-09",
  schedules: fiveTuesdays,
  pricingPlans: plans,
  selectedPricingPlanId: "plan-4",
  extraSessionsSelected: 1,
});

assert.equal(previewWithExtra.publishedPlan.monthlySessions, 4);
assert.equal(previewWithExtra.coverage.totalSessions, 5);
assert.equal(previewWithExtra.coverage.extraSessionsRequired, 1);
assert.equal(previewWithExtra.coverage.extraSessionsSelected, 1);
assert.equal(previewWithExtra.coverage.extraSessionsPending, 0);
assert.equal(previewWithExtra.coverage.status, "covered");

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
});

assert.equal(previewWithBlock.coverage.fixedOccurrencesCount, 4);
assert.equal(previewWithBlock.coverage.blockedOccurrencesCount, 1);
assert.equal(previewWithBlock.coverage.extraSessionsPending, 0);
assert.equal(previewWithBlock.coverage.status, "covered");

const unconfigured = buildSubscriptionCoveragePreview({
  user,
  serviceKey: "EP",
  monthKey: "2026-09",
  schedules: fiveTuesdays,
  pricingPlans: plans,
});

assert.equal(unconfigured.publishedPlan.source, "unconfigured");
assert.equal(unconfigured.coverage.basePlanSessions, 0);
assert.equal(unconfigured.coverage.pendingOccurrences.length, 5);
assert.ok(unconfigured.warnings.some((item) => item.includes("planes publicados")));

const invalid = buildSubscriptionCoveragePreview({
  user,
  serviceKey: "EP",
  monthKey: "2026-09",
  schedules: fiveTuesdays,
  pricingPlans: plans,
  selectedPricingPlanId: "plan-inexistente",
});
assert.equal(invalid.publishedPlan.source, "invalid_published_plan");
assert.equal(invalid.coverage.basePlanSessions, 0);

console.log("✅ subscriptionCoveragePreview: todas las pruebas pasaron.");
