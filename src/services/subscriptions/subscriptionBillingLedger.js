import mongoose from "mongoose";

import ServiceSubscription from "../../models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../../models/SubscriptionBillingCycle.js";
import SubscriptionLifecycleNotice from "../../models/SubscriptionLifecycleNotice.js";
import { markSubscriptionCyclePaid } from "./subscriptionLifecycle.js";

function clean(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function idOf(value) {
  return clean(value?._id || value?.id || value);
}

function currentAppliedAmount(cycle) {
  const stored = money(cycle?.billing?.amountPaid);
  const payments = Array.isArray(cycle?.billing?.payments)
    ? cycle.billing.payments
    : [];

  const fromPayments = payments.reduce(
    (sum, payment) => sum + money(payment?.appliedAmount),
    0
  );

  if (cycle?.billing?.status === "paid") {
    return Math.max(money(cycle?.billing?.total), stored, fromPayments);
  }

  return Math.max(stored, fromPayments);
}

function currentReceivedAmount(cycle) {
  const stored = money(cycle?.billing?.amountReceived);
  const payments = Array.isArray(cycle?.billing?.payments)
    ? cycle.billing.payments
    : [];

  const fromPayments = payments.reduce(
    (sum, payment) => sum + money(payment?.amount),
    0
  );

  return Math.max(stored, fromPayments);
}

function summarize(cycle) {
  const total = money(cycle?.billing?.total);
  const amountPaid = Math.min(total, currentAppliedAmount(cycle));
  const amountReceived = currentReceivedAmount(cycle);
  const balanceDue = Math.max(0, total - amountPaid);
  const overpaidAmount = Math.max(
    money(cycle?.billing?.overpaidAmount),
    Math.max(0, amountReceived - amountPaid)
  );

  return {
    total,
    amountReceived,
    amountPaid,
    balanceDue,
    overpaidAmount,
    paidInFull: balanceDue <= 0,
    paymentState:
      balanceDue <= 0
        ? "paid"
        : amountPaid > 0
          ? "partial"
          : clean(cycle?.billing?.status || "pending"),
  };
}

function existingPayment(cycle, { orderId = null, paymentId = "" } = {}) {
  const orderKey = idOf(orderId);
  const providerPaymentId = clean(paymentId);

  return (Array.isArray(cycle?.billing?.payments)
    ? cycle.billing.payments
    : []
  ).find((payment) => {
    if (orderKey && idOf(payment?.order) === orderKey) return true;
    if (
      providerPaymentId &&
      clean(payment?.paymentId) &&
      clean(payment.paymentId) === providerPaymentId
    ) {
      return true;
    }
    return false;
  });
}

async function reactivateSuspendedAfterAnyPayment({
  cycle,
  paidAt = new Date(),
  session = null,
} = {}) {
  const subscriptionQuery = ServiceSubscription.findById(cycle.subscription);
  if (session) subscriptionQuery.session(session);

  const subscription = await subscriptionQuery;
  if (!subscription) throw new Error("SUBSCRIPTION_NOT_FOUND");

  // Si ya fue dada de baja al día 21, no restauramos automáticamente horarios
  // porque el lugar podría haber sido ocupado. Esa situación requiere una
  // recuperación controlada con validación de capacidad.
  if (
    subscription.status === "terminated_for_non_payment" ||
    cycle.lifecycle?.planStatus === "terminated"
  ) {
    return {
      reactivated: false,
      requiresManualReactivation: true,
      subscriptionStatus: subscription.status,
    };
  }

  const wasSuspended =
    subscription.status === "suspended" ||
    cycle.lifecycle?.planStatus === "suspended";

  // Cualquier pago > 0 protege el acceso del ciclo.
  cycle.lifecycle.planStatus = "active";
  cycle.lifecycle.suspendedAt = null;
  cycle.lifecycle.fixedSlotsProtectedUntil = null;

  if (subscription.status === "suspended") {
    subscription.status = "active";
    subscription.suspendedAt = null;
    subscription.suspensionReason = "";
  }

  subscription.fixedSlotsProtectedUntil = null;

  await subscription.save({ session: session || undefined });

  if (wasSuspended) {
    const options = session ? { session } : undefined;
    await SubscriptionLifecycleNotice.updateMany(
      {
        user: subscription.user,
        subscription: subscription._id,
        periodKey: cycle.periodKey,
        type: "suspended",
      },
      {
        $set: {
          status: "resolved",
          resolvedAt: paidAt,
        },
      },
      options
    );
  }

  return {
    reactivated: wasSuspended,
    requiresManualReactivation: false,
    subscriptionStatus: subscription.status,
  };
}

async function applySubscriptionCyclePaymentCore({
  cycleId,
  amount,
  paymentProvider = "",
  paymentId = "",
  orderId = null,
  paidAt = new Date(),
  note = "",
  session = null,
} = {}) {
  const paymentAmount = money(amount);
  if (!(paymentAmount > 0)) {
    throw new Error("SUBSCRIPTION_PAYMENT_AMOUNT_INVALID");
  }

  const cycleQuery = SubscriptionBillingCycle.findById(cycleId);
  if (session) cycleQuery.session(session);

  const cycle = await cycleQuery;
  if (!cycle) throw new Error("SUBSCRIPTION_CYCLE_NOT_FOUND");

  const duplicate = existingPayment(cycle, { orderId, paymentId });
  if (duplicate) {
    const totals = summarize(cycle);
    return {
      ok: true,
      alreadyApplied: true,
      cycleId: String(cycle._id),
      subscriptionId: String(cycle.subscription),
      periodKey: cycle.periodKey,
      paymentId: idOf(duplicate),
      appliedAmount: money(duplicate?.appliedAmount),
      excessAmount: money(duplicate?.excessAmount),
      ...totals,
    };
  }

  const before = summarize(cycle);
  const appliedAmount = Math.min(paymentAmount, before.balanceDue);
  const excessAmount = Math.max(0, paymentAmount - appliedAmount);

  cycle.billing.payments = Array.isArray(cycle.billing.payments)
    ? cycle.billing.payments
    : [];

  cycle.billing.payments.push({
    order: orderId || null,
    amount: paymentAmount,
    appliedAmount,
    excessAmount,
    paidAt,
    paymentProvider: clean(paymentProvider),
    paymentId: clean(paymentId),
    note: clean(note),
  });

  cycle.billing.amountReceived = before.amountReceived + paymentAmount;
  cycle.billing.amountPaid = before.amountPaid + appliedAmount;
  cycle.billing.balanceDue = Math.max(
    0,
    before.total - cycle.billing.amountPaid
  );
  cycle.billing.overpaidAmount =
    before.overpaidAmount + excessAmount;

  cycle.billing.paymentProvider = clean(paymentProvider);
  cycle.billing.paymentId = clean(paymentId);

  // NUEVA REGLA DUO:
  // Cualquier pago > 0 mantiene habilitado el servicio aunque todavía quede
  // saldo pendiente. El ciclo sigue pending/overdue para mostrar lo adeudado,
  // pero NO debe suspenderse ni darse de baja por falta de pago total.
  //
  // Si estaba suspendido por haber llegado al día 11 sin pagar y luego ingresa
  // un pago parcial, lo reactivamos inmediatamente.
  if (cycle.billing.balanceDue > 0) {
    if (
      orderId &&
      String(cycle.billing.order || "") === String(orderId)
    ) {
      cycle.billing.order = null;
    }

    const accessResult = await reactivateSuspendedAfterAnyPayment({
      cycle,
      paidAt,
      session,
    });

    await cycle.save({ session: session || undefined });

    return {
      ok: true,
      alreadyApplied: false,
      paidInFull: false,
      reactivated: Boolean(accessResult?.reactivated),
      requiresManualReactivation: Boolean(
        accessResult?.requiresManualReactivation
      ),
      cycleId: String(cycle._id),
      subscriptionId: String(cycle.subscription),
      periodKey: cycle.periodKey,
      paymentAmount,
      appliedAmount,
      excessAmount,
      ...summarize(cycle),
    };
  }

  // Persistimos primero el detalle del pago. Luego reutilizamos la lógica
  // histórica de cierre del ciclo para resolver avisos y reactivar una
  // suscripción suspendida (pero no una ya terminada al día 21).
  await cycle.save({ session: session || undefined });

  const paidResult = await markSubscriptionCyclePaid({
    cycleId: cycle._id,
    paymentProvider,
    paymentId,
    orderId,
    paidAt,
    session,
  });

  const freshQuery = SubscriptionBillingCycle.findById(cycle._id);
  if (session) freshQuery.session(session);
  const freshCycle = await freshQuery;

  return {
    ok: true,
    alreadyApplied: false,
    paidInFull: true,
    paymentAmount,
    appliedAmount,
    excessAmount,
    reactivated: Boolean(paidResult?.reactivated),
    cycleId: String(cycle._id),
    subscriptionId: String(cycle.subscription),
    periodKey: cycle.periodKey,
    ...summarize(freshCycle || cycle),
  };
}

export async function applySubscriptionCyclePayment({
  cycleId,
  amount,
  paymentProvider = "",
  paymentId = "",
  orderId = null,
  paidAt = new Date(),
  note = "",
  session = null,
} = {}) {
  if (session) {
    return applySubscriptionCyclePaymentCore({
      cycleId,
      amount,
      paymentProvider,
      paymentId,
      orderId,
      paidAt,
      note,
      session,
    });
  }

  const ownedSession = await mongoose.startSession();
  let output = null;

  try {
    await ownedSession.withTransaction(async () => {
      output = await applySubscriptionCyclePaymentCore({
        cycleId,
        amount,
        paymentProvider,
        paymentId,
        orderId,
        paidAt,
        note,
        session: ownedSession,
      });
    });

    return output;
  } finally {
    await ownedSession.endSession();
  }
}

export async function getSubscriptionCycleBalance(cycleId) {
  const cycle = await SubscriptionBillingCycle.findById(cycleId).lean();
  if (!cycle) throw new Error("SUBSCRIPTION_CYCLE_NOT_FOUND");
  return {
    cycleId: String(cycle._id),
    subscriptionId: String(cycle.subscription),
    periodKey: cycle.periodKey,
    billingStatus: cycle.billing?.status || "pending",
    ...summarize(cycle),
  };
}

export function subscriptionCycleBillingSummary(cycle = {}) {
  return summarize(cycle);
}
