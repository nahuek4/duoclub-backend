// scripts/patchAnyPaymentKeepsSubscriptionActive.mjs
// Aplica la regla:
// - si amountReceived/amountPaid/payments > 0 => NO suspender ni dar de baja;
// - solo se suspende / termina cuando NO ingresó ningún pago.
// - si estaba suspendido y aparece un pago parcial, el ledger lo reactiva.
//
// Este parche crea backup antes de modificar subscriptionLifecycle.js.

import fs from "fs";
import path from "path";

const target = path.resolve(
  process.cwd(),
  "src/services/subscriptions/subscriptionLifecycle.js"
);

if (!fs.existsSync(target)) {
  throw new Error(`No existe ${target}`);
}

let source = fs.readFileSync(target, "utf8");

if (source.includes("DUO_ANY_PAYMENT_KEEPS_ACTIVE_V1")) {
  console.log("subscriptionLifecycle.js ya tiene aplicado DUO_ANY_PAYMENT_KEEPS_ACTIVE_V1.");
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = `${target}.bak-any-payment-${stamp}`;
fs.copyFileSync(target, backup);

const oldHeader = `// - Día 11 impago: suspende SOLO el servicio. Conserva horarios fijos hasta día 20.
// - Día 21 impago: libera turnos fijos, invalida saldo del ciclo y termina la suscripción.
// - Pago antes del día 21: reactiva automáticamente si estaba suspendida.
`;

const newHeader = `// - Día 11 SIN NINGÚN PAGO: suspende SOLO el servicio. Conserva horarios fijos hasta día 20.
// - Día 21 SIN NINGÚN PAGO: libera turnos fijos, invalida saldo del ciclo y termina la suscripción.
// - Cualquier pago > 0 protege la cuenta: puede quedar saldo pendiente, pero el servicio sigue activo.
// - Un pago parcial reactiva automáticamente si estaba suspendida.
// DUO_ANY_PAYMENT_KEEPS_ACTIVE_V1
`;

if (!source.includes(oldHeader)) {
  throw new Error("No encontré el encabezado esperado del lifecycle.");
}
source = source.replace(oldHeader, newHeader);

const moneyAnchor = `function asMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}
`;

const moneyReplacement = `${moneyAnchor}
function cycleReceivedAmount(cycle) {
  const billing = cycle?.billing || {};

  const storedReceived = asMoney(billing.amountReceived);
  const storedPaid = asMoney(billing.amountPaid);

  const paymentEntries = Array.isArray(billing.payments)
    ? billing.payments
    : [];

  const fromEntries = paymentEntries.reduce(
    (sum, payment) => sum + asMoney(payment?.amount),
    0
  );

  return Math.max(storedReceived, storedPaid, fromEntries);
}

function cycleHasAnyPayment(cycle) {
  return cycleReceivedAmount(cycle) > 0;
}
`;

if (!source.includes(moneyAnchor)) {
  throw new Error("No encontré asMoney() esperado.");
}
source = source.replace(moneyAnchor, moneyReplacement);

const suspendNeedle = `        const subscription = await ServiceSubscription.findById(freshCycle.subscription).session(session);
        if (!subscription) return;

        freshCycle.billing.status = "overdue";
`;

const suspendReplacement = `        const subscription = await ServiceSubscription.findById(freshCycle.subscription).session(session);
        if (!subscription) return;

        // Si ingresó aunque sea un pago parcial, NO suspendimos el servicio.
        // El saldo puede seguir overdue, pero el acceso continúa activo.
        if (cycleHasAnyPayment(freshCycle)) {
          freshCycle.billing.status = "overdue";
          freshCycle.billing.overdueAt = freshCycle.billing.overdueAt || now;
          freshCycle.lifecycle.planStatus = "active";
          freshCycle.lifecycle.suspendedAt = null;

          if (subscription.status === "suspended") {
            subscription.status = "active";
            subscription.suspendedAt = null;
            subscription.suspensionReason = "";
          }

          await freshCycle.save({ session });
          await subscription.save({ session });

          await SubscriptionLifecycleNotice.updateMany(
            {
              user: subscription.user,
              subscription: subscription._id,
              periodKey,
              type: "suspended",
            },
            {
              $set: {
                status: "resolved",
                resolvedAt: now,
              },
            },
            { session }
          );

          return;
        }

        freshCycle.billing.status = "overdue";
`;

if (!source.includes(suspendNeedle)) {
  throw new Error("No encontré el bloque de suspensión esperado.");
}
source = source.replace(suspendNeedle, suspendReplacement);

const terminateNeedle = `        const subscription = await ServiceSubscription.findById(freshCycle.subscription).session(session);
        const user = subscription
          ? await User.findById(subscription.user).session(session)
          : null;
        if (!subscription || !user) return;

        invalidatedSessions += await invalidateCycleCredits({ freshCycle, cycle: freshCycle, user, now, session });
`;

const terminateReplacement = `        const subscription = await ServiceSubscription.findById(freshCycle.subscription).session(session);
        const user = subscription
          ? await User.findById(subscription.user).session(session)
          : null;
        if (!subscription || !user) return;

        // NUEVA REGLA: solo se da de baja si NO ingresó absolutamente nada.
        // Un pago parcial mantiene el servicio y los turnos fijos protegidos,
        // aunque todavía exista balanceDue.
        if (cycleHasAnyPayment(freshCycle)) {
          freshCycle.billing.status = "overdue";
          freshCycle.billing.overdueAt = freshCycle.billing.overdueAt || now;
          freshCycle.lifecycle.planStatus = "active";
          freshCycle.lifecycle.suspendedAt = null;
          freshCycle.lifecycle.terminatedAt = null;
          freshCycle.lifecycle.terminationReason = "";

          if (subscription.status === "suspended") {
            subscription.status = "active";
            subscription.suspendedAt = null;
            subscription.suspensionReason = "";
          }

          await freshCycle.save({ session });
          await subscription.save({ session });

          await SubscriptionLifecycleNotice.updateMany(
            {
              user: subscription.user,
              subscription: subscription._id,
              periodKey,
              type: "suspended",
            },
            {
              $set: {
                status: "resolved",
                resolvedAt: now,
              },
            },
            { session }
          );

          return;
        }

        invalidatedSessions += await invalidateCycleCredits({ freshCycle, cycle: freshCycle, user, now, session });
`;

if (!source.includes(terminateNeedle)) {
  throw new Error("No encontré el bloque de terminación esperado.");
}
source = source.replace(terminateNeedle, terminateReplacement);

fs.writeFileSync(target, source, "utf8");

console.log("OK: subscriptionLifecycle.js actualizado.");
console.log("Backup:", backup);
console.log("Archivo:", target);
