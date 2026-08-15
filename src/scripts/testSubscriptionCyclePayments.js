import assert from "node:assert/strict";
import {
  buildSubscriptionRenewalItem,
  getSubscriptionRenewalItems,
  orderContainsOnlySubscriptionRenewals,
} from "../src/services/subscriptions/subscriptionCyclePaymentHelpers.js";

const cycle = {
  _id: "68a000000000000000000001",
  subscription: "68a000000000000000000002",
  serviceKey: "EP",
  periodKey: "2026-09",
  planSnapshot: {
    pricingPlan: "68a000000000000000000003",
    monthlySessions: 8,
  },
  billing: { total: 70000 },
};

const subscription = {
  _id: "68a000000000000000000002",
  serviceKey: "EP",
  pricingPlan: "68a000000000000000000003",
  monthlySessions: 8,
};

const item = buildSubscriptionRenewalItem({ cycle, subscription });
assert.equal(item.kind, "SUBSCRIPTION_RENEWAL");
assert.equal(item.serviceKey, "EP");
assert.equal(item.credits, 8);
assert.equal(item.periodKey, "2026-09");
assert.equal(item.price, 70000);
assert.equal(String(item.subscriptionCycle), String(cycle._id));

const renewalOrder = { items: [item] };
assert.equal(orderContainsOnlySubscriptionRenewals(renewalOrder), true);
assert.equal(getSubscriptionRenewalItems(renewalOrder).length, 1);
assert.equal(
  orderContainsOnlySubscriptionRenewals({ items: [{ kind: "CREDITS" }] }),
  false
);
assert.equal(getSubscriptionRenewalItems({ items: [] }).length, 0);

console.log("✅ subscriptionCyclePayments: pruebas básicas pasaron.");
