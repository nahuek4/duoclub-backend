import fs from "fs";
import path from "path";

const root = process.cwd();
const purchasePath = path.join(root, "src/services/subscriptions/subscriptionPlanPurchase.js");
const lifecyclePath = path.join(root, "src/services/subscriptions/subscriptionLifecycle.js");

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

for (const file of [purchasePath, lifecyclePath]) {
  if (!fs.existsSync(file)) fail(`No existe ${path.relative(root, file)}`);
}

const purchase = fs.readFileSync(purchasePath, "utf8");
const lifecycle = fs.readFileSync(lifecyclePath, "utf8");

const checks = [
  [purchase.includes('OPERATIONAL_RECURRING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"])'), "Falta set operativo en subscriptionPlanPurchase"],
  [purchase.includes("orderCreditItems(order).filter"), "La activación desde orden pagada no filtra servicios operativos"],
  [purchase.includes('reason: "SERVICE_RETIRED"'), "La reconciliación legacy no devuelve SERVICE_RETIRED"],
  [lifecycle.includes('OPERATIONAL_SUBSCRIPTION_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"])'), "Falta set operativo en subscriptionLifecycle"],
  [lifecycle.includes("isOperationalSubscriptionServiceKey(subscription.serviceKey)"), "ensureMonthlyCycleForSubscription no bloquea legacy"],
  [lifecycle.includes('serviceKey: { $in: [...OPERATIONAL_SUBSCRIPTION_SERVICE_KEYS] }'), "Los avisos previos de renovación todavía incluyen legacy"],
  [purchase.includes('const RECURRING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN", "NUT"])'), "Se perdió reconocimiento legacy necesario para historial"],
];

for (const [ok, message] of checks) {
  if (!ok) fail(message);
}

const operationalSetMatch = purchase.match(/OPERATIONAL_RECURRING_SERVICE_KEYS\s*=\s*new Set\(\[([^\]]+)\]\)/);
if (!operationalSetMatch) fail("No pude leer OPERATIONAL_RECURRING_SERVICE_KEYS");
const operationalSet = operationalSetMatch[1];
for (const retired of ["PE", "KD", "NUT"]) {
  if (operationalSet.includes(`"${retired}"`)) fail(`${retired} sigue dentro del set operativo`);
}

console.log("✅ Legacy subscription hardening OK: solo EP/RA/RF/SYN pueden activar y renovar suscripciones.");
console.log("✅ PE/KD/NUT siguen reconocibles como legacy, pero no generan nuevos ciclos, créditos ni avisos de renovación.");
console.log("✅ Test estático: no conecta MongoDB ni genera órdenes/ciclos.");
