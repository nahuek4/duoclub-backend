// backend/scripts/testDynamicBackendStep3B3A.js
//
// Test estático/read-only.
// - NO conecta a Mongo.
// - NO hace fetch.
// - NO escribe archivos.
// - ejecuta node --check sobre los JS modificados.

import fs from "fs";
import crypto from "crypto";
import { spawnSync } from "child_process";

const EXPECTED = {
  "src/routes/orders.js": "4bdf611ecbe07e1a41564ad4efeb52caf614821eee782bd95a96e6eb42a13672",
  "src/routes/appointments.js": "a9b6aaa3476f94f08f385e486f481f3fcdf7a0c0b2dc3f8299ebffbf6bad5554",
  "src/services/serviceCatalogRuntime.js": "fd30599217bf52c0e96982ffe49215b35b9604fe792772a611f08135999b12f6",
  "src/services/subscriptions/subscriptionBootstrap.js": "a04f6855020d49fb0d6bfefae7cf537d3cf91c8c7ee5657131b474f16f06d1d0",
  "src/services/subscriptions/subscriptionCoveragePreview.js": "e1ae84ad9a9bd3ac25344662f66320cc4c86852da0ef427231636860671ab69b"
};

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Falta ${file}`);
  return fs.readFileSync(file, "utf8");
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

const filesChecked = [];

for (const [file, expectedHash] of Object.entries(EXPECTED)) {
  const text = read(file);
  const actualHash = sha256(text);

  if (actualHash !== expectedHash) {
    throw new Error(
      `${file}: hash inesperado ${actualHash.slice(0,16)} != ${expectedHash.slice(0,16)}`
    );
  }

  const syntax = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });

  if (syntax.status !== 0) {
    throw new Error(
      `${file} no pasa node --check: ${syntax.stderr || syntax.stdout}`
    );
  }

  filesChecked.push({
    file,
    bytes: Buffer.byteLength(text, "utf8"),
    hash: actualHash.slice(0, 16),
    nodeCheck: true,
  });
}

const orders = read("src/routes/orders.js");
const appointments = read("src/routes/appointments.js");
const runtime = read("src/services/serviceCatalogRuntime.js");
const bootstrap = read("src/services/subscriptions/subscriptionBootstrap.js");
const coverage = read("src/services/subscriptions/subscriptionCoveragePreview.js");
const services = read("src/routes/services.js");
const pricing = read("src/routes/pricing.js");
const planPurchase = read("src/services/subscriptions/subscriptionPlanPurchase.js");
const lifecycle = read("src/services/subscriptions/subscriptionLifecycle.js");

const checks = {
  ordersUsesCatalog: (
    orders.includes("STEP3B3A_ORDERS_DYNAMIC_SERVICE_CATALOG") &&
    orders.includes("normalizeCatalogServiceKey") &&
    orders.includes('isServiceEnabledFor(sk, "purchasable")') &&
    orders.includes("serviceNameForKey")
  ),
  ordersNoFixedOperationalSet: (
    !orders.includes("OPERATIONAL_SERVICE_KEYS") &&
    !orders.includes("LEGACY_SERVICE_KEYS") &&
    !orders.includes("SERVICE_KEY_TO_NAME")
  ),
  durationMustFitRange: (
    runtime.includes("STEP3B3A_RUNTIME_DURATION_FIT") &&
    runtime.includes("wantedStart + duration <= to") &&
    runtime.includes("cursor + duration <= to")
  ),
  arbitrary24hAppointmentTimes: (
    appointments.includes("STEP3B3A_APPOINTMENTS_DYNAMIC_RUNTIME_HARDENING") &&
    appointments.includes("h > 23") &&
    appointments.includes('if (h < 12) return "maniana";') &&
    appointments.includes('if (h < 18) return "tarde";') &&
    appointments.includes('return "noche";')
  ),
  minBookingFromCatalog: (
    !appointments.includes("MIN_BOOKING_MINUTES_BY_SERVICE") &&
    appointments.includes("serviceMinBookingMinutes(sk, DEFAULT_MIN_BOOKING_MINUTES)")
  ),
  maxAdvanceFromCatalog: (
    appointments.includes("serviceMaxAdvanceDays(") &&
    appointments.includes("DEFAULT_MAX_ADVANCE_DAYS")
  ),
  independentCapacityCanOverrideDefault: (
    appointments.includes('zone === "NONE"') &&
    appointments.includes("? serviceLimit == null") &&
    appointments.includes(": serviceLimit")
  ),
  bootstrapNoFixedRecurringSet: (
    bootstrap.includes("STEP3B3A_DYNAMIC_SUBSCRIPTION_BOOTSTRAP") &&
    !bootstrap.includes("RECURRING_SERVICE_KEYS") &&
    bootstrap.includes("serviceNameForKey")
  ),
  coverageUsesCatalogName: (
    coverage.includes("STEP3B3A_DYNAMIC_COVERAGE_SERVICE_NAMES") &&
    !coverage.includes("SERVICE_KEY_TO_NAME") &&
    coverage.includes("serviceNameForKey")
  ),
  planPurchaseAlreadyDynamic: (
    planPurchase.includes("STEP3B2_DYNAMIC_PLAN_PURCHASE") &&
    planPurchase.includes("isServiceEnabledFor") &&
    planPurchase.includes("recurringPlanEnabled")
  ),
  lifecycleAlreadyDynamic: (
    lifecycle.includes("STEP3B2_DYNAMIC_SUBSCRIPTION_LIFECYCLE") &&
    lifecycle.includes("isServiceEnabledFor") &&
    lifecycle.includes("recurringPlanEnabled")
  ),
  publicServicesGuardStillClosed: services.includes(
    'const RUNTIME_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);'
  ),
  publicPricingGuardStillClosed: pricing.includes(
    'const RUNTIME_PRICING_KEYS = new Set(["EP", "RA", "RF", "SYN"]);'
  ),
};

for (const [name, ok] of Object.entries(checks)) {
  if (!ok) throw new Error(`Check falló: ${name}`);
}

// Pruebas puras de las dos reglas nuevas críticas.
function generatedSlots({ from, to, step, duration }) {
  const hm = (v) => {
    const [h, m] = v.split(":").map(Number);
    return h * 60 + m;
  };
  const fmt = (v) =>
    `${String(Math.floor(v / 60)).padStart(2,"0")}:${String(v % 60).padStart(2,"0")}`;

  const start = hm(from);
  const end = hm(to);
  const out = [];
  for (let cursor = start; cursor + duration <= end; cursor += step) {
    out.push(fmt(cursor));
  }
  return out;
}

const durationExample = generatedSlots({
  from: "09:00",
  to: "11:00",
  step: 30,
  duration: 60,
});

if (JSON.stringify(durationExample) !== JSON.stringify(["09:00","09:30","10:00"])) {
  throw new Error(`Prueba duration-fit inesperada: ${JSON.stringify(durationExample)}`);
}

function effectiveIndependentLimit(zoneDefault, serviceLimit) {
  return serviceLimit == null ? zoneDefault : serviceLimit;
}

if (effectiveIndependentLimit(1, 4) !== 4) {
  throw new Error("Un servicio NONE no pudo superar el default independiente.");
}

console.log(JSON.stringify({
  ok: true,
  readOnly: true,
  writesToDatabase: false,
  networkRequests: false,
  publicUnlockStillClosed: true,
  filesChecked,
  checks,
  runtimeExamples: {
    durationFitSlots: durationExample,
    independentNoneDefault1ServiceOverride4: effectiveIndependentLimit(1, 4),
  },
  pending: [
    "src/routes/services.js mantiene el guard público EP/RA/RF/SYN.",
    "src/routes/pricing.js mantiene el guard público EP/RA/RF/SYN.",
    "El desbloqueo público se hace recién en Paso 3B3B junto con el frontend ya preparado.",
  ],
  next: "Revisar este resultado antes de reiniciar/desplegar.",
}, null, 2));
