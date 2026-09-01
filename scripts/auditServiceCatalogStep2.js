// backend/scripts/auditServiceCatalogStep2.js
// Auditoría SOLO LECTURA para el Paso 2 de servicios dinámicos.
// Uso: node scripts/auditServiceCatalogStep2.js

import "dotenv/config";
import mongoose from "mongoose";

import ServiceDefinition from "../src/models/ServiceDefinition.js";
import PricingPlan from "../src/models/PricingPlan.js";

const REQUIRED_RUNTIME_KEYS = ["EP", "RA", "RF", "SYN"];

function clean(value) {
  return String(value || "").trim();
}

function duplicateKey(plan) {
  return [
    clean(plan?.serviceKey).toUpperCase(),
    clean(plan?.payMethod).toUpperCase(),
    Number(plan?.credits || 0),
  ].join("__");
}

async function main() {
  const uri = clean(process.env.MONGO_URI);
  if (!uri) throw new Error("Falta MONGO_URI.");

  await mongoose.connect(uri);

  const [services, plans] = await Promise.all([
    ServiceDefinition.find({}).sort({ sortOrder: 1, serviceKey: 1 }).lean(),
    PricingPlan.find({}).sort({ serviceKey: 1, payMethod: 1, credits: 1 }).lean(),
  ]);

  const serviceKeys = new Set(
    services.map((service) => clean(service?.serviceKey).toUpperCase()).filter(Boolean)
  );

  const missingRuntimeServices = REQUIRED_RUNTIME_KEYS.filter(
    (key) => !serviceKeys.has(key)
  );

  const orphanPricingPlans = plans
    .filter((plan) => !serviceKeys.has(clean(plan?.serviceKey).toUpperCase()))
    .map((plan) => ({
      id: String(plan?._id || ""),
      serviceKey: plan?.serviceKey,
      payMethod: plan?.payMethod,
      credits: plan?.credits,
      price: plan?.price,
      active: plan?.active !== false,
      isCustom: plan?.isCustom === true,
    }));

  const standardGroups = new Map();
  for (const plan of plans.filter((item) => item?.isCustom !== true)) {
    const key = duplicateKey(plan);
    if (!standardGroups.has(key)) standardGroups.set(key, []);
    standardGroups.get(key).push(plan);
  }

  const duplicateStandardPlans = [...standardGroups.entries()]
    .filter(([, items]) => items.length > 1)
    .map(([key, items]) => ({
      key,
      count: items.length,
      ids: items.map((item) => String(item._id)),
      activeCount: items.filter((item) => item.active !== false).length,
    }));

  const servicesSummary = services.map((service) => ({
    serviceKey: service.serviceKey,
    name: service.name,
    active: service.active !== false,
    catalogVisible: service.catalogVisible !== false,
    purchasable: service.purchasable !== false,
    reservable: service.reservable !== false,
    recurringPlanEnabled: service.recurringPlanEnabled !== false,
    fixedScheduleEnabled: service.fixedScheduleEnabled !== false,
    capacityGroup: service.capacityGroup,
    legacy: service.legacy === true,
    weeklyDays: Array.isArray(service.weeklyHours)
      ? service.weeklyHours.filter((day) => day?.enabled !== false && day?.ranges?.length).length
      : 0,
  }));

  const report = {
    ok:
      missingRuntimeServices.length === 0 &&
      orphanPricingPlans.length === 0,
    readOnly: true,
    serviceCount: services.length,
    pricingPlanCount: plans.length,
    missingRuntimeServices,
    orphanPricingPlans,
    duplicateStandardPlans,
    services: servicesSummary,
  };

  console.log(JSON.stringify(report, null, 2));

  if (!report.ok) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          readOnly: true,
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
