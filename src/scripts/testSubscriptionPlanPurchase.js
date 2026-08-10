import assert from "node:assert/strict";
import { paidOrderPublishedPlanServiceKeys } from "../src/services/subscriptions/subscriptionPlanPurchase.js";

const keys = paidOrderPublishedPlanServiceKeys({
  items: [
    { kind: "CREDITS", serviceKey: "EP", credits: 8, qty: 1 },
    { kind: "SUBSCRIPTION_EXTRA", serviceKey: "EP", credits: 1, qty: 1 },
    { kind: "MEMBERSHIP", membershipTier: "plus", qty: 1 },
  ],
});

assert.equal(keys.has("EP"), true);
assert.equal(keys.size, 1);

const noPlan = paidOrderPublishedPlanServiceKeys({
  items: [{ kind: "SUBSCRIPTION_EXTRA", serviceKey: "RF", credits: 1, qty: 1 }],
});
assert.equal(noPlan.size, 0);

console.log("✅ subscriptionPlanPurchase: pruebas básicas pasaron.");
