// backend/scripts/testDynamicSubscriptionsStep3B2.js
//
// READ-ONLY.
// No crea ciclos, no acredita créditos, no actualiza precios.
//
// Ejecutar DESPUÉS del apply:
//   node scripts/testDynamicSubscriptionsStep3B2.js

import "dotenv/config";
import mongoose from "mongoose";

import PricingPlan from "../src/models/PricingPlan.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import SubscriptionExtraSessionNotice from "../src/models/SubscriptionExtraSessionNotice.js";

import {
  ensureServiceCatalogLoaded,
  activeServiceKeysCached,
  isKnownCatalogService,
  serviceNameForKey,
} from "../src/services/serviceCatalogRuntime.js";

import {
  resolvePlanSnapshot,
} from "../src/services/subscriptions/subscriptionLifecycle.js";

import {
  normalizeServiceKey,
} from "../src/services/subscriptions/fixedScheduleCoverage.js";

function clean(value) {
  return String(value || "").trim();
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

async function main() {
  const mongoUri = clean(process.env.MONGO_URI);
  if (!mongoUri) throw new Error("Falta MONGO_URI.");

  await mongoose.connect(mongoUri);
  await ensureServiceCatalogLoaded({ force: true });

  const recurringKeys = activeServiceKeysCached({
    flag: "recurringPlanEnabled",
  });

  const subscriptions = await ServiceSubscription.find({
    autoRenew: true,
    status: { $in: ["active", "pending_change"] },
  })
    .sort({ serviceKey: 1, createdAt: 1 })
    .lean();

  const rows = [];
  const pricingErrors = [];
  const staleStoredPrices = [];

  for (const subscription of subscriptions) {
    const key = clean(subscription.serviceKey).toUpperCase();

    if (!recurringKeys.includes(key)) {
      rows.push({
        subscriptionId: String(subscription._id),
        serviceKey: key,
        skipped: true,
        reason: "SERVICE_NOT_RECURRING_IN_CATALOG",
      });
      continue;
    }

    try {
      const snapshot = await resolvePlanSnapshot(subscription);

      const storedPrice = money(subscription.price);
      const currentRenewalPrice = money(snapshot.basePrice);

      const row = {
        subscriptionId: String(subscription._id),
        userId: String(subscription.user),
        serviceKey: key,
        serviceName: serviceNameForKey(key),
        sessions: snapshot.monthlySessions,
        payMethod: snapshot.payMethod,
        pricingPlanId: String(snapshot.pricingPlan),
        storedSubscriptionPrice: storedPrice,
        currentRenewalPrice,
        regularPrice: money(snapshot.regularPrice),
        coverageApplied: !!snapshot.coverageApplied,
        coveragePrice:
          snapshot.coveragePrice === null
            ? null
            : money(snapshot.coveragePrice),
        priceChangedSinceSubscription:
          storedPrice !== currentRenewalPrice,
      };

      rows.push(row);

      if (row.priceChangedSinceSubscription) {
        staleStoredPrices.push(row);
      }
    } catch (error) {
      pricingErrors.push({
        subscriptionId: String(subscription._id),
        userId: String(subscription.user),
        serviceKey: key,
        sessions: Number(subscription.monthlySessions || 0),
        payMethod: subscription.payMethod || "",
        error: error?.message || String(error),
      });
    }
  }

  const [publishedPlans, paidCycles, extras] = await Promise.all([
    PricingPlan.find({
      active: true,
      isCustom: { $ne: true },
    })
      .select("_id serviceKey credits price coveragePrice payMethod active")
      .sort({ serviceKey: 1, credits: 1, payMethod: 1 })
      .lean(),
    SubscriptionBillingCycle.countDocuments({
      "billing.status": "paid",
    }),
    SubscriptionExtraSessionNotice.find({})
      .select("serviceKey periodKey status")
      .lean(),
  ]);

  const unknownExtraServiceKeys = [
    ...new Set(
      extras
        .map((item) => clean(item.serviceKey).toUpperCase())
        .filter(Boolean)
        .filter((key) => !isKnownCatalogService(key))
    ),
  ];

  const ok =
    pricingErrors.length === 0 &&
    unknownExtraServiceKeys.length === 0 &&
    normalizeServiceKey("TEST_SVC") === "TEST_SVC";

  console.log(
    JSON.stringify(
      {
        ok,
        readOnly: true,
        writesToDatabase: false,
        recurringCatalogKeys: recurringKeys,
        renewableSubscriptionsRead: subscriptions.length,
        renewableSubscriptionsResolved:
          rows.filter((row) => !row.skipped).length,
        pricingErrors,
        staleStoredPrices,
        noteOnStaleStoredPrices:
          "Son informativos: NO se modificaron. En la próxima renovación el ciclo usará currentRenewalPrice y recién entonces la suscripción reflejará el precio vigente.",
        publishedPlanCount: publishedPlans.length,
        paidHistoricalCyclesUntouched: paidCycles,
        unknownExtraServiceKeys,
        dynamicNormalizationCheck: {
          input: "TEST_SVC",
          output: normalizeServiceKey("TEST_SVC"),
          ok: normalizeServiceKey("TEST_SVC") === "TEST_SVC",
        },
        resolvedSubscriptions: rows,
      },
      null,
      2
    )
  );

  if (!ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          readOnly: true,
          writesToDatabase: false,
          error: error?.message || String(error),
          stack: error?.stack || "",
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch {
      // no-op
    }
  });
