import fs from "fs";
import dotenv from "dotenv";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import PricingPlan from "../src/models/PricingPlan.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import {
  periodDates,
  previewSubscriptionLifecycle,
  renewalPreviewDate,
} from "../src/services/subscriptions/subscriptionLifecycle.js";

dotenv.config();

function arg(name, fallback = "") {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const monthKey = arg("month");
const outPath = arg("out", monthKey ? `subscription-lifecycle-preview-${monthKey}.json` : "");
if (!/^\d{4}-\d{2}$/.test(monthKey)) {
  console.error("Uso: node scripts/previewSubscriptionLifecycle.js --month=2026-09 --out=archivo.json");
  process.exit(1);
}

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
if (!mongoUri) throw new Error("MONGO_URI no configurado.");

await mongoose.connect(mongoUri);
try {
  // imports usados para registrar schemas antes de populate
  void User;
  void PricingPlan;
  void ServiceSubscription;
  void SubscriptionBillingCycle;

  const report = await previewSubscriptionLifecycle({ periodKey: monthKey });
  const dates = periodDates(monthKey);
  const output = {
    generatedAt: new Date().toISOString(),
    periodKey: monthKey,
    renewalPreviewAt: renewalPreviewDate(monthKey).toISOString(),
    periodStart: dates.start.toISOString(),
    dueAt: dates.dueAt.toISOString(),
    suspendAt: dates.suspendAt.toISOString(),
    fixedSlotsProtectedUntil: dates.fixedSlotsProtectedUntil.toISOString(),
    terminateAt: dates.terminateAt.toISOString(),
    ...report,
  };

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`✅ Preview guardado en ${outPath}`);
  }

  const byService = {};
  for (const row of report.rows) {
    const key = `${row.serviceKey}-${row.planSessions}-${row.payMethod}`;
    if (!byService[key]) {
      byService[key] = {
        servicio: row.serviceKey,
        sesiones: row.planSessions,
        pago: row.payMethod,
        cantidad: 0,
        importe: row.amount,
      };
    }
    byService[key].cantidad += 1;
  }

  console.log({
    periodKey: monthKey,
    subscriptionsRead: report.subscriptionsRead,
    withoutCycle: report.withoutCycle,
    withCycle: report.withCycle,
  });
  console.table(Object.values(byService));
} finally {
  await mongoose.disconnect();
}
