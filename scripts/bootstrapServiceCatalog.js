// backend/scripts/bootstrapServiceCatalog.js
//
// Uso:
//   node scripts/bootstrapServiceCatalog.js --dry-run
//   node scripts/bootstrapServiceCatalog.js --apply
//
// El script SOLO INSERTA servicios faltantes.
// Nunca pisa configuraciones existentes.

import "dotenv/config";
import mongoose from "mongoose";

import ServiceDefinition, {
  CORE_SERVICE_DEFINITIONS,
} from "../src/models/ServiceDefinition.js";

function hasFlag(name) {
  return process.argv.includes(name);
}

function clean(value) {
  return String(value || "").trim();
}

async function main() {
  const apply = hasFlag("--apply");
  const mongoUri = clean(process.env.MONGO_URI);

  if (!mongoUri) {
    throw new Error("Falta MONGO_URI en el entorno.");
  }

  await mongoose.connect(mongoUri);

  const existing = await ServiceDefinition.find({})
    .select("serviceKey name active catalogVisible legacy")
    .sort({ serviceKey: 1 })
    .lean();

  const existingByKey = new Map(
    existing.map((item) => [String(item.serviceKey || "").toUpperCase(), item])
  );

  const missing = CORE_SERVICE_DEFINITIONS.filter(
    (item) => !existingByKey.has(String(item.serviceKey).toUpperCase())
  );

  const summary = {
    mode: apply ? "APPLY" : "DRY_RUN",
    collection: ServiceDefinition.collection.name,
    existingCount: existing.length,
    seedCount: CORE_SERVICE_DEFINITIONS.length,
    missingCount: missing.length,
    existing: existing.map((item) => ({
      serviceKey: item.serviceKey,
      name: item.name,
      active: item.active !== false,
      catalogVisible: item.catalogVisible !== false,
      legacy: item.legacy === true,
    })),
    missing: missing.map((item) => ({
      serviceKey: item.serviceKey,
      name: item.name,
      active: item.active !== false,
      catalogVisible: item.catalogVisible !== false,
      capacityGroup: item.capacityGroup,
      weeklyHours: item.weeklyHours,
      legacy: item.legacy === true,
    })),
  };

  if (apply && missing.length) {
    const operations = missing.map((item) => ({
      updateOne: {
        filter: { serviceKey: item.serviceKey },
        update: { $setOnInsert: item },
        upsert: true,
      },
    }));

    const result = await ServiceDefinition.bulkWrite(operations, {
      ordered: false,
    });

    summary.applied = {
      upsertedCount: Number(result?.upsertedCount || 0),
      modifiedCount: Number(result?.modifiedCount || 0),
      matchedCount: Number(result?.matchedCount || 0),
    };
  } else {
    summary.applied = {
      upsertedCount: 0,
      modifiedCount: 0,
      matchedCount: 0,
    };
  }

  const after = await ServiceDefinition.find({})
    .select(
      "serviceKey name active catalogVisible purchasable reservable recurringPlanEnabled fixedScheduleEnabled waitlistEnabled capacityGroup weeklyHours legacy sortOrder"
    )
    .sort({ sortOrder: 1, serviceKey: 1 })
    .lean();

  summary.afterCount = after.length;
  summary.after = after;

  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
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
