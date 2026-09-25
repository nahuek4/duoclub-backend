// scripts/auditSubscriptionPreventiveGuards.js
// SOLO LECTURA: valida que los blindajes críticos estén presentes en el código desplegado.

import fs from "fs";

const files = {
  planPurchase: "src/services/subscriptions/subscriptionPlanPurchase.js",
  lifecycle: "src/services/subscriptions/subscriptionLifecycle.js",
  ledger: "src/services/subscriptions/subscriptionBillingLedger.js",
  orders: "src/routes/orders.js",
  subscriptions: "src/routes/subscriptions.js",
  renewalHelpers: "src/services/subscriptions/subscriptionCyclePaymentHelpers.js",
};

function read(file) {
  return fs.readFileSync(file, "utf8");
}

const plan = read(files.planPurchase);
const lifecycle = read(files.lifecycle);
const ledger = read(files.ledger);
const orders = read(files.orders);
const subscriptions = read(files.subscriptions);
const renewalHelpers = read(files.renewalHelpers);

const checks = [
  {
    name: "Admin CREDITS no muta suscripción",
    ok:
      plan.includes("DUO_ADMIN_CREDITS_DO_NOT_MUTATE_SUBSCRIPTION_V1") &&
      plan.includes("ADMIN_OR_PUBLIC_ORDER_DOES_NOT_MUTATE_SUBSCRIPTION"),
  },
  {
    name: "Cualquier pago protege día 11/21",
    ok:
      lifecycle.includes("DUO_ANY_PAYMENT_KEEPS_ACTIVE_V2") &&
      lifecycle.includes("cycleHasAnyPayment") &&
      lifecycle.includes("keepSubscriptionActiveAfterAnyPayment"),
  },
  {
    name: "Pago parcial puede reactivar suspendida",
    ok: ledger.includes("reactivateSuspendedAfterAnyPayment"),
  },
  {
    name: "Renovaciones usan tipo explícito SUBSCRIPTION_RENEWAL",
    ok:
      renewalHelpers.includes('kind: "SUBSCRIPTION_RENEWAL"') &&
      subscriptions.includes("buildSubscriptionRenewalItem") &&
      subscriptions.includes("Order.create") &&
      orders.includes("getSubscriptionRenewalItems") &&
      orders.includes("subscriptionCycleApplied"),
  },
];

console.log("\\nBLINDAJE PREVENTIVO DE SUSCRIPCIONES\\n");

for (const check of checks) {
  console.log(`${check.ok ? "OK" : "FALTA"} · ${check.name}`);
}

const failed = checks.filter((x) => !x.ok);

console.log("\\n" + JSON.stringify({
  checks: checks.length,
  ok: checks.length - failed.length,
  failed: failed.length,
}, null, 2));

if (failed.length) process.exitCode = 2;
