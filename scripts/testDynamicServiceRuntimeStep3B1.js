// backend/scripts/testDynamicServiceRuntimeStep3B1.js
//
// READ-ONLY. No crea usuarios, turnos, créditos, reglas ni suscripciones.
//
// Uso:
//   node scripts/testDynamicServiceRuntimeStep3B1.js

import "dotenv/config";
import mongoose from "mongoose";

import ServiceDefinition from "../src/models/ServiceDefinition.js";
import CapacityRule from "../src/models/CapacityRule.js";

import {
  activeServiceKeysCached,
  allowedTimesForService,
  capacityGroupForService,
  catalogRuntimeSnapshot,
  capacityZonesForAdmin,
  ensureServiceCatalogLoaded,
  isKnownCatalogService,
  isServiceEnabledFor,
  normalizeCatalogServiceKey,
  serviceNameForKey,
} from "../src/services/serviceCatalogRuntime.js";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const mongoUri = String(process.env.MONGO_URI || "").trim();
  if (!mongoUri) throw new Error("Falta MONGO_URI.");

  await mongoose.connect(mongoUri);
  await ensureServiceCatalogLoaded({ force: true });

  const definitions = await ServiceDefinition.find({})
    .sort({ sortOrder: 1, serviceKey: 1 })
    .lean();

  const runtime = catalogRuntimeSnapshot();
  const activeReservable = activeServiceKeysCached({ flag: "reservable" });

  check(definitions.length > 0, "No hay ServiceDefinition.");
  check(runtime.length > 0, "El runtime quedó vacío.");

  const catalogKeys = definitions.map((item) =>
    String(item?.serviceKey || "").toUpperCase().trim()
  );

  for (const key of catalogKeys) {
    check(
      normalizeCatalogServiceKey(key) === key,
      `${key}: normalizeCatalogServiceKey no conserva la clave.`
    );
    check(
      isKnownCatalogService(key),
      `${key}: no existe en caché runtime.`
    );
    check(
      Boolean(serviceNameForKey(key)),
      `${key}: no tiene nombre runtime.`
    );
  }

  const operationalChecks = [];

  for (const key of activeReservable) {
    const definition = definitions.find(
      (item) =>
        String(item?.serviceKey || "").toUpperCase().trim() === key
    );

    const days = Array.isArray(definition?.weeklyHours)
      ? definition.weeklyHours.filter(
          (day) =>
            day?.enabled !== false &&
            Array.isArray(day?.ranges) &&
            day.ranges.length > 0
        )
      : [];

    check(days.length > 0, `${key}: reservable pero sin horarios.`);

    operationalChecks.push({
      serviceKey: key,
      name: serviceNameForKey(key),
      capacityGroup: capacityGroupForService(key),
      reservable: isServiceEnabledFor(key, "reservable"),
      fixedScheduleEnabled: isServiceEnabledFor(
        key,
        "fixedScheduleEnabled"
      ),
      recurringPlanEnabled: isServiceEnabledFor(
        key,
        "recurringPlanEnabled"
      ),
      waitlistEnabled: isServiceEnabledFor(key, "waitlistEnabled"),
      weeklyDays: days.map((day) => Number(day.weekday || 0)),
    });
  }

  // Test puro de horarios con una semana futura conocida.
  const sampleWeek = {
    1: "2099-01-05",
    2: "2099-01-06",
    3: "2099-01-07",
    4: "2099-01-08",
    5: "2099-01-09",
    6: "2099-01-10",
    7: "2099-01-11",
  };

  const scheduleChecks = [];

  for (const checkItem of operationalChecks) {
    for (const weekday of checkItem.weeklyDays) {
      const date = sampleWeek[weekday];
      if (!date) continue;
      const times = allowedTimesForService(checkItem.serviceKey, date);
      check(
        times.length > 0,
        `${checkItem.serviceKey}: no generó slots para weekday ${weekday}.`
      );

      scheduleChecks.push({
        serviceKey: checkItem.serviceKey,
        weekday,
        first: times[0],
        last: times[times.length - 1],
        count: times.length,
      });
    }
  }

  const capacityRulesCount = await CapacityRule.countDocuments({});

  const testService =
    runtime.find((item) => item.serviceKey === "TEST_SVC") || null;

  console.log(
    JSON.stringify(
      {
        ok: true,
        readOnly: true,
        writesToDatabase: false,
        catalogCount: definitions.length,
        runtimeCount: runtime.length,
        activeReservable,
        capacityRulesCount,
        capacityZones: capacityZonesForAdmin(),
        operationalChecks,
        scheduleChecks,
        testService: testService
          ? {
              serviceKey: testService.serviceKey,
              active: testService.active,
              reservable: testService.reservable,
              capacityGroup: testService.capacityGroup,
              known: isKnownCatalogService("TEST_SVC"),
            }
          : {
              exists: false,
              note: "TEST_SVC no es obligatorio para pasar el test.",
            },
      },
      null,
      2
    )
  );
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
