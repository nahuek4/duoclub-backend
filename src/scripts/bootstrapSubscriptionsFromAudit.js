// Migra en lote las suscripciones resueltas automáticamente por historial pago.
// Por defecto es DRY RUN. No crea ciclos, créditos, deuda ni turnos.
//
// Dry run:
// node scripts/bootstrapSubscriptionsFromAudit.js \
//   --audit=subscription-audit-auto-2026-09.json \
//   --out=subscription-bootstrap-dryrun-2026-09.json
//
// Aplicar:
// agregar --apply --confirm=CREATE_AUTOMATIC_SUBSCRIPTIONS

import fs from "node:fs";
import crypto from "node:crypto";
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
import {
  buildInitialSubscriptionCandidate,
  buildServiceSubscriptionCreatePayload,
  summarizePaidOrderForService,
} from "../src/services/subscriptions/subscriptionBootstrap.js";
import { projectActiveFixedSchedulesForMonth } from "../src/services/subscriptions/subscriptionScheduleProjection.js";

dotenv.config();

const APPLY_CONFIRMATION = "CREATE_AUTOMATIC_SUBSCRIPTIONS";

function parseArgs(argv = []) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, ...rest] = raw.slice(2).split("=");
    out[key] = rest.length ? rest.join("=") : true;
  }
  return out;
}

function clean(value) {
  return String(value || "").trim();
}

function bool(value) {
  if (value === true) return true;
  return ["1", "true", "yes", "si", "sí"].includes(clean(value).toLowerCase());
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

function paidOrderQuery(userId, serviceKey) {
  return {
    user: userId,
    status: { $in: ["paid", "approved"] },
    $or: [
      {
        items: {
          $elemMatch: {
            kind: { $in: ["CREDITS", "MANUAL_SERVICE"] },
            serviceKey,
          },
        },
      },
      { serviceKey },
    ],
  };
}

async function findLatestValidPaidOrder(userId, serviceKey) {
  const orders = await Order.find(paidOrderQuery(userId, serviceKey))
    .sort({ paidAt: -1, createdAt: -1 })
    .limit(100)
    .lean();

  return (
    orders.find((order) => summarizePaidOrderForService(order, serviceKey)) || null
  );
}

const args = parseArgs(process.argv.slice(2));
const auditFile = clean(args.audit);
const outFile = clean(args.out);
const apply = bool(args.apply);
const confirmation = clean(args.confirm);
const limit = Math.max(1, Number(args.limit || 5000));

if (!auditFile || !fs.existsSync(auditFile)) {
  console.error("Usá --audit=archivo.json con una auditoría existente.");
  process.exit(1);
}
if (apply && confirmation !== APPLY_CONFIRMATION) {
  console.error(`Para aplicar usá --confirm=${APPLY_CONFIRMATION}`);
  process.exit(1);
}

const audit = JSON.parse(fs.readFileSync(auditFile, "utf8"));
const monthKey = clean(audit?.monthKey);
if (!isValidMonthKey(monthKey)) {
  console.error("La auditoría no contiene un monthKey válido.");
  process.exit(1);
}
if (audit?.planMode !== "latest_paid_credits") {
  console.error("La auditoría no fue generada con planMode=latest_paid_credits.");
  process.exit(1);
}

const sourceRows = (Array.isArray(audit?.candidates) ? audit.candidates : [])
  .filter((row) => row?.automaticMigrationReady === true)
  .slice(0, limit);

const mongoUri =
  process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
if (!mongoUri) {
  console.error("No se encontró MONGO_URI/MONGODB_URI/MONGO_URL.");
  process.exit(1);
}

await mongoose.connect(mongoUri);

const batchId = clean(args.batch) || crypto.randomUUID();
const startedAt = new Date();
const results = [];

try {
  const range = monthRangeFromKey(monthKey);
  const [blocks, allPlans] = await Promise.all([
    ScheduleBlock.find(blockQuery(range.startYmd, range.endYmd)).lean(),
    PricingPlan.find({ active: true, isCustom: { $ne: true } }).lean(),
  ]);

  for (const auditRow of sourceRows) {
    const userId = clean(auditRow?.user?.id);
    const serviceKey = normalizeServiceKey(auditRow?.service?.key);
    const baseResult = {
      userId,
      usuario: clean(auditRow?.user?.fullName || auditRow?.user?.email),
      serviceKey,
      status: "pending",
    };

    try {
      if (!mongoose.Types.ObjectId.isValid(userId) || !serviceKey) {
        results.push({ ...baseResult, status: "skipped", reason: "INVALID_AUDIT_ROW" });
        continue;
      }

      const [user, schedules, existingSubscription, latestPaidOrder] =
        await Promise.all([
          User.findById(userId)
            .select("name lastName fullName email role creditLots fixedScheduleDebt")
            .lean(),
          FixedSchedule.find({
            user: userId,
            active: true,
            serviceKey,
            startDate: { $lte: range.endYmd },
          }).lean(),
          ServiceSubscription.findOne({ user: userId, serviceKey }).lean(),
          findLatestValidPaidOrder(userId, serviceKey),
        ]);

      if (!user) {
        results.push({ ...baseResult, status: "skipped", reason: "USER_NOT_FOUND" });
        continue;
      }
      if (existingSubscription) {
        results.push({
          ...baseResult,
          status: "skipped",
          reason: "SUBSCRIPTION_ALREADY_EXISTS",
          subscriptionId: String(existingSubscription._id),
        });
        continue;
      }

      const servicePlans = allPlans.filter(
        (plan) => normalizeServiceKey(plan?.serviceKey) === serviceKey
      );
      const projection = projectActiveFixedSchedulesForMonth({
        schedules,
        monthKey,
        serviceKey,
      });

      const candidate = buildInitialSubscriptionCandidate({
        user,
        serviceKey,
        monthKey,
        schedules: projection.projectedSchedules,
        blocks,
        pricingPlans: servicePlans,
        selectedPricingPlanId: "",
        autoRenew: true,
        existingSubscription: null,
        latestPaidOrder,
        includeCustomPlans: false,
      });

      if (!candidate.canCreate || !candidate.planResolution?.ok) {
        results.push({
          ...baseResult,
          status: "skipped",
          reason: "AUTO_RESOLUTION_FAILED",
          errors: candidate.errors,
          planResolution: candidate.planResolution,
        });
        continue;
      }

      const auditedPlanId = clean(auditRow?.resolvedPublishedPlan?.id);
      const currentPlanId = clean(candidate?.publishedPlan?.pricingPlanId);
      const resolutionChanged = Boolean(
        auditedPlanId && currentPlanId && auditedPlanId !== currentPlanId
      );

      const result = {
        ...baseResult,
        status: apply ? "ready_to_create" : "dry_run_ready",
        pricingPlanId: currentPlanId,
        planResolutionMethod: candidate.planResolution.method,
        paidCredits: candidate.planResolution.paidCredits,
        payMethod: candidate.publishedPlan.payMethod,
        basePlanSessions: candidate.publishedPlan.monthlySessions,
        projectedFixedOccurrences: candidate.coverage.fixedOccurrencesCount,
        extraSessionsRequired: candidate.coverage.extraSessionsRequired,
        resolutionChangedSinceAudit: resolutionChanged,
      };

      if (!apply) {
        results.push(result);
        continue;
      }

      const payload = buildServiceSubscriptionCreatePayload(candidate, {
        actorId: null,
        batchId,
        notes: `Migración automática desde ${auditFile}`,
        bootstrapSource: "legacy_migration",
      });

      const created = await ServiceSubscription.create(payload);
      results.push({
        ...result,
        status: "created",
        subscriptionId: String(created._id),
      });
    } catch (error) {
      const duplicate = Number(error?.code) === 11000;
      results.push({
        ...baseResult,
        status: duplicate ? "skipped" : "error",
        reason: duplicate ? "SUBSCRIPTION_ALREADY_EXISTS" : clean(error?.message),
      });
    }
  }
} finally {
  await mongoose.disconnect();
}

const report = {
  mode: apply ? "apply" : "dry_run",
  auditFile,
  monthKey,
  batchId,
  generatedAt: new Date().toISOString(),
  sourceCandidates: sourceRows.length,
  ready: results.filter((row) => row.status === "dry_run_ready").length,
  created: results.filter((row) => row.status === "created").length,
  skipped: results.filter((row) => row.status === "skipped").length,
  errors: results.filter((row) => row.status === "error").length,
  durationMs: Date.now() - startedAt.getTime(),
  results,
};

const json = JSON.stringify(report, null, 2);
if (outFile) {
  fs.writeFileSync(outFile, json, "utf8");
  console.log(`✅ Reporte guardado en ${outFile}`);
}
console.log({
  mode: report.mode,
  monthKey: report.monthKey,
  sourceCandidates: report.sourceCandidates,
  ready: report.ready,
  created: report.created,
  skipped: report.skipped,
  errors: report.errors,
  batchId: report.batchId,
});

if (report.errors > 0) process.exitCode = 2;
