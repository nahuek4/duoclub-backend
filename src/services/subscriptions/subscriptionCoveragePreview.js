// backend/src/services/subscriptions/subscriptionCoveragePreview.js
// Constructor puro de previsualizaciones. No consulta ni escribe MongoDB.
// Regla comercial: el plan base siempre debe existir en PricingPlan.
// Si el calendario mensual supera sus sesiones, la diferencia queda como
// sesiones adicionales del período; nunca se crea un plan a medida.

import {
  calculateServiceMonthCoverage,
  monthRangeFromKey,
  normalizeServiceKey,
} from "./fixedScheduleCoverage.js";

const SERVICE_KEY_TO_NAME = {
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
  NUT: "Nutrición",
};

function objectIdString(value) {
  return String(value?._id || value?.id || value || "").trim();
}

function cleanString(value) {
  return String(value || "").trim();
}

function cleanNonNegativeInteger(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.trunc(n));
}

function cleanMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function dateIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function fullNameOf(user = {}) {
  return (
    `${cleanString(user?.name)} ${cleanString(user?.lastName)}`.trim() ||
    cleanString(user?.fullName) ||
    cleanString(user?.email) ||
    "Usuario"
  );
}

function summarizeUser(user = {}) {
  return {
    id: objectIdString(user),
    name: cleanString(user?.name),
    lastName: cleanString(user?.lastName),
    fullName: fullNameOf(user),
    email: cleanString(user?.email),
  };
}

function summarizeSchedule(schedule = {}) {
  const projection = schedule?._subscriptionProjection || null;

  return {
    id: objectIdString(schedule),
    serviceKey: normalizeServiceKey(schedule?.serviceKey || schedule?.service),
    serviceName: cleanString(schedule?.service),
    active: schedule?.active !== false,
    startDate: cleanString(schedule?.startDate).slice(0, 10),
    endDate: cleanString(schedule?.endDate).slice(0, 10),
    legacyStartDate: projection
      ? cleanString(projection?.legacyStartDate).slice(0, 10)
      : cleanString(schedule?.startDate).slice(0, 10),
    legacyEndDate: projection
      ? cleanString(projection?.legacyEndDate).slice(0, 10)
      : cleanString(schedule?.endDate).slice(0, 10),
    projection: projection
      ? {
          mode: cleanString(projection?.mode),
          monthKey: cleanString(projection?.monthKey),
          legacyExpiredBeforeMonth:
            projection?.legacyExpiredBeforeMonth === true,
          legacyEndsDuringMonth: projection?.legacyEndsDuringMonth === true,
        }
      : null,
    items: (Array.isArray(schedule?.items) ? schedule.items : []).map((item) => ({
      weekday: Number(item?.weekday || 0),
      time: cleanString(item?.time).slice(0, 5),
    })),
  };
}

function summarizeBlock(block = {}) {
  return {
    id: objectIdString(block),
    title: cleanString(block?.title),
    reason: cleanString(block?.reason),
    serviceKeys: (Array.isArray(block?.serviceKeys) ? block.serviceKeys : [])
      .map(normalizeServiceKey)
      .filter(Boolean),
    allServices: block?.allServices === true,
    dateFrom: cleanString(block?.dateFrom).slice(0, 10),
    dateTo: cleanString(block?.dateTo).slice(0, 10),
    indefinite: block?.indefinite === true,
    allDay: block?.allDay !== false,
    timeFrom: cleanString(block?.timeFrom).slice(0, 5),
    timeTo: cleanString(block?.timeTo).slice(0, 5),
    weekdays: (Array.isArray(block?.weekdays) ? block.weekdays : [])
      .map(Number)
      .filter((n) => Number.isInteger(n)),
  };
}

export function summarizePublishedPricingPlan(plan = {}) {
  return {
    id: objectIdString(plan),
    serviceKey: normalizeServiceKey(plan?.serviceKey),
    payMethod: cleanString(plan?.payMethod).toUpperCase(),
    monthlySessions: cleanNonNegativeInteger(plan?.credits),
    price: cleanMoney(plan?.price),
    label:
      cleanString(plan?.customTitle) ||
      cleanString(plan?.label) ||
      `${cleanNonNegativeInteger(plan?.credits)} sesiones`,
    isCustom: plan?.isCustom === true,
    active: plan?.active !== false,
  };
}

function buildLegacySnapshot(user = {}, serviceKey, now = new Date()) {
  const key = normalizeServiceKey(serviceKey);
  const lots = (Array.isArray(user?.creditLots) ? user.creditLots : [])
    .filter((lot) => normalizeServiceKey(lot?.serviceKey || lot?.serviceName) === key)
    .map((lot) => ({
      id: objectIdString(lot),
      amount: cleanNonNegativeInteger(lot?.amount),
      remaining: cleanNonNegativeInteger(lot?.remaining),
      source: cleanString(lot?.source),
      expiresAt: dateIsoOrNull(lot?.expiresAt),
      createdAt: dateIsoOrNull(lot?.createdAt),
    }))
    .sort((a, b) =>
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
    );

  const activeLots = lots.filter((lot) => {
    if (!lot.expiresAt) return lot.remaining > 0;
    return lot.remaining > 0 && new Date(lot.expiresAt) > now;
  });

  return {
    informationalOnly: true,
    activeLotsCount: activeLots.length,
    availableSessionsNow: activeLots.reduce(
      (sum, lot) => sum + cleanNonNegativeInteger(lot.remaining),
      0
    ),
    lastPurchasedLot: lots[0] || null,
    legacyFixedScheduleDebt: Math.max(
      0,
      Number(user?.fixedScheduleDebt?.[key] || 0)
    ),
  };
}

function enrichCoverage(coverage = {}) {
  const basePlanSessions = cleanNonNegativeInteger(coverage?.baseSessions);
  const extraSessionsRequired = cleanNonNegativeInteger(
    coverage?.extraSessionsNeeded
  );
  const extraSessionsSelected = cleanNonNegativeInteger(
    coverage?.extraSessionsSelected
  );
  const extraSessionsPending = cleanNonNegativeInteger(
    coverage?.additionalSessionsStillNeeded
  );

  return {
    ...coverage,
    basePlanSessions,
    extraSessionsRequired,
    extraSessionsSelected,
    extraSessionsPending,
  };
}

function comparisonForPlan({ plan, schedules, blocks, monthKey, serviceKey }) {
  const publishedPlan = summarizePublishedPricingPlan(plan);
  const rawCoverage = calculateServiceMonthCoverage({
    schedules,
    blocks,
    monthKey,
    serviceKey,
    monthlySessions: publishedPlan.monthlySessions,
    extraSessionsSelected: 0,
  });

  return {
    publishedPlan,
    // Compatibilidad temporal con la respuesta de Etapa 2.
    plan: publishedPlan,
    coverage: enrichCoverage(rawCoverage),
  };
}

function resolveSelectedPublishedPlan({ pricingPlans, selectedPricingPlanId }) {
  const planId = cleanString(selectedPricingPlanId);
  const plans = Array.isArray(pricingPlans) ? pricingPlans : [];

  if (!planId) {
    return {
      source: "unconfigured",
      plan: {
        id: "",
        serviceKey: "",
        payMethod: "",
        monthlySessions: 0,
        price: 0,
        label: "Sin plan publicado seleccionado",
        isCustom: false,
        active: false,
      },
    };
  }

  const found = plans.find((plan) => objectIdString(plan) === planId);
  if (!found) {
    return {
      source: "invalid_published_plan",
      plan: {
        id: planId,
        serviceKey: "",
        payMethod: "",
        monthlySessions: 0,
        price: 0,
        label: "Plan publicado no disponible",
        isCustom: false,
        active: false,
      },
    };
  }

  return {
    source: "published_pricing_plan",
    plan: summarizePublishedPricingPlan(found),
  };
}

export function buildSubscriptionCoveragePreview({
  user,
  serviceKey,
  monthKey,
  schedules = [],
  blocks = [],
  pricingPlans = [],
  selectedPricingPlanId = "",
  extraSessionsSelected = 0,
  includeCustomPlans = false,
  now = new Date(),
} = {}) {
  const normalizedServiceKey = normalizeServiceKey(serviceKey);
  if (!normalizedServiceKey) {
    throw new Error(`INVALID_SERVICE_KEY:${String(serviceKey || "")}`);
  }

  const period = monthRangeFromKey(monthKey);
  const filteredSchedules = (Array.isArray(schedules) ? schedules : []).filter(
    (schedule) =>
      normalizeServiceKey(schedule?.serviceKey || schedule?.service) ===
      normalizedServiceKey
  );

  const filteredPlans = (Array.isArray(pricingPlans) ? pricingPlans : []).filter(
    (plan) => {
      if (plan?.active === false) return false;
      if (!includeCustomPlans && plan?.isCustom === true) return false;
      return normalizeServiceKey(plan?.serviceKey) === normalizedServiceKey;
    }
  );

  const selected = resolveSelectedPublishedPlan({
    pricingPlans: filteredPlans,
    selectedPricingPlanId,
  });
  selected.plan.serviceKey = normalizedServiceKey;

  const rawCoverage = calculateServiceMonthCoverage({
    schedules: filteredSchedules,
    blocks,
    monthKey,
    serviceKey: normalizedServiceKey,
    monthlySessions: selected.plan.monthlySessions,
    extraSessionsSelected,
  });
  const coverage = enrichCoverage(rawCoverage);

  const publishedPlanComparisons = filteredPlans
    .map((plan) =>
      comparisonForPlan({
        plan,
        schedules: filteredSchedules,
        blocks,
        monthKey,
        serviceKey: normalizedServiceKey,
      })
    )
    .sort((a, b) => {
      if (a.publishedPlan.monthlySessions !== b.publishedPlan.monthlySessions) {
        return (
          a.publishedPlan.monthlySessions - b.publishedPlan.monthlySessions
        );
      }
      if (a.publishedPlan.price !== b.publishedPlan.price) {
        return a.publishedPlan.price - b.publishedPlan.price;
      }
      return a.publishedPlan.payMethod.localeCompare(
        b.publishedPlan.payMethod
      );
    });

  const warnings = [];
  if (selected.source === "unconfigured") {
    warnings.push(
      "Seleccioná uno de los planes publicados. No se crean planes adaptados a los turnos fijos."
    );
  }
  if (selected.source === "invalid_published_plan") {
    warnings.push(
      "El plan indicado no está entre los planes activos publicados para este servicio."
    );
  }
  if (coverage.extraSessionsPending > 0 && selected.plan.id) {
    warnings.push(
      `El plan base se mantiene en ${selected.plan.monthlySessions} sesiones. Para cubrir el mes hacen falta ${coverage.extraSessionsPending} sesión(es) adicional(es).`
    );
  }
  if (coverage.duplicateOccurrences.length) {
    warnings.push(
      "Se detectaron configuraciones fijas duplicadas para la misma fecha y horario; se contabilizó una sola ocurrencia."
    );
  }
  if (coverage.blockedOccurrencesCount) {
    warnings.push(
      "Las ocurrencias bloqueadas no se incluyen dentro de las sesiones necesarias del mes."
    );
  }

  const publishedPlan = {
    source: selected.source,
    ...selected.plan,
  };

  return {
    readOnly: true,
    generatedAt: now.toISOString(),
    user: summarizeUser(user),
    service: {
      key: normalizedServiceKey,
      name: SERVICE_KEY_TO_NAME[normalizedServiceKey] || normalizedServiceKey,
    },
    period: {
      monthKey,
      startDate: period.startYmd,
      endDate: period.endYmd,
    },
    publishedPlan,
    // Alias temporal para no romper consumidores de Etapa 2.
    selectedPlan: {
      ...publishedPlan,
      extraSessionsSelected: cleanNonNegativeInteger(extraSessionsSelected),
    },
    coverage,
    publishedPlanComparisons,
    // Alias temporal para no romper consumidores de Etapa 2.
    planComparisons: publishedPlanComparisons,
    fixedSchedules: filteredSchedules.map(summarizeSchedule),
    applicableBlocks: (Array.isArray(blocks) ? blocks : []).map(summarizeBlock),
    legacySnapshot: buildLegacySnapshot(user, normalizedServiceKey, now),
    warnings,
  };
}
