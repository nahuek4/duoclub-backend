// backend/src/services/subscriptions/subscriptionCoveragePreview.js
// Constructor puro de previsualizaciones. No consulta ni escribe MongoDB.

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

function summarizePricingPlan(plan = {}) {
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
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

  const activeLots = lots.filter((lot) => {
    if (!lot.expiresAt) return lot.remaining > 0;
    return lot.remaining > 0 && new Date(lot.expiresAt) > now;
  });

  const debt = Math.max(
    0,
    Number(user?.fixedScheduleDebt?.[key] || 0)
  );

  return {
    informationalOnly: true,
    activeLotsCount: activeLots.length,
    availableSessionsNow: activeLots.reduce(
      (sum, lot) => sum + cleanNonNegativeInteger(lot.remaining),
      0
    ),
    lastPurchasedLot: lots[0] || null,
    legacyFixedScheduleDebt: debt,
  };
}

function comparisonForPlan({ plan, schedules, blocks, monthKey, serviceKey }) {
  const normalizedPlan = summarizePricingPlan(plan);
  const coverage = calculateServiceMonthCoverage({
    schedules,
    blocks,
    monthKey,
    serviceKey,
    monthlySessions: normalizedPlan.monthlySessions,
    extraSessionsSelected: 0,
  });

  return {
    plan: normalizedPlan,
    coverage: {
      status: coverage.status,
      fixedOccurrencesCount: coverage.fixedOccurrencesCount,
      monthlySessions: coverage.baseSessions,
      extraSessionsNeeded: coverage.extraSessionsNeeded,
      additionalSessionsStillNeeded: coverage.additionalSessionsStillNeeded,
      freeSessions: coverage.freeSessions,
      coveredFixedOccurrences: coverage.coveredFixedOccurrences,
      uncoveredFixedOccurrences: coverage.uncoveredFixedOccurrences,
    },
  };
}

function resolveSelectedPlan({
  pricingPlans,
  selectedPricingPlanId,
  manualMonthlySessions,
  manualPayMethod,
}) {
  const planId = cleanString(selectedPricingPlanId);
  const plans = Array.isArray(pricingPlans) ? pricingPlans : [];

  if (planId) {
    const found = plans.find((plan) => objectIdString(plan) === planId);
    if (found) {
      return {
        source: "pricing_plan",
        plan: summarizePricingPlan(found),
      };
    }
  }

  if (manualMonthlySessions !== null && manualMonthlySessions !== undefined) {
    const sessions = cleanNonNegativeInteger(manualMonthlySessions);
    return {
      source: "manual_preview",
      plan: {
        id: "",
        serviceKey: "",
        payMethod: cleanString(manualPayMethod).toUpperCase(),
        monthlySessions: sessions,
        price: 0,
        label: `Previsualización manual · ${sessions} sesiones`,
        isCustom: false,
        active: true,
      },
    };
  }

  return {
    source: "unconfigured",
    plan: {
      id: "",
      serviceKey: "",
      payMethod: "",
      monthlySessions: 0,
      price: 0,
      label: "Sin plan seleccionado",
      isCustom: false,
      active: false,
    },
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
  manualMonthlySessions = null,
  extraSessionsSelected = 0,
  manualPayMethod = "",
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

  const selected = resolveSelectedPlan({
    pricingPlans: filteredPlans,
    selectedPricingPlanId,
    manualMonthlySessions,
    manualPayMethod,
  });
  selected.plan.serviceKey = normalizedServiceKey;

  const coverage = calculateServiceMonthCoverage({
    schedules: filteredSchedules,
    blocks,
    monthKey,
    serviceKey: normalizedServiceKey,
    monthlySessions: selected.plan.monthlySessions,
    extraSessionsSelected,
  });

  const planComparisons = filteredPlans
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
      if (a.plan.monthlySessions !== b.plan.monthlySessions) {
        return a.plan.monthlySessions - b.plan.monthlySessions;
      }
      if (a.plan.price !== b.plan.price) return a.plan.price - b.plan.price;
      return a.plan.payMethod.localeCompare(b.plan.payMethod);
    });

  const warnings = [];
  if (selected.source === "unconfigured") {
    warnings.push(
      "No se seleccionó un plan. La cobertura se calcula con 0 sesiones para mostrar todas las ocurrencias pendientes."
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
    selectedPlan: {
      source: selected.source,
      ...selected.plan,
      extraSessionsSelected: cleanNonNegativeInteger(extraSessionsSelected),
    },
    coverage,
    planComparisons,
    fixedSchedules: filteredSchedules.map(summarizeSchedule),
    applicableBlocks: (Array.isArray(blocks) ? blocks : []).map(summarizeBlock),
    legacySnapshot: buildLegacySnapshot(user, normalizedServiceKey, now),
    warnings,
  };
}
