import SubscriptionBillingCycle from "../../models/SubscriptionBillingCycle.js";
import { markSubscriptionCyclePaid } from "./subscriptionLifecycle.js";
import {
  getSubscriptionRenewalItems,
  idOf,
} from "./subscriptionCyclePaymentHelpers.js";

export {
  buildSubscriptionRenewalItem,
  getSubscriptionRenewalItems,
  orderContainsOnlySubscriptionRenewals,
} from "./subscriptionCyclePaymentHelpers.js";

export async function applySubscriptionRenewalFromOrder({
  order,
  session = null,
  paymentProvider = "",
  paymentId = "",
  paidAt = null,
} = {}) {
  const items = getSubscriptionRenewalItems(order);
  if (!items.length) {
    return { ok: true, applied: 0, cycles: [] };
  }

  const results = [];
  for (const item of items) {
    const cycleId = idOf(item?.subscriptionCycle);
    if (!cycleId) throw new Error("SUBSCRIPTION_RENEWAL_CYCLE_MISSING");

    const result = await markSubscriptionCyclePaid({
      cycleId,
      paymentProvider: paymentProvider || order?.payMethod || "",
      paymentId: paymentId || order?.mpPaymentId || "",
      orderId: order?._id || null,
      paidAt: paidAt || order?.paidAt || new Date(),
      session,
    });

    results.push(result);
  }

  return {
    ok: true,
    applied: results.filter((row) => !row?.alreadyPaid).length,
    cycles: results,
  };
}

export async function releaseSubscriptionRenewalOrder({ order, session = null } = {}) {
  const items = getSubscriptionRenewalItems(order);
  let released = 0;

  for (const item of items) {
    const cycleId = idOf(item?.subscriptionCycle);
    if (!cycleId) continue;

    const query = {
      _id: cycleId,
      "billing.order": order?._id,
      "billing.status": { $in: ["pending", "overdue"] },
    };
    const update = { $set: { "billing.order": null } };
    const options = session ? { session } : undefined;
    const result = await SubscriptionBillingCycle.updateOne(query, update, options);
    released += Number(result?.modifiedCount || 0);
  }

  return { ok: true, released };
}
