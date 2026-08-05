// backend/scripts/syncSubscriptionExtraNotices.js
// Dry run por defecto. Crea avisos internos solo para suscripciones con faltantes reales.
//
// Simular:
// node scripts/syncSubscriptionExtraNotices.js --batch=subscription-migration-2026-09 --out=extra-notices-dryrun.json
//
// Aplicar:
// node scripts/syncSubscriptionExtraNotices.js --batch=subscription-migration-2026-09 \
//   --apply --confirm=SYNC_EXTRA_SESSION_NOTICES --out=extra-notices-apply.json

import fs from "node:fs";
import dotenv from "dotenv";
import mongoose from "mongoose";

import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionExtraSessionNotice from "../src/models/SubscriptionExtraSessionNotice.js";
import {
  previewExtraSessionNoticeForUserService,
  syncExtraSessionNoticeForUserService,
} from "../src/services/subscriptions/subscriptionExtraSessions.js";

dotenv.config();

const CONFIRMATION = "SYNC_EXTRA_SESSION_NOTICES";

function parseArgs(argv = []) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, ...rest] = raw.slice(2).split("=");
    out[key] = rest.length ? rest.join("=") : true;
  }
  return out;
}

function bool(value) {
  if (value === true) return true;
  return ["1", "true", "yes", "si", "sí"].includes(
    String(value || "").toLowerCase().trim()
  );
}

const args = parseArgs(process.argv.slice(2));
const apply = bool(args.apply);
const batch = String(args.batch || "subscription-migration-2026-09").trim();
const outPath = String(
  args.out ||
    (apply
      ? "subscription-extra-notices-apply.json"
      : "subscription-extra-notices-dryrun.json")
).trim();

if (apply && String(args.confirm || "") !== CONFIRMATION) {
  console.error(`❌ Para aplicar agregá --confirm=${CONFIRMATION}`);
  process.exit(1);
}

const mongoUri =
  process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
if (!mongoUri) {
  console.error("❌ Falta MONGO_URI/MONGODB_URI/MONGO_URL.");
  process.exit(1);
}

await mongoose.connect(mongoUri);

try {
  const subscriptions = await ServiceSubscription.find({
    status: { $in: ["active", "pending_change", "suspended"] },
    ...(batch ? { "bootstrap.batchId": batch } : {}),
  })
    .sort({ serviceKey: 1, user: 1 })
    .lean();

  const results = [];

  for (const subscription of subscriptions) {
    try {
      const common = {
        userId: subscription.user,
        serviceKey: subscription.serviceKey,
      };

      const preview = await previewExtraSessionNoticeForUserService(common);

      if (!apply) {
        results.push({
          status:
            preview?.remainingSessions > 0
              ? "dry_run_ready"
              : preview?.skipped
                ? "skipped"
                : "no_extra_required",
          ...preview,
        });
        continue;
      }

      if (preview?.skipped || Number(preview?.remainingSessions || 0) <= 0) {
        results.push({ status: "skipped", ...preview });
        continue;
      }

      const synced = await syncExtraSessionNoticeForUserService({
        ...common,
        source: "manual_refresh",
      });
      results.push({ ...synced, status: synced?.skipped ? "skipped" : "created_or_updated" });
    } catch (error) {
      results.push({
        status: "error",
        subscriptionId: String(subscription._id),
        userId: String(subscription.user),
        serviceKey: subscription.serviceKey,
        error: error?.message || String(error),
      });
    }
  }

  const report = {
    mode: apply ? "apply" : "dry_run",
    batch,
    subscriptionsRead: subscriptions.length,
    ready: results.filter((item) => item.status === "dry_run_ready").length,
    createdOrUpdated: results.filter((item) => item.status === "created_or_updated").length,
    skipped: results.filter((item) => ["skipped", "no_extra_required"].includes(item.status)).length,
    errors: results.filter((item) => item.status === "error").length,
    noticesInDatabase: apply ? await SubscriptionExtraSessionNotice.countDocuments({}) : null,
    results,
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`✅ Reporte guardado en ${outPath}`);
  console.log({
    mode: report.mode,
    subscriptionsRead: report.subscriptionsRead,
    ready: report.ready,
    createdOrUpdated: report.createdOrUpdated,
    skipped: report.skipped,
    errors: report.errors,
  });
} finally {
  await mongoose.disconnect();
}
