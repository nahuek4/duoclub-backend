// backend/scripts/testSubscriptionBootstrap.js
import assert from "node:assert/strict";
import {
  buildInitialSubscriptionCandidate,
  buildServiceSubscriptionCreatePayload,
  canRollbackBootstrapSubscription,
  summarizePaidOrderForService,
} from "../src/services/subscriptions/subscriptionBootstrap.js";

const userId = "64a000000000000000000001";
const planId = "64a000000000000000000002";
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
    _id: planId,
    serviceKey: "EP",
    payMethod: "CASH",
    credits: 4,
    price: 40000,
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
      price: 40000,
      pricingPlanId: planId,
    },
  ],
};

const orderSummary = summarizePaidOrderForService(paidOrder, "EP");
assert.equal(orderSummary.sessions, 4);
assert.equal(orderSummary.amount, 40000);
assert.equal(orderSummary.pricingPlanId, planId);

const candidate = buildInitialSubscriptionCandidate({
  user,
  serviceKey: "EP",
  monthKey: "2026-09",
  schedules,
  blocks: [],
  pricingPlans: plans,
  selectedPricingPlanId: planId,
  existingSubscription: null,
  latestPaidOrder: paidOrder,
  now: new Date("2026-08-03T12:00:00.000Z"),
});

assert.equal(candidate.canCreate, true);
assert.equal(candidate.selectedPlan.monthlySessions, 4);
assert.equal(candidate.coverage.fixedOccurrencesCount, 5);
assert.equal(candidate.coverage.additionalSessionsStillNeeded, 1);
assert.equal(candidate.fixedScheduleIds[0], fixedId);
assert.equal(candidate.legacySnapshot.availableSessionsNow, 3);
assert.equal(candidate.legacySnapshot.legacyFixedScheduleDebt, 2);
assert.ok(candidate.warnings.some((item) => item.includes("deuda legacy")));

const payload = buildServiceSubscriptionCreatePayload(candidate, {
  actorId,
  batchId: "test-batch-1",
  notes: "Prueba controlada",
  now: new Date("2026-08-03T12:30:00.000Z"),
});

assert.equal(payload.monthlySessions, 4);
assert.equal(payload.price, 40000);
assert.equal(payload.bootstrap.batchId, "test-batch-1");
assert.equal(payload.bootstrap.legacyFixedScheduleDebt, 2);
assert.equal(String(payload.bootstrap.latestPaidOrder.orderId), orderId);

const duplicateCandidate = buildInitialSubscriptionCandidate({
  user,
  serviceKey: "EP",
  monthKey: "2026-09",
  schedules,
  blocks: [],
  pricingPlans: plans,
  selectedPricingPlanId: planId,
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

const manualCandidate = buildInitialSubscriptionCandidate({
  user,
  serviceKey: "EP",
  monthKey: "2026-09",
  schedules,
  pricingPlans: plans,
  manualMonthlySessions: 8,
  manualPrice: 70000,
  manualPayMethod: "MP",
});

assert.equal(manualCandidate.canCreate, true);
assert.equal(manualCandidate.selectedPlan.source, "manual");
assert.equal(manualCandidate.selectedPlan.monthlySessions, 8);
assert.equal(manualCandidate.coverage.freeSessions, 3);

assert.deepEqual(
  canRollbackBootstrapSubscription({
    subscription: { bootstrap: { source: "admin_initialization" }, lastRenewedAt: null },
    billingCyclesCount: 0,
  }),
  { allowed: true, reason: "" }
);
assert.equal(
  canRollbackBootstrapSubscription({
    subscription: { bootstrap: { source: "admin_initialization" }, lastRenewedAt: null },
    billingCyclesCount: 1,
  }).allowed,
  false
);

console.log("✅ subscriptionBootstrap: todas las pruebas pasaron.");
