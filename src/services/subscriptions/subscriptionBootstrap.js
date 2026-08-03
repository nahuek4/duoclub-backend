// backend/src/services/subscriptions/subscriptionBootstrap.js
// Construye candidatos y payloads de suscripción inicial sin escribir en MongoDB.

import {
  isValidMonthKey,
  monthRangeFromKey,
  normalizeServiceKey,
} from "./fixedScheduleCoverage.js";
import { buildSubscriptionCoveragePreview } from "./subscriptionCoveragePreview.js";

const RECURRING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN", "NUT"]);
const SERVICE_NAMES = {
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
  NUT: "Nutrición",
};

function cleanString(value) {
  return String(value || "").trim();
}

function cleanMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
}

function cleanPositiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function objectIdString(value) {
  return cleanString(value?._id || value?.id || value);
}

function dateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function summarizeExistingSubscription(subscription = null) {
  if (!subscription) return null;
  return {
    id: objectIdString(subscription),
    serviceKey: normalizeServiceKey(subscription?.serviceKey),
    status: cleanString(subscription?.status),
    monthlySessions: Number(subscription?.monthlySessions || 0),
    price: Number(subscription?.price || 0),
    payMethod: cleanString(subscription?.payMethod).toUpperCase(),
    currentPeriodKey: cleanString(subscription?.currentPeriodKey),
    autoRenew: subscription?.autoRenew !== false,
    createdAt: dateOrNull(subscription?.createdAt)?.toISOString() || null,
  };
}

export function summarizePaidOrderForService(order = null, serviceKey = "") {
  if (!order) return null;
  const key = normalizeServiceKey(serviceKey);
  if (!key) return null;

  const items = Array.isArray(order?.items) ? order.items : [];
  const matching = items.filter((item) => {
    const kind = cleanString(item?.kind).toUpperCase();
    return (
      ["CREDITS", "MANUAL_SERVICE"].includes(kind) &&
      normalizeServiceKey(item?.serviceKey) === key
    );
  });

  let sessions = 0;
  let amount = 0;
  let pricingPlanId = "";

  for (const item of matching) {
    const qty = Math.max(1, Math.trunc(Number(item?.qty || 1)));
    sessions += Math.max(0, Math.trunc(Number(item?.credits || 0))) * qty;
    amount += Math.max(0, Number(item?.price || 0)) * qty;
    if (!pricingPlanId && item?.pricingPlanId) {
      pricingPlanId = objectIdString(item.pricingPlanId);
    }
  }

  if (!matching.length && normalizeServiceKey(order?.serviceKey) === key) {
    sessions = Math.max(0, Math.trunc(Number(order?.credits || 0)));
    amount = Math.max(0, Number(order?.totalFinal ?? order?.total ?? order?.price ?? 0));
  }

  if (!matching.length && !sessions) return null;

  return {
    orderId: objectIdString(order),
    status: cleanString(order?.status).toLowerCase(),
    paidAt: dateOrNull(order?.paidAt || order?.createdAt)?.toISOString() || null,
    sessions,
    amount: Math.round(amount || Number(order?.totalFinal || 0)),
    payMethod: cleanString(order?.payMethod).toUpperCase(),
    pricingPlanId,
  };
}

function resolveExplicitPlan({
  pricingPlans = [],
  selectedPricingPlanId = "",
  manualMonthlySessions = null,
  manualPrice = null,
  manualPayMethod = "",
} = {}) {
  const planId = cleanString(selectedPricingPlanId);

  if (planId) {
    const plan = (Array.isArray(pricingPlans) ? pricingPlans : []).find(
      (item) => objectIdString(item) === planId
    );
    if (!plan) {
      return {
        ok: false,
        error: "El plan seleccionado no está disponible para este servicio.",
      };
    }

    const sessions = cleanPositiveInteger(plan?.credits);
    const price = cleanMoney(plan?.price);
    const payMethod = cleanString(plan?.payMethod).toUpperCase();

    if (!sessions || price === null || !["CASH", "MP"].includes(payMethod)) {
      return { ok: false, error: "El plan seleccionado tiene datos inválidos." };
    }

    return {
      ok: true,
      source: "pricing_plan",
      pricingPlanId: objectIdString(plan),
      monthlySessions: sessions,
      price,
      regularPrice: price,
      payMethod,
      label:
        cleanString(plan?.customTitle) ||
        cleanString(plan?.label) ||
        `${sessions} sesiones`,
      isCustom: plan?.isCustom === true,
    };
  }

  const sessions = cleanPositiveInteger(manualMonthlySessions);
  const price = cleanMoney(manualPrice);
  const payMethod = cleanString(manualPayMethod).toUpperCase();

  if (!sessions || price === null || !["CASH", "MP"].includes(payMethod)) {
    return {
      ok: false,
      error:
        "Indicá pricingPlanId o completá monthlySessions, price y payMethod.",
    };
  }

  return {
    ok: true,
    source: "manual",
    pricingPlanId: "",
    monthlySessions: sessions,
    price,
    regularPrice: price,
    payMethod,
    label: `Plan manual · ${sessions} sesiones`,
    isCustom: false,
  };
}

export function buildInitialSubscriptionCandidate({
  user,
  serviceKey,
  monthKey,
  schedules = [],
  blocks = [],
  pricingPlans = [],
  selectedPricingPlanId = "",
  manualMonthlySessions = null,
  manualPrice = null,
  manualPayMethod = "",
  autoRenew = true,
  existingSubscription = null,
  latestPaidOrder = null,
  includeCustomPlans = false,
  now = new Date(),
} = {}) {
  const normalizedServiceKey = normalizeServiceKey(serviceKey);
  if (!normalizedServiceKey || !RECURRING_SERVICE_KEYS.has(normalizedServiceKey)) {
    throw new Error(`INVALID_SERVICE_KEY:${cleanString(serviceKey)}`);
  }
  if (!isValidMonthKey(monthKey)) {
    throw new Error(`INVALID_MONTH_KEY:${cleanString(monthKey)}`);
  }
  if (!user || !objectIdString(user)) {
    throw new Error("INVALID_USER");
  }

  const explicitPlan = resolveExplicitPlan({
    pricingPlans,
    selectedPricingPlanId,
    manualMonthlySessions,
    manualPrice,
    manualPayMethod,
  });

  const errors = [];
  const warnings = [];
  const role = cleanString(user?.role).toLowerCase();

  if (role && role !== "client") {
    errors.push("Solo se inicializan suscripciones para usuarios con rol client.");
  }
  if (existingSubscription) {
    errors.push("El usuario ya tiene una suscripción para este servicio.");
  }
  if (!explicitPlan.ok) {
    errors.push(explicitPlan.error);
  }

  const preview = buildSubscriptionCoveragePreview({
    user,
    serviceKey: normalizedServiceKey,
    monthKey,
    schedules,
    blocks,
    pricingPlans,
    selectedPricingPlanId: explicitPlan.ok ? explicitPlan.pricingPlanId : "",
    manualMonthlySessions: explicitPlan.ok ? explicitPlan.monthlySessions : 0,
    extraSessionsSelected: 0,
    manualPayMethod: explicitPlan.ok ? explicitPlan.payMethod : "",
    includeCustomPlans,
    now,
  });

  if (preview.legacySnapshot.legacyFixedScheduleDebt > 0) {
    warnings.push(
      "Existe deuda legacy para este servicio. Se fotografiará, pero no se modificará ni se trasladará a la suscripción."
    );
  }
  if (preview.coverage.additionalSessionsStillNeeded > 0) {
    warnings.push(
      `El plan seleccionado no cubre ${preview.coverage.additionalSessionsStillNeeded} turno(s) fijo(s) del mes. Esas sesiones se resolverán en el ciclo mensual, no durante el bootstrap.`
    );
  }
  if (!preview.fixedSchedules.length) {
    warnings.push("El usuario no tiene turnos fijos activos para este servicio y período.");
  }
  if (preview.coverage.duplicateOccurrences.length) {
    warnings.push("Se detectaron ocurrencias fijas duplicadas; se contabilizó una sola por fecha y horario.");
  }

  const paidOrder = summarizePaidOrderForService(
    latestPaidOrder,
    normalizedServiceKey
  );
  const period = monthRangeFromKey(monthKey);

  const selectedPlan = explicitPlan.ok
    ? {
        source: explicitPlan.source,
        pricingPlanId: explicitPlan.pricingPlanId,
        monthlySessions: explicitPlan.monthlySessions,
        price: explicitPlan.price,
        regularPrice: explicitPlan.regularPrice,
        payMethod: explicitPlan.payMethod,
        label: explicitPlan.label,
        isCustom: explicitPlan.isCustom,
      }
    : null;

  const fixedScheduleIds = preview.fixedSchedules
    .map((item) => cleanString(item?.id))
    .filter(Boolean);

  return {
    readOnly: true,
    canCreate: errors.length === 0,
    generatedAt: now.toISOString(),
    errors,
    warnings,
    user: preview.user,
    service: {
      key: normalizedServiceKey,
      name: SERVICE_NAMES[normalizedServiceKey] || normalizedServiceKey,
    },
    period: {
      monthKey,
      startDate: period.startYmd,
      endDate: period.endYmd,
    },
    selectedPlan,
    coverage: preview.coverage,
    fixedSchedules: preview.fixedSchedules,
    fixedScheduleIds,
    legacySnapshot: preview.legacySnapshot,
    latestPaidOrder: paidOrder,
    existingSubscription: summarizeExistingSubscription(existingSubscription),
    autoRenew: autoRenew !== false,
  };
}

export function buildServiceSubscriptionCreatePayload(candidate, {
  actorId = null,
  batchId,
  notes = "",
  now = new Date(),
} = {}) {
  if (!candidate?.canCreate || !candidate?.selectedPlan) {
    throw new Error("CANDIDATE_NOT_CREATABLE");
  }

  const cleanBatchId = cleanString(batchId);
  if (!cleanBatchId) throw new Error("BATCH_ID_REQUIRED");

  const plan = candidate.selectedPlan;
  const latestOrder = candidate.latestPaidOrder;

  return {
    user: candidate.user.id,
    serviceKey: candidate.service.key,
    serviceName: candidate.service.name,
    pricingPlan: plan.pricingPlanId || null,
    status: "active",
    autoRenew: candidate.autoRenew !== false,
    monthlySessions: plan.monthlySessions,
    price: plan.price,
    regularPrice: plan.regularPrice,
    coveragePrice: null,
    coverageApplied: false,
    coverageReason: "",
    payMethod: plan.payMethod,
    fixedScheduleIds: candidate.fixedScheduleIds,
    addOns: [],
    currentPeriodKey: candidate.period.monthKey,
    currentPeriodStart: new Date(`${candidate.period.startDate}T12:00:00.000Z`),
    currentPeriodEnd: new Date(`${candidate.period.endDate}T12:00:00.000Z`),
    lastRenewedAt: null,
    pendingChange: null,
    bootstrap: {
      source: "admin_initialization",
      version: "subscriptions-v1",
      batchId: cleanBatchId,
      initializedAt: now,
      initializedBy: actorId,
      monthKey: candidate.period.monthKey,
      fixedScheduleIdsAtBootstrap: candidate.fixedScheduleIds,
      legacyAvailableSessions:
        candidate.legacySnapshot.availableSessionsNow || 0,
      legacyFixedScheduleDebt:
        candidate.legacySnapshot.legacyFixedScheduleDebt || 0,
      latestPaidOrder: latestOrder
        ? {
            orderId: latestOrder.orderId || null,
            paidAt: latestOrder.paidAt ? new Date(latestOrder.paidAt) : null,
            sessions: latestOrder.sessions || 0,
            amount: latestOrder.amount || 0,
            payMethod: latestOrder.payMethod || "",
          }
        : null,
      notes: cleanString(notes),
    },
    createdBy: actorId,
    updatedBy: actorId,
  };
}

export function canRollbackBootstrapSubscription({
  subscription,
  billingCyclesCount = 0,
} = {}) {
  if (!subscription) {
    return { allowed: false, reason: "SUBSCRIPTION_NOT_FOUND" };
  }
  if (subscription?.bootstrap?.source !== "admin_initialization") {
    return { allowed: false, reason: "NOT_BOOTSTRAP_SUBSCRIPTION" };
  }
  if (Number(billingCyclesCount || 0) > 0) {
    return { allowed: false, reason: "HAS_BILLING_CYCLES" };
  }
  if (subscription?.lastRenewedAt) {
    return { allowed: false, reason: "ALREADY_RENEWED" };
  }
  return { allowed: true, reason: "" };
}
