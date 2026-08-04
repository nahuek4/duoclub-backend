// Resuelve el plan mensual inicial exclusivamente desde la última compra pagada
// del usuario para el servicio. Los turnos fijos NO determinan el plan base.

import { normalizeServiceKey } from "./fixedScheduleCoverage.js";

function clean(value) {
  return String(value || "").trim();
}

function idOf(value) {
  return clean(value?._id || value?.id || value);
}

function positiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function nonNegativeMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function validDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function summarizePlan(plan = null) {
  if (!plan) return null;
  const sessions = positiveInteger(plan?.credits);
  return {
    pricingPlanId: idOf(plan),
    serviceKey: normalizeServiceKey(plan?.serviceKey),
    monthlySessions: sessions,
    price: nonNegativeMoney(plan?.price),
    payMethod: clean(plan?.payMethod).toUpperCase(),
    label:
      clean(plan?.customTitle) ||
      clean(plan?.label) ||
      `${sessions} ${sessions === 1 ? "sesión" : "sesiones"}`,
    active: plan?.active !== false,
    isCustom: plan?.isCustom === true,
  };
}

export function summarizePaidOrderForService(order = null, serviceKey = "") {
  if (!order) return null;
  const key = normalizeServiceKey(serviceKey);
  if (!key) return null;

  const items = Array.isArray(order?.items) ? order.items : [];
  const matching = items.filter((item) => {
    const kind = clean(item?.kind).toUpperCase();
    return (
      ["CREDITS", "MANUAL_SERVICE"].includes(kind) &&
      normalizeServiceKey(item?.serviceKey) === key &&
      positiveInteger(item?.credits) > 0
    );
  });

  let sessions = 0;
  let amount = 0;
  let baseAmount = 0;
  const pricingPlanIds = new Set();
  let containsCustomItem = false;

  for (const item of matching) {
    const qty = Math.max(1, positiveInteger(item?.qty) || 1);
    sessions += positiveInteger(item?.credits) * qty;
    amount += nonNegativeMoney(item?.price) * qty;
    baseAmount += nonNegativeMoney(item?.basePrice || item?.price) * qty;
    if (item?.pricingPlanId) pricingPlanIds.add(idOf(item.pricingPlanId));
    if (item?.isCustom === true) containsCustomItem = true;
  }

  // Compatibilidad con órdenes legacy sin items.
  if (!matching.length && normalizeServiceKey(order?.serviceKey) === key) {
    sessions = positiveInteger(order?.credits);
    amount = nonNegativeMoney(
      order?.totalFinal ?? order?.total ?? order?.price ?? 0
    );
    baseAmount = nonNegativeMoney(order?.basePrice || order?.price || amount);
  }

  if (!sessions) return null;

  const ids = [...pricingPlanIds].filter(Boolean);
  return {
    orderId: idOf(order),
    status: clean(order?.status).toLowerCase(),
    paidAt:
      validDate(order?.paidAt || order?.createdAt)?.toISOString() || null,
    sessions,
    amount: amount || nonNegativeMoney(order?.totalFinal || order?.total),
    baseAmount,
    payMethod: clean(order?.payMethod).toUpperCase(),
    pricingPlanId: ids.length === 1 ? ids[0] : "",
    pricingPlanIds: ids,
    matchingItemsCount: matching.length,
    containsCustomItem,
  };
}

export function resolvePublishedPlanFromPaidOrder({
  latestPaidOrder = null,
  pricingPlans = [],
  serviceKey = "",
  includeCustomPlans = false,
} = {}) {
  const key = normalizeServiceKey(serviceKey);
  const order = summarizePaidOrderForService(latestPaidOrder, key);

  if (!order) {
    return {
      ok: false,
      method: "no_paid_plan_history",
      reason: "No existe una compra pagada con créditos para este servicio.",
      order: null,
      publishedPlan: null,
      candidatePlanIds: [],
    };
  }

  const activePlans = (Array.isArray(pricingPlans) ? pricingPlans : []).filter(
    (plan) =>
      plan?.active !== false &&
      normalizeServiceKey(plan?.serviceKey) === key &&
      (includeCustomPlans || plan?.isCustom !== true) &&
      positiveInteger(plan?.credits) > 0 &&
      ["CASH", "MP"].includes(clean(plan?.payMethod).toUpperCase())
  );

  const exact = order.pricingPlanId
    ? activePlans.find((plan) => idOf(plan) === order.pricingPlanId)
    : null;

  if (exact) {
    return {
      ok: true,
      method: "exact_pricing_plan",
      reason: "Se conservó el PricingPlan activo de la última compra pagada.",
      order,
      publishedPlan: summarizePlan(exact),
      candidatePlanIds: [idOf(exact)],
    };
  }

  const sameCreditsAndMethod = activePlans.filter(
    (plan) =>
      positiveInteger(plan?.credits) === order.sessions &&
      clean(plan?.payMethod).toUpperCase() === order.payMethod
  );

  if (sameCreditsAndMethod.length === 1) {
    return {
      ok: true,
      method: "matched_by_paid_credits",
      reason:
        "Se vinculó el plan activo equivalente por servicio, créditos abonados y método de pago.",
      order,
      publishedPlan: summarizePlan(sameCreditsAndMethod[0]),
      candidatePlanIds: [idOf(sameCreditsAndMethod[0])],
    };
  }

  if (sameCreditsAndMethod.length > 1) {
    const paidAmounts = new Set(
      [order.baseAmount, order.amount].filter((value) => Number(value) > 0)
    );
    const samePrice = sameCreditsAndMethod.filter((plan) =>
      paidAmounts.has(nonNegativeMoney(plan?.price))
    );

    if (samePrice.length === 1) {
      return {
        ok: true,
        method: "matched_by_paid_credits_and_price",
        reason:
          "Había más de un plan con los mismos créditos; se resolvió por el importe abonado.",
        order,
        publishedPlan: summarizePlan(samePrice[0]),
        candidatePlanIds: [idOf(samePrice[0])],
      };
    }

    return {
      ok: false,
      method: "ambiguous_paid_plan",
      reason:
        "Hay más de un plan activo con el mismo servicio, créditos y método de pago.",
      order,
      publishedPlan: null,
      candidatePlanIds: sameCreditsAndMethod.map(idOf),
    };
  }

  return {
    ok: false,
    method: "no_active_plan_for_paid_credits",
    reason: `No existe un plan activo ${key} de ${order.sessions} créditos con pago ${order.payMethod}.`,
    order,
    publishedPlan: null,
    candidatePlanIds: [],
  };
}
