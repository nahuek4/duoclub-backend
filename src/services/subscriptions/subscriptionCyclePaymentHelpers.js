function clean(value) {
  return String(value || "").trim();
}

export function idOf(value) {
  return clean(value?._id || value?.id || value);
}

export function getSubscriptionRenewalItems(order = {}) {
  return (Array.isArray(order?.items) ? order.items : []).filter(
    (item) => String(item?.kind || "").toUpperCase().trim() === "SUBSCRIPTION_RENEWAL"
  );
}

export function orderContainsOnlySubscriptionRenewals(order = {}) {
  const items = Array.isArray(order?.items) ? order.items : [];
  return (
    items.length > 0 &&
    items.every(
      (item) => String(item?.kind || "").toUpperCase().trim() === "SUBSCRIPTION_RENEWAL"
    )
  );
}

export function buildSubscriptionRenewalItem({
  cycle,
  subscription,
  amount = null,
} = {}) {
  if (!cycle) throw new Error("SUBSCRIPTION_CYCLE_REQUIRED");
  if (!subscription) throw new Error("SUBSCRIPTION_REQUIRED");

  const total = Math.max(0, Math.round(Number(cycle?.billing?.total || 0)));
  const amountPaid = Math.max(
    0,
    Math.round(Number(cycle?.billing?.amountPaid || 0))
  );
  const balanceDue =
    cycle?.billing?.balanceDue !== null &&
    cycle?.billing?.balanceDue !== undefined
      ? Math.max(0, Math.round(Number(cycle.billing.balanceDue || 0)))
      : Math.max(0, total - amountPaid);

  const requestedAmount =
    amount === null || amount === undefined || amount === ""
      ? balanceDue
      : Math.max(0, Math.round(Number(amount || 0)));

  if (!(requestedAmount > 0)) {
    throw new Error("SUBSCRIPTION_PAYMENT_AMOUNT_INVALID");
  }

  const sessions = Math.max(
    1,
    Math.trunc(
      Number(
        cycle?.planSnapshot?.monthlySessions ||
          subscription?.monthlySessions ||
          1
      )
    )
  );

  return {
    kind: "SUBSCRIPTION_RENEWAL",
    serviceKey: String(
      cycle.serviceKey || subscription.serviceKey || ""
    )
      .toUpperCase()
      .trim(),
    credits: sessions,
    label: `Pago plan ${String(
      cycle.serviceKey || subscription.serviceKey || ""
    )
      .toUpperCase()
      .trim()} · ${cycle.periodKey}`,
    pricingPlanId:
      cycle?.planSnapshot?.pricingPlan || subscription?.pricingPlan || null,
    isCustom: false,
    subscription: subscription._id,
    subscriptionCycle: cycle._id,
    periodKey: cycle.periodKey,
    qty: 1,
    basePrice: requestedAmount,
    price: requestedAmount,
  };
}
