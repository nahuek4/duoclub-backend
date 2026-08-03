// backend/scripts/auditInitialSubscriptions.js
// SOLO LECTURA. Audita patrones fijos activos y los proyecta al mes objetivo.
// No modifica FixedSchedule, User, créditos, deuda ni suscripciones.
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
      .sort({ serviceKey: 1, credits: 1, price: 1 })
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

    const planComparisons = projectedPreview.planComparisons
      .slice()
      .sort((a, b) => {
        if (a.plan.monthlySessions !== b.plan.monthlySessions) {
          return a.plan.monthlySessions - b.plan.monthlySessions;
        }
        return a.plan.price - b.plan.price;
      });

    const smallestAvailablePlan = planComparisons[0]?.plan || null;
    const smallestCoveringPlan =
      planComparisons.find(
        (item) => item.coverage.additionalSessionsStillNeeded === 0
      )?.plan || null;

    const existingSubscription = existingMap.get(
      `${group.user._id}__${group.serviceKey}`
    );

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
            monthlySessions: existingSubscription.monthlySessions,
          }
        : null,
      smallestAvailablePlan,
      smallestCoveringPlan,
      planComparisons,
      projectedFixedSchedules: projectedPreview.fixedSchedules,
      action: existingSubscription ? "skip_existing" : "select_plan",
      requiresManualDecision: !existingSubscription,
      notes: [
        "La proyección usa el patrón active:true durante todo el mes.",
        "El endDate legacy se conserva solo como dato de auditoría.",
        "La selección del plan debe confirmarse explícitamente; no se autoasigna.",
      ],
    });
  }

  rows.sort((a, b) =>
    `${a.user.fullName} ${a.service.key}`.localeCompare(
      `${b.user.fullName} ${b.service.key}`
    )
  );

  const report = {
    readOnly: true,
    projectionMode: "active_pattern_full_month",
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
    candidates: rows,
  };

  const json = JSON.stringify(report, null, 2);
  if (outFile) {
    fs.writeFileSync(outFile, json, "utf8");
    console.log(`✅ Auditoría proyectada guardada en ${outFile}`);
  } else {
    console.log(json);
  }
} finally {
  await mongoose.disconnect();
}
