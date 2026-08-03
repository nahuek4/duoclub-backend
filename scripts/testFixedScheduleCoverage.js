// backend/scripts/testFixedScheduleCoverage.js
// Ejecutar desde /backend:
// node scripts/testFixedScheduleCoverage.js

import assert from "node:assert/strict";
import {
  buildFixedOccurrencesForMonth,
  calculateServiceMonthCoverage,
  calculateMonthlyCoverageByService,
} from "../src/services/subscriptions/fixedScheduleCoverage.js";

function schedule({ id, serviceKey, items, startDate = "2026-01-01", endDate = "2026-12-31" }) {
  return {
    _id: id,
    active: true,
    serviceKey,
    startDate,
    endDate,
    items,
  };
}

function run() {
  // Septiembre 2026 tiene cinco martes.
  const fiveTuesdays = schedule({
    id: "64b000000000000000000001",
    serviceKey: "EP",
    items: [{ weekday: 2, time: "18:00" }],
  });

  const generated = buildFixedOccurrencesForMonth({
    monthKey: "2026-09",
    serviceKey: "EP",
    schedules: [fiveTuesdays],
  });

  assert.equal(generated.occurrences.length, 5);
  assert.deepEqual(
    generated.occurrences.map((x) => x.date),
    ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"]
  );

  const planFour = calculateServiceMonthCoverage({
    monthKey: "2026-09",
    serviceKey: "EP",
    monthlySessions: 4,
    schedules: [fiveTuesdays],
  });

  assert.equal(planFour.fixedOccurrencesCount, 5);
  assert.equal(planFour.extraSessionsNeeded, 1);
  assert.equal(planFour.additionalSessionsStillNeeded, 1);
  assert.equal(planFour.pendingOccurrences.length, 1);
  assert.equal(planFour.pendingOccurrences[0].date, "2026-09-29");
  assert.equal(planFour.status, "extra_sessions_required");

  const planWithExtra = calculateServiceMonthCoverage({
    monthKey: "2026-09",
    serviceKey: "EP",
    monthlySessions: 4,
    extraSessionsSelected: 1,
    schedules: [fiveTuesdays],
  });

  assert.equal(planWithExtra.status, "covered");
  assert.equal(planWithExtra.coveredFixedOccurrences, 5);
  assert.equal(planWithExtra.occurrences[4].coverageSource, "extra");

  // Un bloqueo administrativo elimina esa ocurrencia del cálculo facturable.
  const blocked = calculateServiceMonthCoverage({
    monthKey: "2026-09",
    serviceKey: "EP",
    monthlySessions: 4,
    schedules: [fiveTuesdays],
    blocks: [
      {
        _id: "64c000000000000000000001",
        active: true,
        allServices: false,
        serviceKeys: ["EP"],
        dateFrom: "2026-09-29",
        dateTo: "2026-09-29",
        indefinite: false,
        allDay: true,
        weekdays: [],
        reason: "Cierre del club",
      },
    ],
  });

  assert.equal(blocked.fixedOccurrencesCount, 4);
  assert.equal(blocked.blockedOccurrencesCount, 1);
  assert.equal(blocked.status, "covered");
  assert.equal(blocked.extraSessionsNeeded, 0);

  // Dos horarios semanales se cuentan por fecha real, no como semanas x 4.
  const twoWeeklySlots = schedule({
    id: "64b000000000000000000002",
    serviceKey: "RF",
    items: [
      { weekday: 1, time: "17:00" },
      { weekday: 3, time: "17:00" },
    ],
  });

  const rf = calculateServiceMonthCoverage({
    monthKey: "2026-09",
    serviceKey: "RF",
    monthlySessions: 8,
    schedules: [twoWeeklySlots],
  });

  assert.equal(rf.fixedOccurrencesCount, 9); // 4 lunes + 5 miércoles.
  assert.equal(rf.extraSessionsNeeded, 1);
  assert.equal(rf.pendingOccurrences[0].date, "2026-09-30");

  // Planes combinados: cada servicio se calcula de manera independiente.
  const combined = calculateMonthlyCoverageByService({
    monthKey: "2026-09",
    plans: [
      { serviceKey: "EP", monthlySessions: 4 },
      { serviceKey: "RF", monthlySessions: 8 },
    ],
    schedules: [fiveTuesdays, twoWeeklySlots],
  });

  assert.equal(combined.EP.extraSessionsNeeded, 1);
  assert.equal(combined.RF.extraSessionsNeeded, 1);

  // Duplicados de patrón no deben cobrar dos veces el mismo slot.
  const duplicate = schedule({
    id: "64b000000000000000000003",
    serviceKey: "EP",
    items: [{ weekday: 2, time: "18:00" }],
  });

  const deduped = buildFixedOccurrencesForMonth({
    monthKey: "2026-09",
    serviceKey: "EP",
    schedules: [fiveTuesdays, duplicate],
  });

  assert.equal(deduped.occurrences.length, 5);
  assert.equal(deduped.duplicateOccurrences.length, 5);

  console.log("✅ fixedScheduleCoverage: todas las pruebas pasaron.");
}

run();
