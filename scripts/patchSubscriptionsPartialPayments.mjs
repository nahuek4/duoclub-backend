// scripts/patchSubscriptionsPartialPayments.mjs
// Parchea src/routes/subscriptions.js sobre la versión actual del backend DUO.
// Crea backup automático antes de escribir.
// Ejecutar una sola vez y luego validar con node --check.

import fs from "fs";
import path from "path";

const target = path.resolve(process.cwd(), "src/routes/subscriptions.js");

if (!fs.existsSync(target)) {
  throw new Error(`No existe ${target}`);
}

let source = fs.readFileSync(target, "utf8");

if (source.includes("DUO_PARTIAL_SUBSCRIPTION_PAYMENTS_V1")) {
  console.log("subscriptions.js ya tiene aplicado DUO_PARTIAL_SUBSCRIPTION_PAYMENTS_V1.");
  process.exit(0);
}

function replaceBetween(text, startMarker, endMarker, replacement) {
  const start = text.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`No se encontró marcador inicial: ${startMarker}`);
  }

  const end = text.indexOf(endMarker, start);
  if (end < 0) {
    throw new Error(`No se encontró marcador final: ${endMarker}`);
  }

  return (
    text.slice(0, start) +
    replacement +
    text.slice(end)
  );
}

const backup = `${target}.bak-partial-payments-${new Date()
  .toISOString()
  .replace(/[:.]/g, "-")}`;

fs.copyFileSync(target, backup);

/* =========================================================
   1) Helpers de saldo + serialización de ciclos
========================================================= */

const renewalResponseMarker = `function renewalOrderResponse(order) {
  return {
    orderId: String(order._id),
    status: order.status,
    payMethod: order.payMethod,
    amount: Number(order.totalFinal ?? order.total ?? 0),
    init_point: order.mpInitPoint || "",
  };
}
`;

if (!source.includes(renewalResponseMarker)) {
  throw new Error("No se encontró renewalOrderResponse esperado.");
}

const renewalResponseReplacement = `function renewalOrderResponse(order) {
  return {
    orderId: String(order._id),
    status: order.status,
    payMethod: order.payMethod,
    amount: Number(order.totalFinal ?? order.total ?? 0),
    init_point: order.mpInitPoint || "",
  };
}

// DUO_PARTIAL_SUBSCRIPTION_PAYMENTS_V1
function cycleBillingSummary(cycle = {}) {
  const total = Math.max(
    0,
    Math.round(Number(cycle?.billing?.total || 0))
  );

  const amountPaid = Math.min(
    total,
    Math.max(
      0,
      Math.round(
        Number(
          cycle?.billing?.amountPaid ??
            (cycle?.billing?.status === "paid" ? total : 0)
        )
      )
    )
  );

  const amountReceived = Math.max(
    amountPaid,
    Math.round(Number(cycle?.billing?.amountReceived || 0))
  );

  const balanceDue =
    cycle?.billing?.balanceDue !== null &&
    cycle?.billing?.balanceDue !== undefined
      ? Math.max(
          0,
          Math.round(Number(cycle.billing.balanceDue || 0))
        )
      : Math.max(0, total - amountPaid);

  const overpaidAmount = Math.max(
    0,
    Math.round(
      Number(
        cycle?.billing?.overpaidAmount ||
          Math.max(0, amountReceived - amountPaid)
      )
    )
  );

  return {
    total,
    amountReceived,
    amountPaid,
    balanceDue,
    overpaidAmount,
    paymentState:
      balanceDue <= 0
        ? "paid"
        : amountPaid > 0
          ? "partial"
          : String(cycle?.billing?.status || "pending"),
  };
}
`;

source = source.replace(
  renewalResponseMarker,
  renewalResponseReplacement
);

const oldCyclesMapStart = `    cycles: cycles.map((cycle) => ({`;
const oldCyclesMapEnd = `    })),
  };
}`;

const cyclesStart = source.indexOf(oldCyclesMapStart);
const cyclesEnd = source.indexOf(oldCyclesMapEnd, cyclesStart);

if (cyclesStart < 0 || cyclesEnd < 0) {
  throw new Error("No se encontró el bloque cycles de serializeSubscription.");
}

const newCyclesBlock = `    cycles: cycles.map((cycle) => {
      const billing = cycleBillingSummary(cycle);

      return {
        id: String(cycle._id),
        periodKey: cycle.periodKey,
        billingStatus: cycle.billing?.status,
        paymentState: billing.paymentState,
        amount: billing.total,
        amountReceived: billing.amountReceived,
        amountPaid: billing.amountPaid,
        balanceDue: billing.balanceDue,
        overpaidAmount: billing.overpaidAmount,
        dueAt: cycle.billing?.dueAt || null,
        paidAt: cycle.billing?.paidAt || null,
        planStatus: cycle.lifecycle?.planStatus,
        sessions: cycle.planSnapshot?.monthlySessions || 0,
        creditsGranted: !!cycle.creditGrant?.granted,
        payments: (Array.isArray(cycle.billing?.payments)
          ? cycle.billing.payments
          : []
        ).map((payment) => ({
          id: String(payment?._id || ""),
          orderId: payment?.order ? String(payment.order) : null,
          amount: Number(payment?.amount || 0),
          appliedAmount: Number(payment?.appliedAmount || 0),
          excessAmount: Number(payment?.excessAmount || 0),
          paidAt: payment?.paidAt || null,
          paymentProvider: payment?.paymentProvider || "",
          paymentId: payment?.paymentId || "",
          note: payment?.note || "",
        })),
      };
    }),
  };
}`;

source =
  source.slice(0, cyclesStart) +
  newCyclesBlock +
  source.slice(cyclesEnd + oldCyclesMapEnd.length);

/* =========================================================
   2) Reemplazar pago de ciclo para aceptar monto parcial
========================================================= */

const payStartMarker = `router.post("/cycles/:cycleId/pay", async (req, res) => {`;
const payEndMarker = `/* ============================================
   CAMBIOS PEDIDOS POR EL USUARIO
============================================ */`;

const newPayRoute = `router.post("/cycles/:cycleId/pay", async (req, res) => {
  try {
    const uid = userId(req);

    let cycle = await SubscriptionBillingCycle.findOne({
      _id: req.params.cycleId,
      user: uid,
    });

    if (!cycle) {
      return res.status(404).json({
        error: "Ciclo mensual no encontrado.",
      });
    }

    let billing = cycleBillingSummary(cycle);

    if (
      cycle.billing?.status === "paid" ||
      billing.balanceDue <= 0
    ) {
      return res.json({
        ok: true,
        alreadyPaid: true,
        cycleId: String(cycle._id),
        billingStatus: "paid",
        ...billing,
      });
    }

    if (
      !["pending", "overdue"].includes(
        String(cycle.billing?.status || "")
      )
    ) {
      return res.status(400).json({
        error: "Este ciclo no admite pagos en su estado actual.",
      });
    }

    const subscription = await ServiceSubscription.findOne({
      _id: cycle.subscription,
      user: uid,
    });

    if (!subscription) {
      return res.status(404).json({
        error: "Suscripción no encontrada.",
      });
    }

    const expectedMethod = String(
      cycle.planSnapshot?.payMethod ||
        subscription.payMethod ||
        "CASH"
    )
      .toUpperCase()
      .trim();

    const requestedMethod = String(
      req.body?.payMethod || expectedMethod
    )
      .toUpperCase()
      .trim();

    if (requestedMethod !== expectedMethod) {
      return res.status(400).json({
        error: \`Este plan se renueva mediante \${
          expectedMethod === "MP"
            ? "Mercado Pago"
            : "efectivo/transferencia"
        }. Para cambiar el medio de pago, modificá el plan del próximo período.\`,
      });
    }

    const hasExplicitAmount =
      req.body?.amount !== null &&
      req.body?.amount !== undefined &&
      req.body?.amount !== "";

    const requestedAmount = hasExplicitAmount
      ? Math.round(Number(req.body.amount))
      : billing.balanceDue;

    if (
      !Number.isFinite(requestedAmount) ||
      requestedAmount <= 0
    ) {
      return res.status(400).json({
        error: "Ingresá un importe válido.",
      });
    }

    // Desde Mi Plan nunca cobramos más del saldo pendiente.
    // Los sobrepagos solo pueden registrarse de forma manual por admin.
    if (requestedAmount > billing.balanceDue) {
      return res.status(400).json({
        error: \`El saldo pendiente es de \$\${billing.balanceDue}.\`,
        balanceDue: billing.balanceDue,
      });
    }

    if (cycle.billing?.order) {
      const existingOrder = await Order.findById(
        cycle.billing.order
      );

      if (existingOrder) {
        const status = String(
          existingOrder.status || ""
        ).toLowerCase();

        if (status === "paid" || status === "approved") {
          if (!existingOrder.subscriptionCycleApplied) {
            await applySubscriptionRenewalFromOrder({
              order: existingOrder,
              paymentProvider: existingOrder.payMethod,
              paymentId: existingOrder.mpPaymentId || "",
              paidAt: existingOrder.paidAt || new Date(),
            });

            existingOrder.subscriptionCycleApplied = true;
            existingOrder.applied = true;
            await existingOrder.save();
          }

          cycle = await SubscriptionBillingCycle.findById(
            cycle._id
          );
          billing = cycleBillingSummary(cycle);

          if (
            cycle.billing?.status === "paid" ||
            billing.balanceDue <= 0
          ) {
            return res.json({
              ok: true,
              alreadyPaid: true,
              ...renewalOrderResponse(existingOrder),
              cycleId: String(cycle._id),
              billingStatus: cycle.billing?.status,
              ...billing,
            });
          }

          // Fue un pago parcial ya aplicado. El ledger libera normalmente
          // este puntero, pero limpiamos también ciclos legacy.
          if (
            String(cycle.billing?.order || "") ===
            String(existingOrder._id)
          ) {
            cycle.billing.order = null;
            await cycle.save();
          }
        } else if (status === "pending") {
          const existingAmount = Math.round(
            Number(
              existingOrder.totalFinal ??
                existingOrder.total ??
                0
            )
          );

          if (existingAmount !== requestedAmount) {
            return res.status(409).json({
              error:
                "Ya existe una orden pendiente para este ciclo. Completala o cancelala antes de generar otro importe.",
              existingOrder: renewalOrderResponse(
                existingOrder
              ),
              balanceDue: billing.balanceDue,
            });
          }

          if (
            expectedMethod === "MP" &&
            !existingOrder.mpInitPoint
          ) {
            const user = await User.findById(uid).lean();

            const mp = await createMpPreferenceForRenewal({
              order: existingOrder,
              user,
              cycle,
            });

            existingOrder.mpPreferenceId =
              mp.preferenceId;
            existingOrder.mpInitPoint = mp.initPoint;
            await existingOrder.save();
          }

          return res.json({
            ok: true,
            reused: true,
            balanceDue: billing.balanceDue,
            ...renewalOrderResponse(existingOrder),
          });
        } else {
          cycle.billing.order = null;
          await cycle.save();
        }
      } else {
        cycle.billing.order = null;
        await cycle.save();
      }
    }

    const item = buildSubscriptionRenewalItem({
      cycle,
      subscription,
      amount: requestedAmount,
    });

    const order = await Order.create({
      user: uid,
      payMethod: expectedMethod,
      items: [item],
      totalBase: requestedAmount,
      total: requestedAmount,
      totalFinal: requestedAmount,
      status: "pending",
      applied: false,
      creditsApplied: false,
      subscriptionExtraApplied: false,
      subscriptionCycleApplied: false,
      suppressUserEmails: true,
      notes: \`Pago \${
        requestedAmount < billing.balanceDue
          ? "parcial"
          : "final"
      } del plan \${cycle.serviceKey} \${cycle.periodKey}. Las sesiones ya fueron acreditadas por el ciclo; esta orden solo registra el cobro.\`,
    });

    cycle.billing.order = order._id;
    await cycle.save();

    if (expectedMethod === "MP") {
      try {
        const user = await User.findById(uid).lean();

        const mp = await createMpPreferenceForRenewal({
          order,
          user,
          cycle,
        });

        order.mpPreferenceId = mp.preferenceId;
        order.mpInitPoint = mp.initPoint;
        await order.save();
      } catch (error) {
        order.status = "cancelled";
        order.notes = \`\${order.notes}\\nNo se pudo generar Mercado Pago: \${
          error?.message || error
        }\`;
        await order.save();

        cycle.billing.order = null;
        await cycle.save();

        throw error;
      }
    }

    return res.status(201).json({
      ok: true,
      cycleId: String(cycle._id),
      balanceBefore: billing.balanceDue,
      requestedAmount,
      estimatedBalanceAfter: Math.max(
        0,
        billing.balanceDue - requestedAmount
      ),
      ...renewalOrderResponse(order),
    });
  } catch (error) {
    console.error(
      "POST /subscriptions/cycles/:cycleId/pay",
      error
    );

    return res.status(500).json({
      error:
        error?.message ||
        "No se pudo generar el pago mensual.",
    });
  }
});

/* ============================================
   ADMIN: REGISTRAR PAGO PARCIAL / TOTAL
   Crea una Order de cobro. NO acredita sesiones.
============================================ */
router.post(
  "/admin/cycles/:cycleId/payment",
  ensureMonthlyPlanStaff,
  async (req, res) => {
    try {
      const cycle = await SubscriptionBillingCycle.findById(
        req.params.cycleId
      );

      if (!cycle) {
        return res.status(404).json({
          error: "Ciclo mensual no encontrado.",
        });
      }

      if (
        !["pending", "overdue"].includes(
          String(cycle.billing?.status || "")
        )
      ) {
        return res.status(400).json({
          error:
            "El ciclo no admite nuevos pagos en su estado actual.",
        });
      }

      const subscription =
        await ServiceSubscription.findById(
          cycle.subscription
        );

      if (!subscription) {
        return res.status(404).json({
          error: "Suscripción no encontrada.",
        });
      }

      const amount = Math.round(Number(req.body?.amount));

      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
          error: "Ingresá un importe mayor a 0.",
        });
      }

      const payMethod = String(
        req.body?.payMethod ||
          cycle.planSnapshot?.payMethod ||
          subscription.payMethod ||
          "CASH"
      )
        .toUpperCase()
        .trim();

      if (!["CASH", "MP"].includes(payMethod)) {
        return res.status(400).json({
          error: "Medio de pago inválido.",
        });
      }

      const before = cycleBillingSummary(cycle);

      const item = buildSubscriptionRenewalItem({
        cycle,
        subscription,
        amount,
      });

      const paidAt = req.body?.paidAt
        ? new Date(req.body.paidAt)
        : new Date();

      if (Number.isNaN(paidAt.getTime())) {
        return res.status(400).json({
          error: "Fecha de pago inválida.",
        });
      }

      const order = await Order.create({
        user: cycle.user,
        payMethod,
        items: [item],
        totalBase: amount,
        total: amount,
        totalFinal: amount,
        status: "paid",
        paidAt,
        applied: false,
        creditsApplied: false,
        subscriptionExtraApplied: false,
        subscriptionCycleApplied: false,
        suppressUserEmails: true,
        createdByAdmin: true,
        createdByAdminId:
          req.user?._id || req.user?.id || null,
        notes:
          String(req.body?.notes || "").trim() ||
          \`Pago manual del plan \${cycle.serviceKey} \${cycle.periodKey}.\`,
      });

      cycle.billing.order = order._id;
      await cycle.save();

      const applied =
        await applySubscriptionRenewalFromOrder({
          order,
          paymentProvider: payMethod,
          paymentId: "",
          paidAt,
        });

      order.subscriptionCycleApplied = true;
      order.applied = true;
      await order.save();

      const freshCycle =
        await SubscriptionBillingCycle.findById(cycle._id);

      const after = cycleBillingSummary(freshCycle);

      return res.status(201).json({
        ok: true,
        orderId: String(order._id),
        cycleId: String(cycle._id),
        serviceKey: cycle.serviceKey,
        periodKey: cycle.periodKey,
        paymentAmount: amount,
        appliedAmount:
          applied?.cycles?.[0]?.appliedAmount || 0,
        excessAmount:
          applied?.cycles?.[0]?.excessAmount || 0,
        before,
        after,
      });
    } catch (error) {
      console.error(
        "POST /subscriptions/admin/cycles/:cycleId/payment",
        error
      );

      return res.status(500).json({
        error:
          error?.message ||
          "No se pudo registrar el pago del plan.",
      });
    }
  }
);

`;

source = replaceBetween(
  source,
  payStartMarker,
  payEndMarker,
  newPayRoute
);

fs.writeFileSync(target, source, "utf8");

console.log("OK: subscriptions.js actualizado.");
console.log("Backup:", backup);
console.log("Archivo:", target);
