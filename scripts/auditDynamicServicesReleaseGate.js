// backend/scripts/auditDynamicServicesReleaseGate.js
//
// PASO 3B3 — AUDITORÍA READ-ONLY PARA LIBERAR SERVICIOS DINÁMICOS
//
// Uso desde la raíz del backend:
//   node scripts/auditDynamicServicesReleaseGate.js
//
// NO conecta a Mongo.
// NO hace requests HTTP.
// NO escribe archivos.
// Solo inspecciona el código fuente presente en el servidor.

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

const candidates = [
  "src/routes/orders.js",
  "src/routes/services.js",
  "src/routes/pricing.js",
  "src/routes/subscriptions.js",
  "src/routes/subscriptionExtras.js",
  "src/routes/subscription-extras.js",
  "src/routes/adminSubscriptions.js",
  "src/routes/adminPlans.js",
  "src/routes/appointments.js",
  "src/services/serviceCatalogRuntime.js",
  "src/services/subscriptions/subscriptionBootstrap.js",
  "src/services/subscriptions/subscriptionCoveragePreview.js",
  "src/services/subscriptions/subscriptionCyclePaymentHelpers.js",
  "src/services/subscriptions/subscriptionCyclePayments.js",
  "src/services/subscriptions/subscriptionExtraSessions.js",
  "src/services/subscriptions/subscriptionPlanPurchase.js",
  "src/services/subscriptions/subscriptionLifecycle.js",
  "src/services/subscriptions/fixedScheduleCoverage.js",
];

const LEGACY_KEYS = ["PE", "EP", "RA", "RF", "KD", "SYN", "NUT"];
const CORE_RUNTIME_KEYS = ["EP", "RA", "RF", "SYN"];

function read(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf8");
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function snippetsFor(text, regex, max = 20) {
  const out = [];
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) && out.length < max) {
    const line = lineOf(text, m.index);
    const start = Math.max(0, m.index - 100);
    const end = Math.min(text.length, m.index + m[0].length + 180);
    out.push({
      line,
      match: m[0].slice(0, 220),
      context: text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 420),
    });
    if (!regex.global) break;
  }
  return out;
}

function inspect(rel, text) {
  const findings = [];

  const rules = [
    {
      id: "operational_service_keys",
      severity: "BLOCKER",
      regex: /\bOPERATIONAL_SERVICE_KEYS\b/g,
      message: "Lista fija de servicios habilitados para nueva operatoria.",
    },
    {
      id: "fixed_core_array",
      severity: "BLOCKER",
      regex: /\[\s*["']EP["']\s*,\s*["']RA["']\s*,\s*["']RF["']\s*,\s*["']SYN["']\s*\]/g,
      message: "Array fijo EP/RA/RF/SYN en una ruta/servicio operativo.",
    },
    {
      id: "fixed_core_set",
      severity: "BLOCKER",
      regex: /new\s+Set\s*\(\s*\[\s*["']EP["']\s*,\s*["']RA["']\s*,\s*["']RF["']\s*,\s*["']SYN["']\s*\]\s*\)/g,
      message: "Set fijo EP/RA/RF/SYN.",
    },
    {
      id: "legacy_normalizer_gate",
      severity: "REVIEW",
      regex: /\bLEGACY_SERVICE_KEYS\b/g,
      message: "Lista legacy: válida para lectura histórica, pero no debe bloquear altas nuevas.",
    },
    {
      id: "hardcoded_therapy_group",
      severity: "REVIEW",
      regex: /\[\s*["']RA["']\s*,\s*["']RF["']\s*,\s*["']SYN["']\s*\]/g,
      message: "Grupo Performance hardcodeado; debería derivar de capacityGroup cuando sea runtime.",
    },
    {
      id: "hardcoded_service_name_map",
      severity: "REVIEW",
      regex: /\bSERVICE_KEY_TO_NAME\b|\bSERVICE_KEY_TO_LABEL\b/g,
      message: "Mapa fijo de nombres; los servicios nuevos deben resolver nombre por catálogo.",
    },
    {
      id: "service_retired_gate",
      severity: "BLOCKER",
      regex: /\bSERVICE_RETIRED\b/g,
      message: "Gate de servicio retirado; revisar que consulte ServiceDefinition y no lista fija.",
    },
    {
      id: "runtime_integrated_guard",
      severity: "BLOCKER",
      regex: /\bruntimeIntegrated\b/g,
      message: "Guard público temporal de integración. Debe revisarse antes de exponer servicios nuevos.",
    },
    {
      id: "fixed_max_advance",
      severity: "REVIEW",
      regex: /\bMAX_ADVANCE_DAYS\s*=\s*30\b/g,
      message: "Ventana máxima fija; debería usar maxAdvanceDays de ServiceDefinition.",
    },
    {
      id: "fixed_booking_minutes_map",
      severity: "REVIEW",
      regex: /\bMIN_BOOKING_MINUTES_BY_SERVICE\b/g,
      message: "Anticipación por servicio hardcodeada.",
    },
    {
      id: "fixed_waitlist_gate",
      severity: "REVIEW",
      regex: /sk\s*===\s*["']EP["']\s*\|\||isTherapyService\s*\(/g,
      message: "Waitlist posiblemente limitado a EP/therapy fijo.",
    },
    {
      id: "fixed_turno_bucket",
      severity: "REVIEW",
      regex: /\bgetTurnoFromTime\b/g,
      message: "Revisar soporte de horarios fuera de buckets históricos.",
    },
  ];

  for (const rule of rules) {
    const matches = snippetsFor(text, rule.regex);
    if (matches.length) {
      findings.push({
        id: rule.id,
        severity: rule.severity,
        message: rule.message,
        matches,
      });
    }
  }

  return {
    file: rel,
    bytes: Buffer.byteLength(text, "utf8"),
    findings,
  };
}

const files = [];
for (const rel of candidates) {
  const text = read(rel);
  if (text === null) continue;
  files.push(inspect(rel, text));
}

const foundFiles = new Set(files.map((x) => x.file));

const required = [
  "src/routes/orders.js",
  "src/routes/services.js",
  "src/routes/appointments.js",
  "src/services/serviceCatalogRuntime.js",
  "src/services/subscriptions/subscriptionExtraSessions.js",
  "src/services/subscriptions/subscriptionPlanPurchase.js",
  "src/services/subscriptions/subscriptionLifecycle.js",
];

const missingRequired = required.filter((rel) => !foundFiles.has(rel));

const blockers = [];
const review = [];

for (const file of files) {
  for (const finding of file.findings) {
    const row = {
      file: file.file,
      id: finding.id,
      message: finding.message,
      matches: finding.matches,
    };
    if (finding.severity === "BLOCKER") blockers.push(row);
    else review.push(row);
  }
}

// Reglas específicas de checkout.
const orders = read("src/routes/orders.js") || "";
const ordersChecks = {
  exists: Boolean(orders),
  hasOperationalFixedSet:
    /\bOPERATIONAL_SERVICE_KEYS\b/.test(orders) ||
    /new\s+Set\s*\(\s*\[\s*["']EP["']\s*,\s*["']RA["']\s*,\s*["']RF["']\s*,\s*["']SYN["']/.test(orders),
  operationalNormalizerUsesFixedSet:
    /function\s+normalizeOperationalServiceKey[\s\S]{0,500}OPERATIONAL_SERVICE_KEYS\.has/.test(orders),
  checkoutCallsOperationalAssert:
    /assertOperationalServiceKey\s*\(/.test(orders) ||
    /normalizeOperationalServiceKey\s*\(/.test(orders),
  pricingPlanLookupPresent: /PricingPlan\.find/.test(orders),
  subscriptionExtrasIntegrated: /resolveExtraSessionCheckoutItem/.test(orders),
  subscriptionPlanPurchaseIntegrated: /finalizePaidPlanOrder|activateSubscriptionsFromPaidOrder/.test(orders),
  subscriptionRenewalIntegrated: /applySubscriptionRenewalFromOrder|getSubscriptionRenewalItems/.test(orders),
};

// Servicio público.
const servicesRoute = read("src/routes/services.js") || "";
const publicCatalogChecks = {
  exists: Boolean(servicesRoute),
  hasRuntimeIntegratedGuard: /\bruntimeIntegrated\b/.test(servicesRoute),
  hasFixedCoreKeys:
    /["']EP["'][\s\S]{0,100}["']RA["'][\s\S]{0,100}["']RF["'][\s\S]{0,100}["']SYN["']/.test(
      servicesRoute
    ),
};

// Backend scheduling.
const appointments = read("src/routes/appointments.js") || "";
const runtime = read("src/services/serviceCatalogRuntime.js") || "";
const scheduleChecks = {
  appointmentsHasFixedMaxAdvance: /\bMAX_ADVANCE_DAYS\s*=\s*30\b/.test(appointments),
  appointmentsHasFixedMinBookingMap: /\bMIN_BOOKING_MINUTES_BY_SERVICE\b/.test(appointments),
  appointmentsHasHardcodedWaitlistGroup:
    /\[\s*["']RA["']\s*,\s*["']RF["']\s*,\s*["']SYN["']\s*\]/.test(appointments),
  appointmentsHasGetTurnoFromTime: /\bgetTurnoFromTime\b/.test(appointments),
  runtimeAllowedTimesFunction: /\ballowedTimesForService\b/.test(runtime),
  runtimeChecksDurationInsideRange:
    /duration[\s\S]{0,300}(?:range|to)|(?:range|to)[\s\S]{0,300}duration/.test(runtime),
};

const okForPublicUnlock =
  missingRequired.length === 0 &&
  !ordersChecks.hasOperationalFixedSet &&
  !ordersChecks.operationalNormalizerUsesFixedSet &&
  !publicCatalogChecks.hasRuntimeIntegratedGuard;

const result = {
  ok: true,
  readOnly: true,
  writesToDatabase: false,
  networkRequests: false,
  root: ROOT,
  filesInspected: files.map((x) => ({
    file: x.file,
    bytes: x.bytes,
    findingsCount: x.findings.length,
  })),
  missingRequired,
  releaseGate: {
    okForPublicUnlock,
    blockersCount: blockers.length,
    reviewCount: review.length,
  },
  ordersChecks,
  publicCatalogChecks,
  scheduleChecks,
  blockers,
  review,
  notes: [
    "LEGACY_SERVICE_KEYS puede seguir existiendo para leer historial, siempre que no bloquee nuevas compras.",
    "PERFORMANCE_COPAY_KEYS puede ser una regla comercial específica; no se elimina automáticamente.",
    "No quitar el guard público de /services hasta cerrar checkout/orders y validar agenda/capacidad.",
    "No se realizó ninguna escritura ni request de red.",
  ],
};

console.log(JSON.stringify(result, null, 2));
