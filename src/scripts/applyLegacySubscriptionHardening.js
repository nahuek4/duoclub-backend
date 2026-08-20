import fs from "fs";
import path from "path";

const root = process.cwd();
const targets = {
  purchase: path.join(root, "src/services/subscriptions/subscriptionPlanPurchase.js"),
  lifecycle: path.join(root, "src/services/subscriptions/subscriptionLifecycle.js"),
};

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function read(file) {
  if (!fs.existsSync(file)) fail(`No existe ${path.relative(root, file)}`);
  return fs.readFileSync(file, "utf8");
}

function backup(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = `${file}.bak-legacy-subscription-${stamp}`;
  fs.copyFileSync(file, out);
  return out;
}

function replaceRequired(source, from, to, label) {
  if (source.includes(to)) return source;
  if (!source.includes(from)) fail(`No encontré el bloque esperado: ${label}. No se modificó ningún archivo de forma parcial.`);
  return source.replace(from, to);
}

function patchPurchase(source) {
  source = replaceRequired(
    source,
    'const RECURRING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN", "NUT"]);\n',
    'const RECURRING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN", "NUT"]);\nconst OPERATIONAL_RECURRING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);\n',
    "set operativo en subscriptionPlanPurchase"
  );

  source = replaceRequired(
    source,
    `function normalizeServiceKey(value) {\n  const raw = clean(value).toUpperCase();\n  if (raw === "AR") return "RA";\n  if (raw === "KINEDEPO" || raw === "KINE-DEPO") return "KD";\n  return RECURRING_SERVICE_KEYS.has(raw) ? raw : "";\n}\n`,
    `function normalizeServiceKey(value) {\n  const raw = clean(value).toUpperCase();\n  if (raw === "AR") return "RA";\n  if (raw === "KINEDEPO" || raw === "KINE-DEPO") return "KD";\n  return RECURRING_SERVICE_KEYS.has(raw) ? raw : "";\n}\n\nfunction isOperationalRecurringServiceKey(value) {\n  const key = normalizeServiceKey(value);\n  return Boolean(key && OPERATIONAL_RECURRING_SERVICE_KEYS.has(key));\n}\n`,
    "helper operativo en subscriptionPlanPurchase"
  );

  source = replaceRequired(
    source,
    `  const payMethod = clean(order?.payMethod).toUpperCase();\n  const items = orderCreditItems(order);\n  const activated = [];\n`,
    `  const payMethod = clean(order?.payMethod).toUpperCase();\n  const items = orderCreditItems(order).filter((item) =>\n    isOperationalRecurringServiceKey(item?.serviceKey)\n  );\n  const activated = [];\n`,
    "filtro de activación de suscripciones"
  );

  source = replaceRequired(
    source,
    `  const sk = normalizeServiceKey(serviceKey);\n  if (!mongoose.Types.ObjectId.isValid(clean(userId)) || !sk) {\n    return { ok: false, error: "INVALID_USER_OR_SERVICE" };\n  }\n`,
    `  const sk = normalizeServiceKey(serviceKey);\n  if (!mongoose.Types.ObjectId.isValid(clean(userId)) || !sk) {\n    return { ok: false, error: "INVALID_USER_OR_SERVICE" };\n  }\n\n  if (!isOperationalRecurringServiceKey(sk)) {\n    return {\n      ok: true,\n      skipped: true,\n      reason: "SERVICE_RETIRED",\n      serviceKey: sk,\n    };\n  }\n`,
    "bloqueo de reconciliación legacy"
  );

  return source;
}

function patchLifecycle(source) {
  source = replaceRequired(
    source,
    'const RENEWABLE_STATUSES = ["active", "pending_change"];\n',
    'const RENEWABLE_STATUSES = ["active", "pending_change"];\nconst OPERATIONAL_SUBSCRIPTION_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);\n',
    "set operativo en subscriptionLifecycle"
  );

  source = replaceRequired(
    source,
    `function clean(value) {\n  return String(value || "").trim();\n}\n`,
    `function clean(value) {\n  return String(value || "").trim();\n}\n\nfunction isOperationalSubscriptionServiceKey(value) {\n  return OPERATIONAL_SUBSCRIPTION_SERVICE_KEYS.has(clean(value).toUpperCase());\n}\n`,
    "helper operativo en subscriptionLifecycle"
  );

  source = replaceRequired(
    source,
    `      if (!subscription) {\n        result = { ok: false, skipped: true, reason: "SUBSCRIPTION_NOT_FOUND" };\n        return;\n      }\n\n      if (!subscription.autoRenew || !RENEWABLE_STATUSES.includes(subscription.status)) {\n`,
    `      if (!subscription) {\n        result = { ok: false, skipped: true, reason: "SUBSCRIPTION_NOT_FOUND" };\n        return;\n      }\n\n      if (!isOperationalSubscriptionServiceKey(subscription.serviceKey)) {\n        result = {\n          ok: true,\n          skipped: true,\n          reason: "SERVICE_RETIRED",\n          subscriptionId: String(subscription._id),\n          serviceKey: clean(subscription.serviceKey).toUpperCase(),\n        };\n        return;\n      }\n\n      if (!subscription.autoRenew || !RENEWABLE_STATUSES.includes(subscription.status)) {\n`,
    "bloqueo de ciclo mensual legacy"
  );

  source = replaceRequired(
    source,
    `  const subscriptions = await ServiceSubscription.find({\n    autoRenew: true,\n    status: { $in: RENEWABLE_STATUSES },\n  }).lean();\n`,
    `  const subscriptions = await ServiceSubscription.find({\n    autoRenew: true,\n    status: { $in: RENEWABLE_STATUSES },\n    serviceKey: { $in: [...OPERATIONAL_SUBSCRIPTION_SERVICE_KEYS] },\n  }).lean();\n`,
    "filtro de avisos previos de renovación"
  );

  return source;
}

const purchaseOriginal = read(targets.purchase);
const lifecycleOriginal = read(targets.lifecycle);
const purchasePatched = patchPurchase(purchaseOriginal);
const lifecyclePatched = patchLifecycle(lifecycleOriginal);

if (purchasePatched === purchaseOriginal && lifecyclePatched === lifecycleOriginal) {
  console.log("✅ Legacy subscription hardening ya estaba aplicado. No hubo cambios.");
  process.exit(0);
}

const backups = [];
try {
  if (purchasePatched !== purchaseOriginal) backups.push(backup(targets.purchase));
  if (lifecyclePatched !== lifecycleOriginal) backups.push(backup(targets.lifecycle));

  fs.writeFileSync(targets.purchase, purchasePatched, "utf8");
  fs.writeFileSync(targets.lifecycle, lifecyclePatched, "utf8");
} catch (error) {
  console.error(error);
  fail("No se pudieron escribir los archivos.");
}

console.log("✅ Legacy subscription hardening aplicado.");
console.log("   Operativos: EP / RA / RF / SYN");
console.log("   Legacy solo histórico: PE / KD / NUT");
console.log("   MongoDB: no se modificó");
for (const file of backups) {
  console.log(`   Backup: ${path.relative(root, file)}`);
}
