// backend/scripts/auditInitialSubscriptions.js
// SOLO LECTURA. Audita candidatos con turnos fijos para un mes.
// Uso: node scripts/auditInitialSubscriptions.js --month=2026-09 [--service=EP] [--limit=200] [--out=archivo.json]

import fs from "node:fs";
import dotenv from "dotenv";
import mongoose from "mongoose";

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

const args = argsMap(process.argv.slice(2));
const monthKey = clean(args.month);
const serviceFilter = normalizeServiceKey(args.service);
const limit = Math.min(2000, Math.max(1, Number(args.limit || 500)));
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
    endDate: { $gte: range.startYmd },
  };
  if (serviceFilter) scheduleQuery.serviceKey = serviceFilter;

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
    existing.map((sub) => [
      `${String(sub.user)}__${normalizeServiceKey(sub.serviceKey)}`,
      sub,
    ])
  );
  const groups = new Map();

  for (const schedule of schedules) {
    const user = schedule?.user;
    const serviceKey = normalizeServiceKey(schedule?.serviceKey || schedule?.service);
    if (!user?._id || !serviceKey || user?.role !== "client") continue;
    const key = `${String(user._id)}__${serviceKey}`;
    if (!groups.has(key)) groups.set(key, { user, serviceKey, schedules: [] });
    groups.get(key).schedules.push(schedule);
  }

  const rows = [];
  for (const group of groups.values()) {
    const servicePlans = plans.filter(
      (plan) => normalizeServiceKey(plan?.serviceKey) === group.serviceKey
    );
    const preview = buildSubscriptionCoveragePreview({
      user: group.user,
      serviceKey: group.serviceKey,
      monthKey,
      schedules: group.schedules,
      blocks,
      pricingPlans: servicePlans,
      includeCustomPlans: false,
    });

    const viablePlans = preview.planComparisons
      .filter((item) => item.coverage.additionalSessionsStillNeeded === 0)
      .sort((a, b) => {
        if (a.plan.monthlySessions !== b.plan.monthlySessions) {
          return a.plan.monthlySessions - b.plan.monthlySessions;
        }
        return a.plan.price - b.plan.price;
      });

    const existingSubscription = existingMap.get(
      `${group.user._id}__${group.serviceKey}`
    );

    rows.push({
      user: preview.user,
      service: preview.service,
      monthKey,
      fixedSchedulesCount: preview.fixedSchedules.length,
      fixedOccurrencesCount: preview.coverage.fixedOccurrencesCount,
      blockedOccurrencesCount: preview.coverage.blockedOccurrencesCount,
      legacyAvailableSessions: preview.legacySnapshot.availableSessionsNow,
      legacyFixedScheduleDebt: preview.legacySnapshot.legacyFixedScheduleDebt,
      existingSubscription: existingSubscription
        ? {
            id: String(existingSubscription._id),
            status: existingSubscription.status,
            monthlySessions: existingSubscription.monthlySessions,
          }
        : null,
      recommendedPlan: viablePlans[0]?.plan || null,
      planComparisons: preview.planComparisons,
      requiresManualDecision: !viablePlans.length || Boolean(existingSubscription),
    });
  }

  rows.sort((a, b) =>
    `${a.user.fullName} ${a.service.key}`.localeCompare(
      `${b.user.fullName} ${b.service.key}`
    )
  );

  const report = {
    readOnly: true,
    generatedAt: new Date().toISOString(),
    monthKey,
    serviceFilter: serviceFilter || "ALL",
    schedulesRead: schedules.length,
    candidatesCount: rows.length,
    candidates: rows,
  };

  const json = JSON.stringify(report, null, 2);
  if (outFile) {
    fs.writeFileSync(outFile, json, "utf8");
    console.log(`✅ Auditoría guardada en ${outFile}`);
  } else {
    console.log(json);
  }
} finally {
  await mongoose.disconnect();
}
