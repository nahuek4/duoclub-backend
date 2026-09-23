// backend/src/routes/subscriptions.js
import express from "express";

import PricingPlan from "../models/PricingPlan.js";
import Order from "../models/Order.js";
import User from "../models/User.js";
import FixedSchedule from "../models/FixedSchedule.js";
import ServiceSubscription from "../models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../models/SubscriptionBillingCycle.js";
import SubscriptionLifecycleNotice from "../models/SubscriptionLifecycleNotice.js";
import { protect } from "../middleware/auth.js";
import {
  addMonthsToMonthKey,
  monthKeyFromDateArgentina,
} from "../services/subscriptions/subscriptionLifecycle.js";
import {
  buildSubscriptionRenewalItem,
  applySubscriptionRenewalFromOrder,
} from "../services/subscriptions/subscriptionCyclePayments.js";
import {
  listExtraSessionNoticesForUser,
  syncExtraSessionNoticeForUserService,
} from "../services/subscriptions/subscriptionExtraSessions.js";
import {
  ensureServiceCatalogLoaded,
  isServiceEnabledFor,
  normalizeCatalogServiceKey,
  serviceNameForKey,
} from "../services/serviceCatalogRuntime.js";

const router = express.Router();
router.use(protect);
router.use(async (req, res, next) => {
  await ensureServiceCatalogLoaded();
  next();
});

function userId(req) {
  return String(req.user?._id || req.user?.id || "");
}

function clean(value) {
  return String(value ?? "").trim();
}

function money(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}

function cycleBillingSummary(cycle = null) {
  if (!cycle) {
    return {
      total: 0,
      amountReceived: 0,
      amountPaid: 0,
      balanceDue: 0,
      overpaidAmount: 0,
      paymentState: "none",
    };
  }

  const total = money(cycle?.billing?.total);
  const payments = Array.isArray(cycle?.billing?.payments)
    ? cycle.billing.payments
    : [];

  const fromReceivedEntries = payments.reduce(
    (sum, payment) => sum + money(payment?.amount),
    0
  );

  const fromAppliedEntries = payments.reduce(
    (sum, payment) => sum + money(payment?.appliedAmount),
    0
  );

  const amountReceived = Math.max(
    money(cycle?.billing?.amountReceived),
    fromReceivedEntries
  );

  const amountPaid = Math.min(
    total,
    Math.max(money(cycle?.billing?.amountPaid), fromAppliedEntries)
  );

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
    paymentState:
      balanceDue <= 0
        ? "paid"
        : amountReceived > 0
          ? "partial"
          : clean(cycle?.billing?.status || "pending").toLowerCase(),
  };
}

/* ============================================
   ADMIN: PLAN MENSUAL DESDE ADMINUSUARIOS
============================================ */


function ensureMonthlyPlanStaff(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase().trim();

  if (!["admin", "staff", "profesor"].includes(role)) {
    return res.status(403).json({
      error: "No tenés permisos para administrar planes mensuales.",
    });
  }

  next();
}

function normalizeMonthlyPlanServiceKey(value) {
  const key = normalizeCatalogServiceKey(value);
  return isServiceEnabledFor(key, "recurringPlanEnabled") ? key : "";
}

function argentinaPeriodBounds(periodKey) {
  const [year, month] = String(periodKey || "").split("-").map(Number);

  if (!year || !month) {
    return { start: null, end: null };
  }

  // Argentina = UTC-3. 00:00 AR = 03:00 UTC.
  const start = new Date(Date.UTC(year, month - 1, 1, 3, 0, 0, 0));
  const next = new Date(Date.UTC(year, month, 1, 3, 0, 0, 0));
  const end = new Date(next.getTime() - 1);

  return { start, end };
}

function serializeAdminMonthlyPlan(subscription, cycle = null) {
  if (!subscription) return null;

  const billing = cycleBillingSummary(cycle);

  return {
    id: String(subscription._id || subscription.id || ""),
    serviceKey: subscription.serviceKey,
    serviceName: subscription.serviceName,
    status: subscription.status,
    autoRenew: subscription.autoRenew !== false,
    monthlySessions: Number(subscription.monthlySessions || 0),
    price: Number(subscription.price || 0),
    regularPrice: Number(subscription.regularPrice || subscription.price || 0),
    payMethod: subscription.payMethod || "CASH",
    pricingPlan: subscription.pricingPlan || null,
    currentPeriodKey: subscription.currentPeriodKey || "",
    currentPeriodStart: subscription.currentPeriodStart || null,
    currentPeriodEnd: subscription.currentPeriodEnd || null,
    fixedSlotsProtectedUntil: subscription.fixedSlotsProtectedUntil || null,
    fixedScheduleIds: Array.isArray(subscription.fixedScheduleIds)
      ? subscription.fixedScheduleIds.map((id) => String(id))
      : [],
    pendingChange: subscription.pendingChange || null,
    currentCycle: cycle
      ? {
          id: String(cycle._id),
          periodKey: cycle.periodKey,
          billingStatus: cycle.billing?.status || "pending",
          planStatus: cycle.lifecycle?.planStatus || "active",
          dueAt: cycle.billing?.dueAt || null,
          paidAt: cycle.billing?.paidAt || null,
          ...billing,
        }
      : null,
  };
}

async function findPublishedPlanForAdminMonthlySessions({
  serviceKey,
  monthlySessions,
  preferredPayMethod = "",
}) {
  const candidates = await PricingPlan.find({
    active: true,
    isCustom: { $ne: true },
    serviceKey,
    credits: monthlySessions,
  })
    .sort({ price: 1, createdAt: 1 })
    .lean();

  if (!candidates.length) return null;

  const preferred = String(preferredPayMethod || "").toUpperCase().trim();
  if (preferred) {
    const sameMethod = candidates.find(
      (plan) => String(plan?.payMethod || "").toUpperCase().trim() === preferred
    );
    if (sameMethod) return sameMethod;
  }

  const cash = candidates.find(
    (plan) => String(plan?.payMethod || "").toUpperCase().trim() === "CASH"
  );

  return cash || candidates[0];
}

router.get(
  "/admin/user/:targetUserId",
  ensureMonthlyPlanStaff,
  async (req, res) => {
    try {
      const targetUserId = String(req.params?.targetUserId || "").trim();
      const targetUser = await User.findById(targetUserId)
        .select("_id name lastName email")
        .lean();

      if (!targetUser) {
        return res.status(404).json({ error: "Usuario no encontrado." });
      }

      const subscriptions = await ServiceSubscription.find({
        user: targetUserId,
      })
        .populate(
          "pricingPlan",
          "serviceKey credits price regularPrice payMethod active label title"
        )
        .sort({ serviceKey: 1 })
        .lean();

      const currentPeriodKey = monthKeyFromDateArgentina();
      const subscriptionIds = subscriptions.map((item) => item._id);
      const currentCycles = subscriptionIds.length
        ? await SubscriptionBillingCycle.find({
            subscription: { $in: subscriptionIds },
            periodKey: currentPeriodKey,
          }).lean()
        : [];

      const cycleBySubscription = new Map(
        currentCycles.map((cycle) => [String(cycle.subscription), cycle])
      );

      return res.json({
        ok: true,
        user: {
          id: String(targetUser._id),
          name: targetUser.name || "",
          lastName: targetUser.lastName || "",
          email: targetUser.email || "",
        },
        periodKey: currentPeriodKey,
        subscriptions: subscriptions.map((subscription) =>
          serializeAdminMonthlyPlan(
            subscription,
            cycleBySubscription.get(String(subscription._id)) || null
          )
        ),
      });
    } catch (error) {
      console.error("GET /subscriptions/admin/user/:targetUserId", error);
      return res.status(500).json({
        error: "No se pudieron cargar los planes mensuales del usuario.",
      });
    }
  }
);

router.put(
  "/admin/user/:targetUserId/service/:serviceKey",
  ensureMonthlyPlanStaff,
  async (req, res) => {
    try {
      const targetUserId = String(req.params?.targetUserId || "").trim();
      const serviceKey = normalizeMonthlyPlanServiceKey(req.params?.serviceKey);
      const monthlySessions = Number(req.body?.monthlySessions);

      if (!serviceKey) {
        return res.status(400).json({ error: "Servicio inválido." });
      }

      if (
        !Number.isInteger(monthlySessions) ||
        monthlySessions <= 0 ||
        monthlySessions > 100
      ) {
        return res.status(400).json({
          error: "La cantidad mensual debe ser un número entero mayor a 0.",
        });
      }

      const targetUser = await User.findById(targetUserId)
        .select("_id name lastName email")
        .lean();

      if (!targetUser) {
        return res.status(404).json({ error: "Usuario no encontrado." });
      }

      const existing = await ServiceSubscription.findOne({
        user: targetUserId,
        serviceKey,
      }).lean();

      const publishedPlan = await findPublishedPlanForAdminMonthlySessions({
        serviceKey,
        monthlySessions,
        preferredPayMethod: existing?.payMethod || "",
      });

      if (!publishedPlan) {
        const availablePlans = await PricingPlan.find({
          active: true,
          isCustom: { $ne: true },
          serviceKey,
        })
          .select("credits")
          .lean();

        const availableSessions = [
          ...new Set(
            availablePlans
              .map((plan) => Number(plan?.credits || 0))
              .filter((credits) => Number.isInteger(credits) && credits > 0)
          ),
        ].sort((a, b) => a - b);

        return res.status(400).json({
          error: `No existe un plan publicado de ${monthlySessions} sesiones para ${serviceKey}.`,
          availableSessions,
        });
      }

      const now = new Date();
      const currentPeriodKey = monthKeyFromDateArgentina(now);
      const { start: currentPeriodStart, end: currentPeriodEnd } =
        argentinaPeriodBounds(currentPeriodKey);

      const fixedSchedules = await FixedSchedule.find({
        user: targetUserId,
        serviceKey,
        active: true,
      })
        .select("_id")
        .lean();

      const fixedScheduleIds = fixedSchedules.map((item) => item._id);

      /*
       * IMPORTANTE:
       * Este endpoint NO acredita creditLots ni modifica el saldo actual.
       * Solo establece/modifica la suscripción que será la base de las
       * renovaciones mensuales y del cálculo de sesiones adicionales.
       */
      const update = {
        serviceName: serviceNameForKey(serviceKey),
        monthlySessions,
        pricingPlan: publishedPlan._id,
        price: Number(publishedPlan.price || 0),
        regularPrice: Number(
          publishedPlan.regularPrice ?? publishedPlan.price ?? 0
        ),
        payMethod: String(publishedPlan.payMethod || "CASH")
          .toUpperCase()
          .trim(),
        autoRenew: true,
        status: "active",
        pendingChange: null,
        currentPeriodKey,
        currentPeriodStart,
        currentPeriodEnd,
        fixedScheduleIds,
      };

      const subscription = await ServiceSubscription.findOneAndUpdate(
        {
          user: targetUserId,
          serviceKey,
        },
        {
          $set: update,
          $setOnInsert: {
            user: targetUserId,
            serviceKey,
          },
        },
        {
          new: true,
          upsert: true,
          setDefaultsOnInsert: true,
          runValidators: false,
        }
      ).populate(
        "pricingPlan",
        "serviceKey credits price regularPrice payMethod active label title"
      );

      let syncResult = null;
      let syncError = "";

      try {
        syncResult = await syncExtraSessionNoticeForUserService({
          userId: targetUserId,
          serviceKey,
          actorId: req.user?._id || req.user?.id || null,
          source: existing
            ? "admin_monthly_plan_updated"
            : "admin_monthly_plan_created",
          now,
        });
      } catch (error) {
        syncError =
          error?.message ||
          "No se pudo recalcular la diferencia de sesiones adicionales.";

        console.warn("[ADMIN MONTHLY PLAN] extra-session sync failed", {
          targetUserId,
          serviceKey,
          monthlySessions,
          error: syncError,
        });
      }

      let extraSessionNotice = null;

      try {
        const notices = await listExtraSessionNoticesForUser(targetUserId);

        extraSessionNotice =
          notices.find(
            (notice) =>
              String(notice?.serviceKey || "").toUpperCase() === serviceKey &&
              String(notice?.periodKey || "") === currentPeriodKey
          ) ||
          notices.find(
            (notice) =>
              String(notice?.serviceKey || "").toUpperCase() === serviceKey
          ) ||
          null;
      } catch (error) {
        console.warn("[ADMIN MONTHLY PLAN] list extras failed", {
          targetUserId,
          serviceKey,
          error: error?.message || error,
        });
      }

      return res.json({
        ok: true,
        created: !existing,
        monthlySessions,
        currentCreditsChanged: false,
        subscription: serializeAdminMonthlyPlan(
          subscription?.toObject?.() || subscription
        ),
        extraSessionNotice,
        extraSync: {
          ok: !syncError,
          error: syncError || null,
          result: syncResult || null,
        },
      });
    } catch (error) {
      console.error(
        "PUT /subscriptions/admin/user/:targetUserId/service/:serviceKey",
        error
      );

      return res.status(500).json({
        error:
          error?.message ||
          "No se pudo establecer el plan mensual del usuario.",
      });
    }
  }
);


/* ============================================
   ADMIN: REGISTRAR PAGO DEL PLAN MENSUAL
   - genera SUBSCRIPTION_RENEWAL
   - NO acredita creditLots
   - acepta pagos parciales
============================================ */
router.post(
  "/admin/user/:targetUserId/service/:serviceKey/payment",
  ensureMonthlyPlanStaff,
  async (req, res) => {
    try {
      const targetUserId = clean(req.params?.targetUserId);
      const serviceKey = normalizeMonthlyPlanServiceKey(req.params?.serviceKey);
      const amount = money(req.body?.amount);
      const payMethodRaw = clean(req.body?.payMethod || "CASH").toUpperCase();
      const payMethod =
        payMethodRaw === "MERCADOPAGO" || payMethodRaw === "MP"
          ? "MP"
          : "CASH";
      const notes = clean(req.body?.notes);
      const currentPeriodKey = monthKeyFromDateArgentina();
      const requestedPeriodKey = clean(req.body?.periodKey || currentPeriodKey);

      if (!/^[a-f\d]{24}$/i.test(targetUserId)) {
        return res.status(400).json({ error: "Usuario inválido." });
      }

      if (!serviceKey) {
        return res.status(400).json({ error: "Servicio inválido." });
      }

      if (!(amount > 0)) {
        return res.status(400).json({
          error: "El importe del pago debe ser mayor a $0.",
        });
      }

      // Los pagos históricos se reparan con scripts auditados; este endpoint es
      // únicamente para la cuenta corriente del ciclo vigente.
      if (requestedPeriodKey !== currentPeriodKey) {
        return res.status(400).json({
          error: "Desde administración solo se registran pagos del ciclo mensual vigente.",
          currentPeriodKey,
        });
      }

      const [targetUser, subscription] = await Promise.all([
        User.findById(targetUserId),
        ServiceSubscription.findOne({
          user: targetUserId,
          serviceKey,
        }),
      ]);

      if (!targetUser) {
        return res.status(404).json({ error: "Usuario no encontrado." });
      }

      if (!subscription) {
        return res.status(404).json({
          error: `El usuario no tiene un plan mensual ${serviceKey}.`,
        });
      }

      if (
        subscription.status === "terminated_for_non_payment"
      ) {
        return res.status(409).json({
          error:
            "Este plan ya fue dado de baja y sus turnos fijos pudieron liberarse. Primero requiere una reactivación controlada con validación de cupo.",
          code: "SUBSCRIPTION_REACTIVATION_REQUIRES_CAPACITY_CHECK",
        });
      }

      const cycle = await SubscriptionBillingCycle.findOne({
        subscription: subscription._id,
        user: targetUserId,
        serviceKey,
        periodKey: currentPeriodKey,
      });

      if (!cycle) {
        return res.status(404).json({
          error:
            "No existe el ciclo mensual vigente para este plan. No se registró ningún pago.",
          code: "SUBSCRIPTION_CURRENT_CYCLE_NOT_FOUND",
        });
      }

      const before = cycleBillingSummary(cycle);

      if (
        cycle.billing?.status === "paid" ||
        before.balanceDue <= 0
      ) {
        return res.status(409).json({
          error: "El ciclo mensual ya está totalmente abonado.",
          code: "SUBSCRIPTION_CYCLE_ALREADY_PAID",
          billing: before,
        });
      }

      // Si ya existe una orden pendiente de renovación por el MISMO importe,
      // la reutilizamos. Si es una preferencia MP por otro importe, no la
      // pisamos: debe anularse primero para evitar dos cobros posibles.
      let order = null;

      if (cycle.billing?.order) {
        const existingOrder = await Order.findById(cycle.billing.order);

        if (existingOrder) {
          const existingStatus = clean(existingOrder.status).toLowerCase();
          const existingAmount = money(
            existingOrder.totalFinal ??
              existingOrder.total ??
              existingOrder.price
          );

          if (
            existingStatus === "pending" &&
            existingOrder.payMethod === "MP" &&
            existingOrder.mpPreferenceId &&
            existingAmount !== amount
          ) {
            return res.status(409).json({
              error:
                "Existe un pago de Mercado Pago pendiente por otro importe. Eliminá/cancelá esa orden antes de cargar un importe distinto.",
              code: "SUBSCRIPTION_PENDING_MP_ORDER_EXISTS",
              pendingOrderId: String(existingOrder._id),
              pendingAmount: existingAmount,
              balanceDue: before.balanceDue,
            });
          }

          if (
            existingStatus === "pending" &&
            existingAmount === amount &&
            clean(existingOrder.payMethod).toUpperCase() === payMethod
          ) {
            order = existingOrder;
          } else if (
            existingStatus === "pending" &&
            !existingOrder.mpPreferenceId
          ) {
            existingOrder.status = "cancelled";
            existingOrder.notes = [
              clean(existingOrder.notes),
              "Orden reemplazada por un pago mensual registrado desde administración.",
            ]
              .filter(Boolean)
              .join("\n");
            await existingOrder.save();

            cycle.billing.order = null;
            await cycle.save();
          }
        }
      }

      if (!order) {
        const item = buildSubscriptionRenewalItem({
          cycle,
          subscription,
          amount,
        });

        order = await Order.create({
          user: targetUserId,
          payMethod,
          items: [item],
          totalBase: amount,
          total: amount,
          totalFinal: amount,
          status: "paid",
          paidAt: new Date(),
          applied: false,
          creditsApplied: false,
          subscriptionExtraApplied: true,
          subscriptionCycleApplied: false,
          suppressUserEmails: true,
          createdByAdmin: true,
          createdByAdminId: req.user?._id || null,
          customerName:
            `${targetUser.name || ""} ${targetUser.lastName || ""}`.trim() ||
            targetUser.fullName ||
            "",
          customerEmail: targetUser.email || "",
          customerPhone: targetUser.phone || "",
          notes: [
            `Pago del plan mensual ${serviceKey} ${currentPeriodKey}.`,
            "Las sesiones del plan ya fueron acreditadas por el ciclo; esta orden solo registra dinero.",
            notes,
          ]
            .filter(Boolean)
            .join("\n"),
          serviceKey,
          credits: 0,
          price: amount,
          label: `Pago plan ${serviceKey} · ${currentPeriodKey}`,
        });
      } else {
        order.status = "paid";
        order.paidAt = order.paidAt || new Date();
        order.subscriptionExtraApplied = true;
        order.createdByAdmin = true;
        order.createdByAdminId = req.user?._id || order.createdByAdminId || null;
        order.notes = [
          clean(order.notes),
          notes,
        ]
          .filter(Boolean)
          .join("\n");
        await order.save();
      }

      const applied = await applySubscriptionRenewalFromOrder({
        order,
        paymentProvider: payMethod,
        paymentId: order.mpPaymentId || "",
        paidAt: order.paidAt || new Date(),
      });

      order.applied = true;
      order.subscriptionCycleApplied = true;
      order.subscriptionExtraApplied = true;
      await order.save();

      const freshCycle = await SubscriptionBillingCycle.findById(cycle._id).lean();
      const freshSubscription = await ServiceSubscription.findById(
        subscription._id
      ).lean();
      const after = cycleBillingSummary(freshCycle);

      targetUser.history = Array.isArray(targetUser.history)
        ? targetUser.history
        : [];
      targetUser.history.push({
        action: "subscription_payment_recorded_by_admin",
        title: `Pago del plan ${serviceKey}`,
        message: `Se registró un pago de $${amount} para ${currentPeriodKey}. Saldo pendiente: $${after.balanceDue}.`,
        serviceKey,
        serviceName: serviceNameForKey(serviceKey) || serviceKey,
        qty: 0,
        createdAt: new Date(),
      });
      await targetUser.save();

      return res.status(201).json({
        ok: true,
        periodKey: currentPeriodKey,
        orderId: String(order._id),
        amount,
        paymentApplied: applied,
        billing: after,
        subscription: serializeAdminMonthlyPlan(
          freshSubscription,
          freshCycle
        ),
        message:
          after.balanceDue > 0
            ? `Pago registrado. Quedan $${after.balanceDue} pendientes y la cuenta continúa activa.`
            : after.overpaidAmount > 0
              ? `Pago registrado. El ciclo quedó abonado y se registró un excedente de $${after.overpaidAmount}.`
              : "Pago registrado. El ciclo quedó totalmente abonado.",
      });
    } catch (error) {
      console.error(
        "POST /subscriptions/admin/user/:targetUserId/service/:serviceKey/payment",
        error
      );

      return res.status(500).json({
        error:
          error?.message ||
          "No se pudo registrar el pago mensual.",
      });
    }
  }
);

/* ============================================
   HELPERS DE PAGO
============================================ */
function getFrontBaseUrl() {
  return String(
    process.env.FRONTEND_URL ||
      process.env.FRONT_BASE_URL ||
      process.env.APP_URL ||
      "https://duoclub.ar"
  ).replace(/\/+$/, "");
}

async function createMpPreferenceForRenewal({ order, user, cycle }) {
  const accessToken = process.env.MP_ACCESS_TOKEN;
  if (!accessToken) throw new Error("MP_ACCESS_TOKEN no configurado.");

  const amount = Math.max(0, Number(order.totalFinal ?? order.total ?? 0));
  if (!(amount > 0)) {
    throw new Error("El ciclo no tiene un importe válido para Mercado Pago.");
  }

  const frontBase = getFrontBaseUrl();
  const body = {
    items: [
      {
        title: `DUO - Renovación ${cycle.serviceKey} ${cycle.periodKey}`,
        quantity: 1,
        currency_id: "ARS",
        unit_price: amount,
      },
    ],
    external_reference: String(order._id),
    metadata: {
      orderId: String(order._id),
      userId: String(user?._id || order.user || ""),
      subscriptionCycleId: String(cycle._id),
      subscriptionId: String(cycle.subscription),
      periodKey: cycle.periodKey,
      kind: "SUBSCRIPTION_RENEWAL",
    },
    back_urls: {
      success: `${frontBase}/?mp=success`,
      pending: `${frontBase}/?mp=pending`,
      failure: `${frontBase}/?mp=failure`,
    },
    auto_return: "approved",
    notification_url: process.env.MP_WEBHOOK_URL || undefined,
  };

  if (user?.email) body.payer = { email: String(user.email).trim() };

  const response = await fetch("https://api.mercadopago.com/checkout/preferences", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || "No se pudo crear la preferencia de Mercado Pago.");
  }

  return { preferenceId: data.id, initPoint: data.init_point };
}

function renewalOrderResponse(order) {
  return {
    orderId: String(order._id),
    status: order.status,
    payMethod: order.payMethod,
    amount: Number(order.totalFinal ?? order.total ?? 0),
    init_point: order.mpInitPoint || "",
  };
}

function serializeSubscription(subscription, cycles = []) {
  return {
    id: String(subscription._id),
    serviceKey: subscription.serviceKey,
    serviceName: subscription.serviceName,
    status: subscription.status,
    autoRenew: subscription.autoRenew,
    monthlySessions: subscription.monthlySessions,
    price: subscription.price,
    regularPrice: subscription.regularPrice,
    payMethod: subscription.payMethod,
    pricingPlan: subscription.pricingPlan,
    currentPeriodKey: subscription.currentPeriodKey,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    fixedSlotsProtectedUntil: subscription.fixedSlotsProtectedUntil,
    pendingChange: subscription.pendingChange,
    cycles: cycles.map((cycle) => {
      const billing = cycleBillingSummary(cycle);

      return {
        id: String(cycle._id),
        periodKey: cycle.periodKey,
        billingStatus: cycle.billing?.status,
        amount: billing.total,
        amountReceived: billing.amountReceived,
        amountPaid: billing.amountPaid,
        balanceDue: billing.balanceDue,
        overpaidAmount: billing.overpaidAmount,
        paymentState: billing.paymentState,
        dueAt: cycle.billing?.dueAt || null,
        paidAt: cycle.billing?.paidAt || null,
        planStatus: cycle.lifecycle?.planStatus,
        sessions: cycle.planSnapshot?.monthlySessions || 0,
        creditsGranted: !!cycle.creditGrant?.granted,
      };
    }),
  };
}

/* ============================================
   MI PLAN
============================================ */
router.get("/me", async (req, res) => {
  try {
    const uid = userId(req);
    const subscriptions = await ServiceSubscription.find({ user: uid })
      .populate("pricingPlan", "serviceKey credits price payMethod active label title")
      .sort({ serviceKey: 1 })
      .lean();

    const subscriptionIds = subscriptions.map((item) => item._id);
    const cycles = await SubscriptionBillingCycle.find({
      subscription: { $in: subscriptionIds },
    })
      .sort({ periodKey: -1 })
      .lean();

    const bySubscription = new Map();
    for (const cycle of cycles) {
      const key = String(cycle.subscription);
      if (!bySubscription.has(key)) bySubscription.set(key, []);
      if (bySubscription.get(key).length < 3) {
        bySubscription.get(key).push(cycle);
      }
    }

    return res.json({
      subscriptions: subscriptions.map((subscription) =>
        serializeSubscription(
          subscription,
          bySubscription.get(String(subscription._id)) || []
        )
      ),
    });
  } catch (error) {
    console.error("GET /subscriptions/me", error);
    return res.status(500).json({ error: "No se pudieron cargar tus planes." });
  }
});

router.get("/notices", async (req, res) => {
  try {
    const notices = await SubscriptionLifecycleNotice.find({
      user: userId(req),
      status: { $in: ["unread", "read"] },
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      notices: notices.map((notice) => ({
        id: String(notice._id),
        subscriptionId: String(notice.subscription),
        cycleId: notice.cycle ? String(notice.cycle) : null,
        serviceKey: notice.serviceKey,
        periodKey: notice.periodKey,
        type: notice.type,
        title: notice.title,
        message: notice.message,
        action: notice.action,
        actionRequired: notice.actionRequired,
        status: notice.status,
        metadata: notice.metadata || {},
        createdAt: notice.createdAt,
      })),
    });
  } catch (error) {
    console.error("GET /subscriptions/notices", error);
    return res.status(500).json({
      error: "No se pudieron cargar las notificaciones.",
    });
  }
});

router.patch("/notices/:id/read", async (req, res) => {
  try {
    const notice = await SubscriptionLifecycleNotice.findOneAndUpdate(
      { _id: req.params.id, user: userId(req) },
      { $set: { status: "read", readAt: new Date() } },
      { new: true }
    );

    if (!notice) {
      return res.status(404).json({ error: "Notificación no encontrada." });
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({
      error: "No se pudo actualizar la notificación.",
    });
  }
});

/* ============================================
   PAGO DEL CICLO MENSUAL
============================================ */
router.post("/cycles/:cycleId/pay", async (req, res) => {
  try {
    const uid = userId(req);
    const cycle = await SubscriptionBillingCycle.findOne({
      _id: req.params.cycleId,
      user: uid,
    });

    if (!cycle) {
      return res.status(404).json({ error: "Ciclo mensual no encontrado." });
    }

    const before = cycleBillingSummary(cycle);

    if (
      cycle.billing?.status === "paid" ||
      before.balanceDue <= 0
    ) {
      return res.json({
        ok: true,
        alreadyPaid: true,
        cycleId: String(cycle._id),
        billingStatus: "paid",
        billing: before,
      });
    }

    if (!["pending", "overdue"].includes(String(cycle.billing?.status || ""))) {
      return res.status(400).json({
        error: "Este ciclo no admite pagos en su estado actual.",
      });
    }

    const subscription = await ServiceSubscription.findOne({
      _id: cycle.subscription,
      user: uid,
    });

    if (!subscription) {
      return res.status(404).json({ error: "Suscripción no encontrada." });
    }

    if (subscription.status === "terminated_for_non_payment") {
      return res.status(409).json({
        error:
          "Este plan ya fue dado de baja y sus turnos pudieron liberarse. Contactá al staff para reactivarlo de forma segura.",
        code: "SUBSCRIPTION_REACTIVATION_REQUIRES_CAPACITY_CHECK",
      });
    }

    const expectedMethod = String(
      cycle.planSnapshot?.payMethod || subscription.payMethod || "CASH"
    )
      .toUpperCase()
      .trim();

    const requestedMethod = String(req.body?.payMethod || expectedMethod)
      .toUpperCase()
      .trim();

    if (requestedMethod !== expectedMethod) {
      return res.status(400).json({
        error: `Este plan se renueva mediante ${
          expectedMethod === "MP" ? "Mercado Pago" : "efectivo/transferencia"
        }. Para cambiar el medio de pago, modificá el plan del próximo período.`,
      });
    }

    const requestedAmountRaw = req.body?.amount;
    const requestedAmount =
      requestedAmountRaw === null ||
      requestedAmountRaw === undefined ||
      requestedAmountRaw === ""
        ? before.balanceDue
        : money(requestedAmountRaw);

    if (!(requestedAmount > 0)) {
      return res.status(400).json({
        error: "El importe del pago debe ser mayor a $0.",
      });
    }

    if (requestedAmount > before.balanceDue) {
      return res.status(400).json({
        error: `El saldo pendiente es $${before.balanceDue}.`,
        code: "SUBSCRIPTION_PAYMENT_EXCEEDS_BALANCE",
        billing: before,
      });
    }

    if (cycle.billing?.order) {
      const existingOrder = await Order.findById(cycle.billing.order);

      if (existingOrder) {
        const status = String(existingOrder.status || "").toLowerCase();
        const existingAmount = money(
          existingOrder.totalFinal ??
            existingOrder.total ??
            existingOrder.price
        );

        if (status === "paid" || status === "approved") {
          if (!existingOrder.subscriptionCycleApplied) {
            await applySubscriptionRenewalFromOrder({
              order: existingOrder,
              paymentProvider: existingOrder.payMethod,
              paymentId: existingOrder.mpPaymentId || "",
              paidAt: existingOrder.paidAt || new Date(),
            });

            existingOrder.subscriptionCycleApplied = true;
            existingOrder.subscriptionExtraApplied = true;
            existingOrder.applied = true;
            await existingOrder.save();
          }

          const freshCycle = await SubscriptionBillingCycle.findById(
            cycle._id
          ).lean();

          return res.json({
            ok: true,
            paymentApplied: true,
            ...renewalOrderResponse(existingOrder),
            billing: cycleBillingSummary(freshCycle),
          });
        }

        if (status === "pending") {
          if (existingAmount !== requestedAmount) {
            if (
              expectedMethod === "MP" &&
              existingOrder.mpPreferenceId
            ) {
              return res.status(409).json({
                error:
                  `Ya existe un pago de Mercado Pago pendiente por $${existingAmount}. No vamos a generar otro por un monto distinto para evitar un doble cobro.`,
                code: "SUBSCRIPTION_PENDING_MP_ORDER_EXISTS",
                pendingOrderId: String(existingOrder._id),
                pendingAmount: existingAmount,
                billing: before,
              });
            }

            existingOrder.status = "cancelled";
            existingOrder.notes = [
              clean(existingOrder.notes),
              `Orden reemplazada: el saldo vigente es $${before.balanceDue}.`,
            ]
              .filter(Boolean)
              .join(" | ");
            await existingOrder.save();

            cycle.billing.order = null;
            await cycle.save();
          } else {
            if (expectedMethod === "MP" && !existingOrder.mpInitPoint) {
              const user = await User.findById(uid).lean();
              const mp = await createMpPreferenceForRenewal({
                order: existingOrder,
                user,
                cycle,
              });

              existingOrder.mpPreferenceId = mp.preferenceId;
              existingOrder.mpInitPoint = mp.initPoint;
              await existingOrder.save();
            }

            return res.json({
              ok: true,
              reused: true,
              ...renewalOrderResponse(existingOrder),
              billing: before,
            });
          }
        }
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
      subscriptionExtraApplied: true,
      subscriptionCycleApplied: false,
      suppressUserEmails: true,
      notes: `Renovación mensual ${cycle.serviceKey} ${cycle.periodKey}. Las sesiones ya fueron acreditadas por el ciclo; esta orden solo registra el cobro.`,
    });

    cycle.billing.order = order._id;
    await cycle.save();

    if (expectedMethod === "MP") {
      try {
        const user = await User.findById(uid).lean();
        const mp = await createMpPreferenceForRenewal({ order, user, cycle });
        order.mpPreferenceId = mp.preferenceId;
        order.mpInitPoint = mp.initPoint;
        await order.save();
      } catch (error) {
        order.status = "cancelled";
        order.notes = `${order.notes}
No se pudo generar Mercado Pago: ${
          error?.message || error
        }`;
        await order.save();
        cycle.billing.order = null;
        await cycle.save();
        throw error;
      }
    }

    return res.status(201).json({
      ok: true,
      ...renewalOrderResponse(order),
      billing: before,
    });
  } catch (error) {
    console.error("POST /subscriptions/cycles/:cycleId/pay", error);
    return res.status(500).json({
      error: error?.message || "No se pudo generar el pago mensual.",
    });
  }
});

/* ============================================
   CAMBIOS PEDIDOS POR EL USUARIO
============================================ */
router.post("/:id/change-next", async (req, res) => {
  try {
    const subscription = await ServiceSubscription.findOne({
      _id: req.params.id,
      user: userId(req),
    });

    if (!subscription) {
      return res.status(404).json({ error: "Plan no encontrado." });
    }

    const pricingPlanId = String(req.body?.pricingPlanId || "");
    const plan = await PricingPlan.findOne({
      _id: pricingPlanId,
      active: true,
      isCustom: { $ne: true },
      serviceKey: subscription.serviceKey,
    }).lean();

    if (!plan) {
      return res.status(400).json({
        error: "El plan elegido no está publicado para este servicio.",
      });
    }

    const effectivePeriodKey = addMonthsToMonthKey(
      monthKeyFromDateArgentina(),
      1
    );

    subscription.pendingChange = {
      type: "change",
      effectivePeriodKey,
      requestedAt: new Date(),
      requestedBy: req.user?._id || req.user?.id,
      pricingPlan: plan._id,
      monthlySessions: Number(plan.credits || 0),
      price: Number(plan.price || 0),
      payMethod: plan.payMethod,
      fixedScheduleIds: subscription.fixedScheduleIds || [],
      addOns: subscription.addOns || [],
      autoRenew: true,
      reason: "Cambio solicitado por el usuario desde Mi Plan.",
    };

    subscription.status = "pending_change";
    await subscription.save();

    return res.json({
      ok: true,
      effectivePeriodKey,
      pendingChange: subscription.pendingChange,
    });
  } catch (error) {
    console.error("POST /subscriptions/:id/change-next", error);
    return res.status(500).json({
      error: "No se pudo programar el cambio de plan.",
    });
  }
});

router.post("/:id/cancel-next", async (req, res) => {
  try {
    const subscription = await ServiceSubscription.findOne({
      _id: req.params.id,
      user: userId(req),
    });

    if (!subscription) {
      return res.status(404).json({ error: "Plan no encontrado." });
    }

    const effectivePeriodKey = addMonthsToMonthKey(
      monthKeyFromDateArgentina(),
      1
    );

    subscription.pendingChange = {
      type: "cancel",
      effectivePeriodKey,
      requestedAt: new Date(),
      requestedBy: req.user?._id || req.user?.id,
      autoRenew: false,
      reason: "Cancelación solicitada por el usuario para el próximo período.",
    };

    subscription.status = "pending_change";
    await subscription.save();

    return res.json({ ok: true, effectivePeriodKey });
  } catch (error) {
    return res.status(500).json({
      error: "No se pudo programar la cancelación.",
    });
  }
});

router.post("/:id/suspend-next", async (req, res) => {
  try {
    const subscription = await ServiceSubscription.findOne({
      _id: req.params.id,
      user: userId(req),
    });

    if (!subscription) {
      return res.status(404).json({ error: "Plan no encontrado." });
    }

    const effectivePeriodKey = addMonthsToMonthKey(
      monthKeyFromDateArgentina(),
      1
    );

    subscription.pendingChange = {
      type: "suspend",
      effectivePeriodKey,
      requestedAt: new Date(),
      requestedBy: req.user?._id || req.user?.id,
      autoRenew: false,
      reason: "Suspensión solicitada por el usuario para el próximo período.",
    };

    subscription.status = "pending_change";
    await subscription.save();

    return res.json({ ok: true, effectivePeriodKey });
  } catch (error) {
    return res.status(500).json({
      error: "No se pudo programar la suspensión.",
    });
  }
});

router.post("/:id/clear-change", async (req, res) => {
  try {
    const subscription = await ServiceSubscription.findOne({
      _id: req.params.id,
      user: userId(req),
    });

    if (!subscription) {
      return res.status(404).json({ error: "Plan no encontrado." });
    }

    if (
      ["cancelled", "terminated_for_non_payment"].includes(
        String(subscription.status || "")
      )
    ) {
      return res.status(400).json({
        error:
          "Este plan ya está finalizado y no tiene un cambio programado que pueda deshacerse.",
      });
    }

    if (!subscription.pendingChange) {
      return res.json({
        ok: true,
        alreadyClear: true,
        status: subscription.status,
        autoRenew: subscription.autoRenew !== false,
      });
    }

    const clearedType = String(subscription.pendingChange?.type || "change");
    subscription.pendingChange = null;
    subscription.autoRenew = true;

    if (subscription.status === "pending_change") {
      subscription.status = "active";
    }

    await subscription.save();

    return res.json({
      ok: true,
      clearedType,
      status: subscription.status,
      autoRenew: subscription.autoRenew !== false,
    });
  } catch (error) {
    console.error("POST /subscriptions/:id/clear-change", error);
    return res.status(500).json({
      error: "No se pudo deshacer el cambio programado.",
    });
  }
});

export default router;
