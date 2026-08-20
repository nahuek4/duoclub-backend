import fs from "fs";
import path from "path";

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const orders = read("src/routes/orders.js");
const pricing = read("src/routes/pricing.js");
const extras = read("src/services/subscriptions/subscriptionExtraSessions.js");

const errors = [];
const ok = (condition, msg) => { if (!condition) errors.push(msg); };

ok(orders.includes('const OPERATIONAL_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);'), "orders: falta set operativo");
ok(orders.includes('const LEGACY_SERVICE_KEYS = new Set(["PE", "EP", "RA", "RF", "KD", "SYN", "NUT"]);'), "orders: falta parser legacy");
ok(orders.includes('const PERFORMANCE_COPAY_KEYS = new Set(["RA", "RF", "SYN"]);'), "orders: KD sigue en copago Performance");
ok(orders.includes("normalizeOperationalServiceKey(serviceKey)"), "orders: checkout CREDITS no está blindado");
ok(orders.includes('assertOperationalServiceKey(req.body?.serviceKey, "serviceKey")'), "orders: altas admin no están blindadas");
ok(orders.includes("SERVICE_RETIRED_PUBLIC_EVALUATION"), "orders: evaluación pública PE sigue habilitada");

ok(pricing.includes('const OPERATIONAL_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);'), "pricing: falta set operativo");
ok(pricing.includes("normalizeOperationalServiceKey(serviceKey)"), "pricing: upsert permite servicios retirados");
ok(pricing.includes('serviceKey: { $in: [...OPERATIONAL_SERVICE_KEYS] }'), "pricing: GET activo no filtra servicios operativos");
ok(!pricing.includes("ensureKDPricingPlans"), "pricing: todavía existe auto-seed KD");
ok(!pricing.includes("ensurePEEvaluationVariantPlans"), "pricing: todavía existe auto-seed PE");
ok(!pricing.includes("AUTO-SEED KD PRICING"), "pricing: quedó bloque legacy de auto-seed KD");

ok(extras.includes('const OPERATIONAL_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);'), "extras: falta set operativo");
ok(extras.includes('reason: "RETIRED_SERVICE"'), "extras: no se omiten avisos de servicios retirados");
ok(extras.includes("RETIRED_SERVICE_EXTRA_SESSIONS"), "extras: checkout extra no bloquea servicios retirados");
ok(extras.includes("if (!isOperationalServiceKey(notice.serviceKey)) return null;"), "extras: avisos legacy todavía pueden mostrarse al usuario");

for (const retired of ["PE", "KD", "NUT"]) {
  ok(!orders.includes(`OPERATIONAL_SERVICE_KEYS = new Set(["${retired}"`), `orders: ${retired} figura como operativo`);
}

if (errors.length) {
  console.error("❌ Operational purchase hardening FALLÓ:");
  for (const e of errors) console.error(`- ${e}`);
  process.exit(1);
}

console.log("✅ Operational purchase hardening OK: nuevas compras solo EP/RA/RF/SYN; PE/KD/NUT quedan legacy; pricing activo y extras también blindados.");
console.log("✅ Test estático: no conecta MongoDB ni genera órdenes/pagos.");
