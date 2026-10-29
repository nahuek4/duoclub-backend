import { ensureServiceCatalogLoaded, serviceDefinitionCached } from "../serviceCatalogRuntime.js";
import ServiceSubscription from "../../models/ServiceSubscription.js";

import SubscriptionBillingCycle from "../../models/SubscriptionBillingCycle.js";

const BLOCKED = new Set(["suspended", "cancelled", "terminated_for_non_payment"]);

export async function getSubscriptionAccessState({ userId, serviceKey, session = null } = {}) {
  const query = ServiceSubscription.findOne({
    user: userId,
    serviceKey: String(serviceKey || "").toUpperCase().trim(),
  }).select("_id status suspensionReason terminationReason currentPeriodKey");

  if (session) query.session(session);
  const subscription = await query.lean();

  // Compatibilidad: usuarios legacy sin suscripción todavía pueden consumir
  // sus créditos existentes. Solo bloqueamos cuando existe una suscripción y
  // su estado explícitamente impide usar el servicio.
  if (!subscription) {
    return { allowed: true, subscription: null, reason: "NO_SUBSCRIPTION" };
  }

  const status = String(subscription.status || "active");
  return {
    allowed: !BLOCKED.has(status),
    subscription,
    reason: BLOCKED.has(status) ? status : "ACTIVE",
  };
}

export async function assertSubscriptionServiceAccess(args = {}) {
  const state = await getSubscriptionAccessState(args);
  if (state.allowed) return state;

  const error = new Error("SUBSCRIPTION_SERVICE_BLOCKED");
  error.code = "SUBSCRIPTION_SERVICE_BLOCKED";
  error.subscriptionStatus = state.subscription?.status || "";
  error.serviceKey = String(args?.serviceKey || "").toUpperCase().trim();
  throw error;
}

// Un saldo pendiente no implica pago cero: cualquier importe registrado protege el plan.
export function cycleHasAnyPayment(cycle) {
  const b = cycle?.billing || {};
  if (b.status === "paid") return true;
  return [b.amountReceived, b.amountPaid, ...(Array.isArray(b.payments) ? b.payments : []).flatMap(p => [p?.amount, p?.appliedAmount])]
    .some(value => Number.isFinite(Number(value)) && Number(value) > 0);
}

export function unpaidCycleFreezeState(cycle, subscription, now = new Date()) {
  if (!subscription || subscription.status === "cancelled" ||
      !["active", "pending_change", "suspended", "terminated_for_non_payment"].includes(subscription.status) ||
      subscription.currentPeriodKey !== cycle.periodKey ||
      cycle.lifecycle?.planStatus === "cancelled" ||
      !["pending", "overdue"].includes(cycle.billing?.status) ||
      !(Number(cycle.billing?.total) > 0) || cycleHasAnyPayment(cycle) ||
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(cycle.periodKey)) return null;
  const freezeAt = new Date(`${cycle.periodKey}-10T00:00:00-03:00`);
  if (now < freezeAt) return null;
  return {
    serviceKey: cycle.serviceKey, periodKey: cycle.periodKey,
    freezeAt: freezeAt.toISOString(),
    terminateAt: new Date(`${cycle.periodKey}-20T00:00:00-03:00`).toISOString(),
    terminated: subscription.status === "terminated_for_non_payment",
  };
}

export async function getAccountPaymentAccess({ userId, role, now = new Date(), session = null } = {}) {
  if (["admin", "staff", "profesor"].includes(String(role || "").toLowerCase())) {
    return { frozen: false, plans: [] };
  }
  await ensureServiceCatalogLoaded();
  let query = SubscriptionBillingCycle.find({ user: userId, "billing.status": { $in: ["pending", "overdue"] } })
    .select("subscription serviceKey periodKey billing lifecycle")
    .populate({ path: "subscription", select: "status currentPeriodKey serviceKey" });
  if (session) query.session(session);
  const cycles = await query.lean();
  const plans = cycles.filter(c => {
    const service = serviceDefinitionCached(c.serviceKey);
    return !(service?.active === true && service.fixedScheduleEnabled === true && service.recurringPlanEnabled === false);
  }).map(c => unpaidCycleFreezeState(c, c.subscription, now)).filter(Boolean);
  return { frozen: plans.length > 0, plans, freezeDay: 10, terminationDay: 20 };
}

export function isAllowedDuringPaymentFreeze(req) {
  const path = String(req.originalUrl || req.url || "").split("?")[0].replace(/^\/api(?=\/)/, "");
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET") return ["/auth/me", "/pricing", "/services", "/appointments/me/status",
    "/subscription-extras/me", "/orders/me", "/appointments/me/notifications"].includes(path);
  if (method === "POST") return ["/auth/force-change-password", "/orders", "/orders/checkout", "/appointments/me/notifications/read"].includes(path) ||
    /^\/subscriptions\/cycles\/[a-fA-F0-9]{24}\/pay$/.test(path);
  return false;
}
