// backend/scripts/testDynamicBackendStep3B3B.js
//
// Test estático/read-only del release gate dinámico.
// NO conecta a Mongo. NO hace fetch. NO escribe archivos.

import fs from "fs";
import crypto from "crypto";
import { spawnSync } from "child_process";

const EXPECTED = {
  "src/routes/services.js": "b119bb8beeafd9e9918b59f1d57fafa5e75dbcce36328713651d9963d82350f9",
  "src/routes/pricing.js": "00e6e6dc756abcc8406658ea45a09e1ae8638ef167e72e6c3686dec267aa0c6a"
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
  const hash = sha256(text);
  if (hash !== expectedHash) {
    throw new Error(`${file}: hash inesperado ${hash.slice(0,16)} != ${expectedHash.slice(0,16)}`);
  }

  const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (syntax.status !== 0) {
    throw new Error(`${file} no pasa node --check: ${syntax.stderr || syntax.stdout}`);
  }

  filesChecked.push({
    file,
    bytes: Buffer.byteLength(text, "utf8"),
    hash: hash.slice(0,16),
    nodeCheck: true,
  });
}

const services = read("src/routes/services.js");
const pricing = read("src/routes/pricing.js");
const orders = read("src/routes/orders.js");
const appointments = read("src/routes/appointments.js");
const runtime = read("src/services/serviceCatalogRuntime.js");

const checks = {
  step3B3AStillPresent: (
    orders.includes("STEP3B3A_ORDERS_DYNAMIC_SERVICE_CATALOG") &&
    appointments.includes("STEP3B3A_APPOINTMENTS_DYNAMIC_RUNTIME_HARDENING") &&
    runtime.includes("STEP3B3A_RUNTIME_DURATION_FIT")
  ),
  publicServicesDynamic: (
    services.includes("STEP3B3B_PUBLIC_DYNAMIC_SERVICE_CATALOG") &&
    services.includes("ServiceDefinition.find({") &&
    services.includes("catalogVisible: { $ne: false }") &&
    services.includes("legacy: { $ne: true }") &&
    services.includes("isPublicCatalogService")
  ),
  publicServicesFixedGuardRemoved: (
    !services.includes("RUNTIME_SERVICE_KEYS") &&
    !services.includes('new Set(["EP", "RA", "RF", "SYN"])')
  ),
  runtimeIntegratedIsCapabilityNotAllowlist: (
    services.includes("runtimeIntegrated: isRuntimeIntegratedService(service)")
  ),
  initializedEmptyCatalogDoesNotReviveFallback: (
    services.includes("const catalogInitialized = Boolean(await ServiceDefinition.exists({}));") &&
    services.includes("catalogInitialized ? [] : fallbackOperationalServices()")
  ),
  publicPricingDynamic: (
    pricing.includes("STEP3B3B_PUBLIC_DYNAMIC_PRICING") &&
    pricing.includes("publicPurchasableServiceKeys") &&
    pricing.includes("purchasable: { $ne: false }") &&
    pricing.includes("catalogVisible: { $ne: false }")
  ),
  publicPricingFixedGuardRemoved: (
    !pricing.includes("RUNTIME_PRICING_KEYS") &&
    !pricing.includes('new Set(["EP", "RA", "RF", "SYN"])')
  ),
  inactiveCatalogDoesNotExposePricingFallback: (
    pricing.includes("const catalogInitialized = Boolean(await ServiceDefinition.exists({}));") &&
    pricing.includes("if (catalogInitialized) return [];")
  ),
  pricingFallbackUsesCentralCoreDefinitions: (
    pricing.includes("CORE_SERVICE_DEFINITIONS") &&
    pricing.includes("service?.purchasable !== false")
  ),
};

for (const [name, ok] of Object.entries(checks)) {
  if (!ok) throw new Error(`Check falló: ${name}`);
}

console.log(JSON.stringify({
  ok: true,
  readOnly: true,
  writesToDatabase: false,
  networkRequests: false,
  publicDynamicCatalogEnabled: true,
  filesChecked,
  checks,
  expectedPostRestart: {
    publicServices: "Solo servicios ServiceDefinition activos, catalogVisible y no legacy.",
    activePricing: "Solo planes activos de servicios activos, visibles, comprables y no legacy.",
    currentProductionExpected: ["EP", "RA", "RF", "SYN"],
  },
  next: "Reiniciar PM2 y verificar /health + /services antes de desplegar el frontend 3C.",
}, null, 2));
