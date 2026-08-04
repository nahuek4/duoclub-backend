import assert from "node:assert/strict";
import {
  buildInitialSubscriptionCandidate,
  buildServiceSubscriptionCreatePayload,
  canRollbackBootstrapSubscription,
  resolvePublishedPlanFromPaidOrder,
  summarizePaidOrderForService,
} from "../src/services/subscriptions/subscriptionBootstrap.js";

const userId = "64a000000000000000000001";
const cashPlanId = "64a000000000000000000002";
const mpPlanId = "64a000000000000000000012";
const inactiveOldPlanId = "64a000000000000000000022";
const fixedId = "64a000000000000000000003";
const orderId = "64a000000000000000000004";
const actorId = "64a000000000000000000005";

const user = {
  _id: userId,
  name: "Usuario",
  lastName: "Prueba",
  email: "prueba@duoclub.ar",
  role: "client",
  fixedScheduleDebt: { EP: 2 },
  creditLots: [
    {
      _id: "64a000000000000000000006",
      serviceKey: "EP",
      amount: 8,
      remaining: 3,
      source: "order",
      expiresAt: "2099-12-31T23:59:59.000Z",
      createdAt: "2026-08-01T10:00:00.000Z",
    },
  ],
};

const schedules = [
  {
    _id: fixedId,
    user: userId,
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
    _id: cashPlanId,
    serviceKey: "EP",
    payMethod: "CASH",
    credits: 4,
    price: 40000,
    label: "4 sesiones",
    active: true,
    isCustom: false,
  },
  {
    _id: mpPlanId,
    serviceKey: "EP",
    payMethod: "MP",
    credits: 4,
    price: 43000,
    label: "4 sesiones",
    active: true,
    isCustom: false,
  },
];

const paidOrder = {
  _id: orderId,
  user: userId,
  status: "paid",
  payMethod: "CASH",
  paidAt: "2026-08-01T12:00:00.000Z",
  items: [
    {
      kind: "CREDITS",
      serviceKey: "EP",
      credits: 4,
      qty: 1,
      basePrice: 40000,
      price: 40000,
      pricingPlanId: cashPlanId,
    },
  ],
};

const orderSummary = summarizePaidOrderForService(paidOrder, "EP");
assert.equal(orderSummary.sessions, 4);
assert.equal(orderSummary.amount, 40000);
assert.equal(orderSummary.pricingPlanId, cashPlanId);

const exactResolution = resolvePublishedPlanFromPaidOrder({
  latestPaidOrder: paidOrder,
  pricingPlans: plans,
  serviceKey: "EP",
});
assert.equal(exactResolution.ok, true);
assert.equal(exactResolution.method, "exact_pricing_plan");
assert.equal(exactResolution.publishedPlan.pricingPlanId, cashPlanId);

const legacyPaidOrder = {
  ...paidOrder,
  payMethod: "MP",
  items: [
    {
      kind: "CREDITS",
      serviceKey: "EP",
      credits: 4,
      qty: 1,
      basePrice: 43000,
      price: 43000,
      pricingPlanId: inactiveOldPlanId,
    },
  ],
};
const matchedResolution = resolvePublishedPlanFromPaidOrder({
  latestPaidOrder: legacyPaidOrder,
  pricingPlans: plans,
  serviceKey: "EP",
});
assert.equal(matchedResolution.ok, true);
assert.equal(matchedResolution.method, "matched_by_paid_credits");
assert.equal(matchedResolution.publishedPlan.pricingPlanId, mpPlanId);

const candidate = buildInitialSubscriptionCandidate({
  user,
  serviceKey: "EP",
  monthKey: "2026-09",
  schedules,
  blocks: [],
  pricingPlans: plans,
  selectedPricingPlanId: "",
  existingSubscription: null,
  latestPaidOrder: paidOrder,
  now: new Date("2026-08-03T12:00:00.000Z"),
});

assert.equal(candidate.canCreate, true);
assert.equal(candidate.planResolution.method, "exact_pricing_plan");
assert.equal(candidate.publishedPlan.monthlySessions, 4);
assert.equal(candidate.coverage.fixedOccurrencesCount, 5);
assert.equal(candidate.coverage.extraSessionsRequired, 1);
assert.equal(candidate.coverage.extraSessionsPending, 1);
assert.equal(candidate.fixedScheduleIds[0], fixedId);
assert.equal(candidate.legacySnapshot.availableSessionsNow, 3);
assert.equal(candidate.legacySnapshot.legacyFixedScheduleDebt, 2);
assert.equal(candidate.commercialRule.createsCustomPlan, false);
assert.ok(candidate.warnings.some((item) => item.includes("adicional")));

const payload = buildServiceSubscriptionCreatePayload(candidate, {
  actorId,
  batchId: "test-batch-1",
  notes: "Prueba controlada",
  bootstrapSource: "legacy_migration",
  now: new Date("2026-08-03T12:30:00.000Z"),
});

assert.equal(String(payload.pricingPlan), cashPlanId);
assert.equal(payload.monthlySessions, 4);
assert.equal(payload.price, 40000);
assert.equal(payload.bootstrap.source, "legacy_migration");
assert.equal(payload.bootstrap.version, "subscriptions-v1-paid-history-auto");
assert.equal(payload.bootstrap.planResolutionMethod, "exact_pricing_plan");
assert.equal(payload.bootstrap.paidCredits, 4);
assert.equal(payload.bootstrap.paidPayMethod, "CASH");
assert.equal(payload.bootstrap.extraSessionsRequired, 1);
assert.equal(String(payload.bootstrap.latestPaidOrder.orderId), orderId);

const noHistoryCandidate = buildInitialSubscriptionCandidate({
  user,
  serviceKey: "EP",
  monthKey: "2026-09",
  schedules,
  blocks: [],
  pricingPlans: plans,
  selectedPricingPlanId: "",
  latestPaidOrder: null,
});
assert.equal(noHistoryCandidate.canCreate, false);
assert.equal(noHistoryCandidate.planResolution.method, "no_paid_plan_history");

const duplicateCandidate = buildInitialSubscriptionCandidate({
  user,
  serviceKey: "EP",
  monthKey: "2026-09",
  schedules,
  blocks: [],
  pricingPlans: plans,
  selectedPricingPlanId: "",
  existingSubscription: {
    _id: "64a000000000000000000007",
    user: userId,
    serviceKey: "EP",
    status: "active",
    monthlySessions: 4,
    price: 40000,
    payMethod: "CASH",
  },
  latestPaidOrder: paidOrder,
});
assert.equal(duplicateCandidate.canCreate, false);
assert.ok(duplicateCandidate.errors.some((item) => item.includes("ya tiene")));

assert.equal(
  canRollbackBootstrapSubscription({
    subscription: {
      bootstrap: { source: "legacy_migration" },
      lastRenewedAt: null,
    },
    billingCyclesCount: 0,
  }).allowed,
  true
);
assert.equal(
  canRollbackBootstrapSubscription({
    subscription: {
      bootstrap: { source: "legacy_migration" },
      lastRenewedAt: null,
    },
    billingCyclesCount: 1,
  }).allowed,
  false
);

console.log("✅ subscriptionBootstrap: todas las pruebas pasaron.");
