// scripts/testPlanCoverageWiring.js
// SOLO LECTURA: valida el cableado crítico del historial de diferencias de Planes.
// No conecta a MongoDB y no modifica archivos.

import fs from "fs";

const files = {
  noticeModel: "src/models/SubscriptionExtraSessionNotice.js",
  extras: "src/services/subscriptions/subscriptionExtraSessions.js",
  adminPlans: "src/routes/adminPlans.js",
  appointments: "src/routes/appointments.js",
  orders: "src/routes/orders.js",
};

function read(file) {
  return fs.readFileSync(file, "utf8");
}

const noticeModel = read(files.noticeModel);
const extras = read(files.extras);
const adminPlans = read(files.adminPlans);
const appointments = read(files.appointments);
const orders = read(files.orders);

const checks = [
  {
    name: "El aviso conserva huella histórica de la diferencia",
    ok:
      noticeModel.includes("historicalExtraSessionsRequired") &&
      noticeModel.includes("historicalFixedOccurrences") &&
      noticeModel.includes("historicalBasePlanSessions"),
  },
  {
    name: "Turnos fijos completados siguen contando en el mes",
    ok:
      extras.includes('status: { $in: ["reserved", "completed"] }') &&
      extras.includes('occurrenceSource: "actual_current_month_appointments"'),
  },
  {
    name: "La diferencia pagada conserva órdenes exactas",
    ok:
      extras.includes("purchasedOrderIds") &&
      extras.includes("lastPaidOrder") &&
      extras.includes("applyExtraSessionsFromOrder"),
  },
  {
    name: "Cambios de turnos fijos refrescan la diferencia",
    ok:
      appointments.includes("refreshExtraSessionNoticeSafely") &&
      appointments.includes('source: "fixed_appointment_cancelled"') &&
      appointments.includes('source: "fixed_appointment_rescheduled"') &&
      appointments.includes('source: "fixed_schedule_deleted"'),
  },
  {
    name: "Admin Planes une bootstrap + avisos + órdenes",
    ok:
      adminPlans.includes("bootstrapExtraForSubscription") &&
      adminPlans.includes("buildExtraHistory") &&
      adminPlans.includes("paidOrders") &&
      adminPlans.includes("differenceSummary"),
  },
  {
    name: "Admin Planes expone estados históricos de pago",
    ok:
      adminPlans.includes('paymentState = "paid"') &&
      adminPlans.includes('paymentState = "partial"') &&
      adminPlans.includes('paymentState = "released"'),
  },
  {
    name: "Órdenes de Planes pagadas quedan protegidas",
    ok:
      orders.includes("ORDER_PROTECTED_BY_SUBSCRIPTION_HISTORY") &&
      orders.includes('itemKinds.has("SUBSCRIPTION_EXTRA")') &&
      orders.includes('itemKinds.has("SUBSCRIPTION_RENEWAL")'),
  },
  {
    name: "Órdenes bootstrap históricas quedan protegidas",
    ok:
      orders.includes('"bootstrap.latestPaidOrder.orderId"') &&
      orders.includes("referencedByBootstrap"),
  },
];

console.log("\nCABLEADO PLANES + DIFERENCIAS + ÓRDENES\n");
for (const check of checks) {
  console.log(`${check.ok ? "OK" : "FALTA"} · ${check.name}`);
}

const failed = checks.filter((check) => !check.ok);
console.log(
  "\n" +
    JSON.stringify(
      {
        checks: checks.length,
        ok: checks.length - failed.length,
        failed: failed.length,
      },
      null,
      2
    )
);

if (failed.length) process.exitCode = 2;
