// backend/scripts/testSubscriptionExtraSessions.js
import assert from "node:assert/strict";
import mongoose from "mongoose";

import Order from "../src/models/Order.js";
import SubscriptionExtraSessionNotice from "../src/models/SubscriptionExtraSessionNotice.js";
import {
  calculateProportionalExtraPrice,
  resolveExtraSessionPeriodKey,
} from "../src/services/subscriptions/subscriptionExtraSessions.js";

const price = calculateProportionalExtraPrice({
  planPrice: 70000,
  planSessions: 8,
  extraSessions: 1,
});
assert.equal(price.unitPrice, 8750);
assert.equal(price.totalPrice, 8750);

const multiPrice = calculateProportionalExtraPrice({
  planPrice: 90000,
  planSessions: 12,
  extraSessions: 2,
});
assert.equal(multiPrice.unitPrice, 7500);
assert.equal(multiPrice.totalPrice, 15000);

assert.equal(
  resolveExtraSessionPeriodKey(
    { currentPeriodKey: "2026-09" },
    new Date("2026-08-04T06:00:00.000Z")
  ),
  "2026-09"
);

assert.equal(
  resolveExtraSessionPeriodKey(
    { currentPeriodKey: "2026-07" },
    new Date("2026-08-04T06:00:00.000Z")
  ),
  "2026-08"
);

const ids = {
  user: new mongoose.Types.ObjectId(),
  subscription: new mongoose.Types.ObjectId(),
  notice: new mongoose.Types.ObjectId(),
  plan: new mongoose.Types.ObjectId(),
};

const notice = new SubscriptionExtraSessionNotice({
  _id: ids.notice,
  user: ids.user,
  subscription: ids.subscription,
  serviceKey: "EP",
  periodKey: "2026-09",
  basePlanSessions: 8,
  projectedFixedOccurrences: 9,
  extraSessionsRequired: 1,
});
await notice.validate();
assert.equal(notice.status, "pending");
assert.equal(notice.remainingSessions, 1);

const order = new Order({
  user: ids.user,
  payMethod: "CASH",
  items: [
    {
      kind: "SUBSCRIPTION_EXTRA",
      serviceKey: "EP",
      credits: 1,
      label: "1 sesión adicional · 2026-09",
      pricingPlanId: ids.plan,
      subscription: ids.subscription,
      extraSessionNotice: ids.notice,
      periodKey: "2026-09",
      qty: 1,
      basePrice: 8750,
      price: 8750,
    },
  ],
  total: 8750,
  totalFinal: 8750,
  suppressUserEmails: true,
});
await order.validate();
assert.equal(order.items[0].kind, "SUBSCRIPTION_EXTRA");
assert.equal(order.items[0].qty, 1);
assert.equal(order.suppressUserEmails, true);

console.log("✅ subscriptionExtraSessions: todas las pruebas pasaron.");
