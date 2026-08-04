// backend/src/services/subscriptions/subscriptionBootstrap.js
// Construye candidatos y payloads de suscripción inicial sin escribir MongoDB.
// La suscripción siempre se vincula a un PricingPlan publicado; nunca se crea
// un plan adaptado a la cantidad de turnos fijos del mes.

import {
  isValidMonthKey,
  monthRangeFromKey,
  normalizeServiceKey,
} from "./fixedScheduleCoverage.js";
import { buildSubscriptionCoveragePreview } from "./subscriptionCoveragePreview.js";
import {
  resolvePublishedPlanFromPaidOrder,
  summarizePaidOrderForService,
} from "./paidPlanResolver.js";

export { resolvePublishedPlanFromPaidOrder, summarizePaidOrderForService };

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
    pricingPlanId: objectIdString(subscription?.pricingPlan),
    status: cleanString(subscription?.status),
    monthlySessions: Number(subscription?.monthlySessions || 0),
    price: Number(subscription?.price || 0),
    payMethod: cleanString(subscription?.payMethod).toUpperCase(),
    currentPeriodKey: cleanString(subscription?.currentPeriodKey),
    autoRenew: subscription?.autoRenew !== false,
    createdAt: dateOrNull(subscription?.createdAt)?.toISOString() || null,
  };
}

function resolvePublishedPlan({
  pricingPlans = [],
  selectedPricingPlanId = "",
  serviceKey,
  includeCustomPlans = false,
} = {}) {
  const planId = cleanString(selectedPricingPlanId);
  if (!planId) {
    return {
      ok: false,
      error:
        "Seleccioná pricingPlanId de uno de los planes activos publicados. No se permiten planes manuales.",
    };
  }

  const plan = (Array.isArray(pricingPlans) ? pricingPlans : []).find(
    (item) => objectIdString(item) === planId
  );
  if (!plan) {
    return {
      ok: false,
      error:
        "El plan seleccionado no está disponible entre los planes publicados para este servicio.",
    };
  }

  if (plan?.active === false) {
    return { ok: false, error: "El plan seleccionado está inactivo." };
  }
  if (!includeCustomPlans && plan?.isCustom === true) {
    return {
      ok: false,
      error:
        "Las tarjetas personalizadas no se usan como plan mensual recurrente.",
    };
  }

  const normalizedServiceKey = normalizeServiceKey(serviceKey);
  if (normalizeServiceKey(plan?.serviceKey) !== normalizedServiceKey) {
    return {
      ok: false,
      error: "El plan seleccionado pertenece a otro servicio.",
    };
  }

  const monthlySessions = cleanPositiveInteger(plan?.credits);
  const price = cleanMoney(plan?.price);
  const payMethod = cleanString(plan?.payMethod).toUpperCase();

  if (!monthlySessions || price === null || !["CASH", "MP"].includes(payMethod)) {
    return { ok: false, error: "El plan publicado tiene datos inválidos." };
  }

  return {
    ok: true,
    source: "published_pricing_plan",
    pricingPlanId: objectIdString(plan),
    monthlySessions,
    price,
    regularPrice: price,
    payMethod,
    label:
      cleanString(plan?.customTitle) ||
      cleanString(plan?.label) ||
      `${monthlySessions} sesiones`,
    isCustom: plan?.isCustom === true,
  };
}

function buildPaidOrderPlanEvidence({ latestPaidOrder, pricingPlans, serviceKey }) {
  return resolvePublishedPlanFromPaidOrder({
    latestPaidOrder,
    pricingPlans,
    serviceKey,
    includeCustomPlans: false,
  });
}
export function buildInitialSubscriptionCandidate({
  user,
  serviceKey,
  monthKey,
  schedules = [],
  blocks = [],
  pricingPlans = [],
  selectedPricingPlanId = "",
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

  const automaticPlanResolution = resolvePublishedPlanFromPaidOrder({
    latestPaidOrder,
    pricingPlans,
    serviceKey: normalizedServiceKey,
    includeCustomPlans,
  });

  const explicitPlanId = cleanString(selectedPricingPlanId);
  const effectivePlanId =
    explicitPlanId || automaticPlanResolution?.publishedPlan?.pricingPlanId || "";

  const publishedPlan = resolvePublishedPlan({
    pricingPlans,
    selectedPricingPlanId: effectivePlanId,
    serviceKey: normalizedServiceKey,
    includeCustomPlans,
  });

  if (publishedPlan.ok) {
    publishedPlan.source = explicitPlanId
      ? "explicit_pricing_plan"
      : automaticPlanResolution.method;
  }

  const errors = [];
  const warnings = [];
  const role = cleanString(user?.role).toLowerCase();

  if (role && role !== "client") {
    errors.push("Solo se inicializan suscripciones para usuarios con rol client.");
  }
  if (existingSubscription) {
    errors.push("El usuario ya tiene una suscripción para este servicio.");
  }
  if (!publishedPlan.ok) {
    errors.push(
      explicitPlanId
        ? publishedPlan.error
        : automaticPlanResolution.reason || publishedPlan.error
    );
  }

  const preview = buildSubscriptionCoveragePreview({
    user,
    serviceKey: normalizedServiceKey,
    monthKey,
    schedules,
    blocks,
    pricingPlans,
    selectedPricingPlanId: publishedPlan.ok
      ? publishedPlan.pricingPlanId
      : effectivePlanId,
    extraSessionsSelected: 0,
    includeCustomPlans,
    now,
  });

  if (preview.legacySnapshot.legacyFixedScheduleDebt > 0) {
    warnings.push(
      "Existe deuda legacy para este servicio. Se fotografiará, pero no se modificará ni se trasladará a la suscripción."
    );
  }
  if (preview.coverage.extraSessionsPending > 0 && publishedPlan.ok) {
    warnings.push(
      `El plan publicado se mantiene en ${publishedPlan.monthlySessions} sesiones. Para cubrir ${monthKey} el usuario deberá comprar ${preview.coverage.extraSessionsPending} sesión(es) adicional(es).`
    );
  }
  if (!preview.fixedSchedules.length) {
    warnings.push(
      "El usuario no tiene turnos fijos proyectados para este servicio y período."
    );
  }
  if (preview.coverage.duplicateOccurrences.length) {
    warnings.push(
      "Se detectaron ocurrencias fijas duplicadas; se contabilizó una sola por fecha y horario."
    );
  }

  const paidOrderPlanEvidence = buildPaidOrderPlanEvidence({
    latestPaidOrder,
    pricingPlans,
    serviceKey: normalizedServiceKey,
  });
  const period = monthRangeFromKey(monthKey);

  const selectedPlan = publishedPlan.ok
    ? {
        source: publishedPlan.source,
        pricingPlanId: publishedPlan.pricingPlanId,
        monthlySessions: publishedPlan.monthlySessions,
        price: publishedPlan.price,
        regularPrice: publishedPlan.regularPrice,
        payMethod: publishedPlan.payMethod,
        label: publishedPlan.label,
        isCustom: publishedPlan.isCustom,
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
    publishedPlan: selectedPlan,
    // Alias temporal para consumidores de la Etapa 3 anterior.
    selectedPlan,
    coverage: preview.coverage,
    fixedSchedules: preview.fixedSchedules,
    fixedScheduleIds,
    legacySnapshot: preview.legacySnapshot,
    latestPaidOrder: paidOrderPlanEvidence?.order || null,
    planResolution: {
      ok: Boolean(publishedPlan.ok),
      method: explicitPlanId
        ? "explicit_pricing_plan"
        : automaticPlanResolution.method,
      reason: explicitPlanId
        ? "Plan publicado indicado explícitamente."
        : automaticPlanResolution.reason,
      pricingPlanId: publishedPlan.ok ? publishedPlan.pricingPlanId : "",
      paidCredits: automaticPlanResolution?.order?.sessions || 0,
      paidPayMethod: automaticPlanResolution?.order?.payMethod || "",
      paidPricingPlanId:
        automaticPlanResolution?.order?.pricingPlanId || "",
      candidatePlanIds:
        automaticPlanResolution?.candidatePlanIds || [],
    },
    existingSubscription: summarizeExistingSubscription(existingSubscription),
    autoRenew: autoRenew !== false,
    commercialRule: {
      createsCustomPlan: false,
      basePlanChangesWithCalendar: false,
      extraSessionsArePeriodOnly: true,
    },
  };
}

export function buildServiceSubscriptionCreatePayload(
  candidate,
  {
    actorId = null,
    batchId,
    notes = "",
    bootstrapSource = "admin_initialization",
    now = new Date(),
  } = {}
) {
  if (!candidate?.canCreate || !candidate?.publishedPlan) {
    throw new Error("CANDIDATE_NOT_CREATABLE");
  }

  const cleanBatchId = cleanString(batchId);
  if (!cleanBatchId) throw new Error("BATCH_ID_REQUIRED");

  const plan = candidate.publishedPlan;
  const latestOrder = candidate.latestPaidOrder;

  return {
    user: candidate.user.id,
    serviceKey: candidate.service.key,
    serviceName: candidate.service.name,
    pricingPlan: plan.pricingPlanId,
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
      source: bootstrapSource,
      version: "subscriptions-v1-paid-history-auto",
      batchId: cleanBatchId,
      initializedAt: now,
      initializedBy: actorId,
      monthKey: candidate.period.monthKey,
      fixedScheduleIdsAtBootstrap: candidate.fixedScheduleIds,
      publishedPricingPlanId: plan.pricingPlanId,
      planResolutionMethod: candidate.planResolution?.method || "",
      paidPricingPlanId: candidate.planResolution?.paidPricingPlanId || null,
      paidCredits: candidate.planResolution?.paidCredits || 0,
      paidPayMethod: candidate.planResolution?.paidPayMethod || "",
      basePlanSessions: plan.monthlySessions,
      projectedFixedOccurrences:
        candidate.coverage.fixedOccurrencesCount || 0,
      extraSessionsRequired:
        candidate.coverage.extraSessionsRequired || 0,
      legacyAvailableSessions:
        candidate.legacySnapshot.availableSessionsNow || 0,
      legacyFixedScheduleDebt:
        candidate.legacySnapshot.legacyFixedScheduleDebt || 0,
      latestPaidOrder: latestOrder
        ? {
            orderId: latestOrder.orderId || null,
            paidAt: latestOrder.paidAt
              ? new Date(latestOrder.paidAt)
              : null,
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
  if (
    !["admin_initialization", "legacy_migration"].includes(
      subscription?.bootstrap?.source
    )
  ) {
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
