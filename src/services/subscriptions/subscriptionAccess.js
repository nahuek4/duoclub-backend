import ServiceSubscription from "../../models/ServiceSubscription.js";

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
