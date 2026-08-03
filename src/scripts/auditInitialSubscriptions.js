// backend/scripts/auditInitialSubscriptions.js
// SOLO LECTURA. Audita patrones fijos activos y los proyecta al mes objetivo.
// Los planes base son exclusivamente PricingPlan activos publicados.
// No crea planes a medida ni modifica MongoDB.
//
// Uso:
// node scripts/auditInitialSubscriptions.js --month=2026-09 \
//   [--service=EP] [--limit=2000] [--out=archivo.json]

import fs from "node:fs";
import dotenv from "dotenv";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import FixedSchedule from "../src/models/FixedSchedule.js";
import ScheduleBlock from "../src/models/ScheduleBlock.js";
import PricingPlan from "../src/models/PricingPlan.js";
import Order from "../src/models/Order.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import {
  isValidMonthKey,
  monthRangeFromKey,
  normalizeServiceKey,
} from "../src/services/subscriptions/fixedScheduleCoverage.js";
import { buildSubscriptionCoveragePreview } from "../src/services/subscriptions/subscriptionCoveragePreview.js";
import {
  projectActiveFixedSchedulesForMonth,
  scheduleLegacyOverlapsMonth,
} from "../src/services/subscriptions/subscriptionScheduleProjection.js";
import { summarizePaidOrderForService } from "../src/services/subscriptions/subscriptionBootstrap.js";

dotenv.config();

function argsMap(argv = []) {
  const map = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, ...rest] = raw.slice(2).split("=");
    map[key] = rest.length ? rest.join("=") : true;
  }
  return map;
}

function clean(value) {
  return String(value || "").trim();
}

function idOf(value) {
  return clean(value?._id || value?.id || value);
}

function blockQuery(startYmd, endYmd) {
  return {
    active: true,
    dateFrom: { $lte: endYmd },
    $or: [
      { indefinite: true },
      { dateTo: { $gte: startYmd } },
      { dateTo: "" },
      { dateTo: { $exists: false } },
    ],
  };
}

function summarizeExcludedSchedule(schedule, reason) {
  return {
    fixedScheduleId: idOf(schedule),
    userId: idOf(schedule?.user),
    userEmail: clean(schedule?.user?.email),
    userRole: clean(schedule?.user?.role),
    serviceKey: normalizeServiceKey(schedule?.serviceKey || schedule?.service),
    startDate: clean(schedule?.startDate).slice(0, 10),
    endDate: clean(schedule?.endDate).slice(0, 10),
    reason,
  };
}

function serviceKeysFromOrder(order = {}) {
  const keys = [];
  for (const item of Array.isArray(order?.items) ? order.items : []) {
    if (!["CREDITS", "MANUAL_SERVICE"].includes(clean(item?.kind).toUpperCase())) {
      continue;
    }
    const key = normalizeServiceKey(item?.serviceKey);
    if (key) keys.push(key);
  }
  const legacyKey = normalizeServiceKey(order?.serviceKey);
  if (legacyKey) keys.push(legacyKey);
  return [...new Set(keys)];
}

function latestOrderMap(orders = []) {
  const map = new Map();
  for (const order of orders) {
    const userId = idOf(order?.user);
    if (!userId) continue;
    for (const serviceKey of serviceKeysFromOrder(order)) {
      const key = `${userId}__${serviceKey}`;
      if (!map.has(key)) map.set(key, order);
    }
  }
  return map;
}

const args = argsMap(process.argv.slice(2));
const monthKey = clean(args.month);
const serviceFilter = normalizeServiceKey(args.service);
const limit = Math.min(5000, Math.max(1, Number(args.limit || 2000)));
const outFile = clean(args.out);

if (!isValidMonthKey(monthKey)) {
  console.error("Usá --month=YYYY-MM");
  process.exit(1);
}

const mongoUri =
  process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
if (!mongoUri) {
  console.error("No se encontró MONGO_URI/MONGODB_URI/MONGO_URL.");
  process.exit(1);
}

await mongoose.connect(mongoUri);

try {
  const range = monthRangeFromKey(monthKey);
  const scheduleQuery = {
    active: true,
    startDate: { $lte: range.endYmd },
    ...(serviceFilter ? { serviceKey: serviceFilter } : {}),
  };

  const [schedules, blocks, plans, existing] = await Promise.all([
    FixedSchedule.find(scheduleQuery)
      .populate(
        "user",
        "name lastName fullName email role creditLots fixedScheduleDebt"
      )
      .sort({ user: 1, serviceKey: 1, createdAt: 1 })
      .limit(limit)
      .lean(),
    ScheduleBlock.find(blockQuery(range.startYmd, range.endYmd)).lean(),
    PricingPlan.find({
      active: true,
      isCustom: { $ne: true },
      ...(serviceFilter ? { serviceKey: serviceFilter } : {}),
    })
      .sort({ serviceKey: 1, credits: 1, price: 1, payMethod: 1 })
      .lean(),
    ServiceSubscription.find(
      serviceFilter ? { serviceKey: serviceFilter } : {}
    ).lean(),
  ]);

  const existingMap = new Map(
    existing.map((subscription) => [
      `${String(subscription.user)}__${normalizeServiceKey(
        subscription.serviceKey
      )}`,
      subscription,
    ])
  );

  const groups = new Map();
  const excluded = [];

  for (const schedule of schedules) {
    const user = schedule?.user;
    const serviceKey = normalizeServiceKey(
      schedule?.serviceKey || schedule?.service
    );

    if (!user?._id) {
      excluded.push(summarizeExcludedSchedule(schedule, "USER_NOT_FOUND"));
      continue;
    }
    if (clean(user?.role).toLowerCase() !== "client") {
      excluded.push(summarizeExcludedSchedule(schedule, "USER_NOT_CLIENT"));
      continue;
    }
    if (!serviceKey) {
      excluded.push(summarizeExcludedSchedule(schedule, "INVALID_SERVICE"));
      continue;
    }

    const key = `${String(user._id)}__${serviceKey}`;
    if (!groups.has(key)) {
      groups.set(key, { user, serviceKey, schedules: [] });
    }
    groups.get(key).schedules.push(schedule);
  }

  const groupUserIds = [...new Set(
    [...groups.values()].map((group) => String(group.user._id))
  )];

  const paidOrders = groupUserIds.length
    ? await Order.find({
        user: { $in: groupUserIds },
        status: { $in: ["paid", "approved"] },
      })
        .sort({ paidAt: -1, createdAt: -1 })
        .lean()
    : [];
  const paidOrdersByUserService = latestOrderMap(paidOrders);

  const rows = [];

  for (const group of groups.values()) {
    const servicePlans = plans.filter(
      (plan) => normalizeServiceKey(plan?.serviceKey) === group.serviceKey
    );

    const legacySchedules = group.schedules.filter((schedule) =>
      scheduleLegacyOverlapsMonth(schedule, monthKey)
    );

    const projection = projectActiveFixedSchedulesForMonth({
      schedules: group.schedules,
      monthKey,
      serviceKey: group.serviceKey,
    });

    if (!projection.projectedSchedules.length) {
      for (const item of projection.excludedSchedules) {
        excluded.push({
          ...item,
          userId: idOf(group.user),
          userEmail: clean(group.user?.email),
          userRole: clean(group.user?.role),
        });
      }
      continue;
    }

    const legacyPreview = buildSubscriptionCoveragePreview({
      user: group.user,
      serviceKey: group.serviceKey,
      monthKey,
      schedules: legacySchedules,
      blocks,
      pricingPlans: servicePlans,
      includeCustomPlans: false,
    });

    const projectedPreview = buildSubscriptionCoveragePreview({
      user: group.user,
      serviceKey: group.serviceKey,
      monthKey,
      schedules: projection.projectedSchedules,
      blocks,
      pricingPlans: servicePlans,
      includeCustomPlans: false,
    });

    const publishedPlans = projectedPreview.publishedPlanComparisons.map(
      ({ publishedPlan, coverage }) => ({
        ...publishedPlan,
        projectedFixedOccurrences: coverage.fixedOccurrencesCount,
        extraSessionsRequired: coverage.extraSessionsRequired,
        freeSessions: coverage.freeSessions,
      })
    );

    const groupKey = `${group.user._id}__${group.serviceKey}`;
    const existingSubscription = existingMap.get(groupKey);
    const latestPaidOrder = paidOrdersByUserService.get(groupKey) || null;
    const paidOrderEvidence = summarizePaidOrderForService(
      latestPaidOrder,
      group.serviceKey
    );
    const suggestedPublishedPlan = paidOrderEvidence?.pricingPlanId
      ? publishedPlans.find(
          (plan) => plan.id === paidOrderEvidence.pricingPlanId
        ) || null
      : null;

    rows.push({
      user: projectedPreview.user,
      service: projectedPreview.service,
      monthKey,
      sourceFixedSchedulesCount: group.schedules.length,
      legacyOverlappingSchedulesCount: legacySchedules.length,
      projectedFixedSchedulesCount: projection.projectedSchedules.length,
      legacyFixedOccurrencesCount:
        legacyPreview.coverage.fixedOccurrencesCount,
      projectedFixedOccurrencesCount:
        projectedPreview.coverage.fixedOccurrencesCount,
      blockedOccurrencesCount:
        projectedPreview.coverage.blockedOccurrencesCount,
      legacyExpiredBeforeMonthCount:
        projection.diagnostics.legacyExpiredBeforeMonth,
      legacyEndsDuringMonthCount:
        projection.diagnostics.legacyEndsDuringMonth,
      legacyAvailableSessions:
        projectedPreview.legacySnapshot.availableSessionsNow,
      legacyFixedScheduleDebt:
        projectedPreview.legacySnapshot.legacyFixedScheduleDebt,
      existingSubscription: existingSubscription
        ? {
            id: String(existingSubscription._id),
            status: existingSubscription.status,
            pricingPlanId: idOf(existingSubscription.pricingPlan),
            monthlySessions: existingSubscription.monthlySessions,
          }
        : null,
      latestPaidOrderEvidence: paidOrderEvidence,
      suggestedPublishedPlan,
      publishedPlans,
      projectedFixedSchedules: projectedPreview.fixedSchedules,
      action: existingSubscription
        ? "skip_existing"
        : suggestedPublishedPlan
          ? "confirm_suggested_published_plan"
          : "select_published_plan",
      requiresManualDecision: !existingSubscription,
      notes: [
        "La proyección usa el patrón active:true durante todo el mes.",
        "El endDate legacy se conserva solo como dato de auditoría.",
        "El plan base debe ser uno de los PricingPlan activos publicados.",
        "Si el plan tiene menos sesiones que el mes, la diferencia se compra como sesiones adicionales del período.",
        "La sugerencia por última compra es solo evidencia y debe confirmarse explícitamente.",
      ],
    });
  }

  rows.sort((a, b) =>
    `${a.user.fullName} ${a.service.key}`.localeCompare(
      `${b.user.fullName} ${b.service.key}`,
      "es"
    )
  );

  const report = {
    readOnly: true,
    projectionMode: "active_pattern_full_month",
    planMode: "published_pricing_plan_only",
    generatedAt: new Date().toISOString(),
    monthKey,
    serviceFilter: serviceFilter || "ALL",
    schedulesRead: schedules.length,
    includedSchedules: rows.reduce(
      (sum, row) => sum + row.sourceFixedSchedulesCount,
      0
    ),
    excludedSchedulesCount: excluded.length,
    excludedSchedules: excluded,
    candidatesCount: rows.length,
    requiresManualDecisionCount: rows.filter(
      (row) => row.requiresManualDecision
    ).length,
    candidatesWithPublishedPlanSuggestion: rows.filter(
      (row) => row.suggestedPublishedPlan
    ).length,
    candidatesWithoutPublishedPlans: rows.filter(
      (row) => !row.publishedPlans.length
    ).length,
    candidates: rows,
  };

  const json = JSON.stringify(report, null, 2);
  if (outFile) {
    fs.writeFileSync(outFile, json, "utf8");
    console.log(`✅ Auditoría de planes publicados guardada en ${outFile}`);
  } else {
    console.log(json);
  }
} finally {
  await mongoose.disconnect();
}
