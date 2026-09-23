import SubscriptionBillingCycle from "../../models/SubscriptionBillingCycle.js";
import { applySubscriptionCyclePayment } from "./subscriptionBillingLedger.js";
import {
  getSubscriptionRenewalItems,
  idOf,
} from "./subscriptionCyclePaymentHelpers.js";

export {
  buildSubscriptionRenewalItem,
  getSubscriptionRenewalItems,
  orderContainsOnlySubscriptionRenewals,
} from "./subscriptionCyclePaymentHelpers.js";

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function paymentAmountForItem(order, item, itemCount) {
  const itemAmount = money(item?.price || item?.basePrice);
  if (itemAmount > 0) return itemAmount;

  if (itemCount === 1) {
    return money(order?.totalFinal ?? order?.total ?? order?.price);
  }

  return 0;
}

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
    if (!cycleId) {
      throw new Error("SUBSCRIPTION_RENEWAL_CYCLE_MISSING");
    }

    const amount = paymentAmountForItem(order, item, items.length);
    if (!(amount > 0)) {
      throw new Error("SUBSCRIPTION_RENEWAL_PAYMENT_AMOUNT_INVALID");
    }

    const result = await applySubscriptionCyclePayment({
      cycleId,
      amount,
      paymentProvider: paymentProvider || order?.payMethod || "",
      paymentId: paymentId || order?.mpPaymentId || "",
      orderId: order?._id || null,
      paidAt: paidAt || order?.paidAt || new Date(),
      note: `Pago aplicado desde orden ${String(order?._id || "")}`,
      session,
    });

    results.push(result);
  }

  return {
    ok: true,
    applied: results.filter((row) => !row?.alreadyApplied).length,
    cycles: results,
  };
}

export async function releaseSubscriptionRenewalOrder({
  order,
  session = null,
} = {}) {
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

    const result = await SubscriptionBillingCycle.updateOne(
      query,
      update,
      options
    );

    released += Number(result?.modifiedCount || 0);
  }

  return { ok: true, released };
}
