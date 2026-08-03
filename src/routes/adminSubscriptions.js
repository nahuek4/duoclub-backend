// backend/src/routes/adminSubscriptions.js
// Etapa 3: previsualización + bootstrap controlado de suscripciones iniciales.
// No modifica créditos, deuda legacy, órdenes, turnos ni jobs.

import crypto from "crypto";
import express from "express";
import mongoose from "mongoose";

import { protect, adminOnly } from "../middleware/auth.js";
import User from "../models/User.js";
import FixedSchedule from "../models/FixedSchedule.js";
import ScheduleBlock from "../models/ScheduleBlock.js";
import PricingPlan from "../models/PricingPlan.js";
import Order from "../models/Order.js";
import ServiceSubscription from "../models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../models/SubscriptionBillingCycle.js";

import {
  isValidMonthKey,
  monthRangeFromKey,
  normalizeServiceKey,
} from "../services/subscriptions/fixedScheduleCoverage.js";
import { buildSubscriptionCoveragePreview } from "../services/subscriptions/subscriptionCoveragePreview.js";
import {
  buildInitialSubscriptionCandidate,
  buildServiceSubscriptionCreatePayload,
  canRollbackBootstrapSubscription,
} from "../services/subscriptions/subscriptionBootstrap.js";

const router = express.Router();
router.use(protect, adminOnly);

const RECURRING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN", "NUT"]);
const CREATE_CONFIRMATION = "CREATE_INITIAL_SUBSCRIPTION";
const ROLLBACK_CONFIRMATION = "ROLLBACK_INITIAL_SUBSCRIPTION";

function cleanString(value) {
  return String(value || "").trim();
}

function parseOptionalNonNegativeInteger(value, fieldName) {
  if (value === undefined || value === null || cleanString(value) === "") {
    return null;
  }

  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    const error = new Error(`${fieldName} debe ser un entero mayor o igual a 0.`);
    error.status = 400;
    throw error;
  }
  return n;
}

function parseOptionalPositiveInteger(value, fieldName) {
  const n = parseOptionalNonNegativeInteger(value, fieldName);
  if (n === null) return null;
  if (n <= 0) {
    const error = new Error(`${fieldName} debe ser un entero mayor a 0.`);
    error.status = 400;
    throw error;
  }
  return n;
}

function parseOptionalMoney(value, fieldName) {
  if (value === undefined || value === null || cleanString(value) === "") {
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    const error = new Error(`${fieldName} debe ser un número mayor o igual a 0.`);
    error.status = 400;
    throw error;
  }
  return Math.round(n);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = cleanString(value).toLowerCase();
  return ["1", "true", "yes", "si", "sí"].includes(normalized);
}

function assertObjectId(value, fieldName) {
  const id = cleanString(value);
  if (!mongoose.Types.ObjectId.isValid(id)) {
    const error = new Error(`${fieldName} inválido.`);
    error.status = 400;
    throw error;
  }
  return id;
}

function assertServiceKey(value) {
  const serviceKey = normalizeServiceKey(value);
  if (!serviceKey || !RECURRING_SERVICE_KEYS.has(serviceKey)) {
    const error = new Error(
      "serviceKey inválido. Valores permitidos: EP, RA, RF, KD, SYN, NUT."
    );
    error.status = 400;
    throw error;
  }
  return serviceKey;
}

function assertMonthKey(value) {
  const monthKey = cleanString(value);
  if (!isValidMonthKey(monthKey)) {
    const error = new Error("monthKey inválido. Usá el formato YYYY-MM.");
    error.status = 400;
    throw error;
  }
  return monthKey;
}

function assertPayMethod(value, { optional = true } = {}) {
  const payMethod = cleanString(value).toUpperCase();
  if (!payMethod && optional) return "";
  if (!["CASH", "MP"].includes(payMethod)) {
    const error = new Error("payMethod inválido. Valores permitidos: CASH o MP.");
    error.status = 400;
    throw error;
  }
  return payMethod;
}

function buildBlocksRangeQuery(startYmd, endYmd) {
  return {
    active: true,
    dateFrom: { $lte: endYmd },
    $and: [
      {
        $or: [
          { indefinite: true },
          { dateTo: { $gte: startYmd } },
          { dateTo: "" },
          { dateTo: { $exists: false } },
        ],
      },
    ],
  };
}

function buildPaidOrderQuery(userId, serviceKey) {
  return {
    user: userId,
    status: { $in: ["paid", "approved"] },
    $or: [
      {
        items: {
          $elemMatch: {
            kind: { $in: ["CREDITS", "MANUAL_SERVICE"] },
            serviceKey,
          },
        },
      },
      { serviceKey },
    ],
  };
}

async function loadSubscriptionContext({
  userId,
  serviceKey,
  monthKey,
  payMethod = "",
  includeCustomPlans = false,
} = {}) {
  const range = monthRangeFromKey(monthKey);
  const pricingQuery = { active: true, serviceKey };
  if (payMethod) pricingQuery.payMethod = payMethod;
  if (!includeCustomPlans) pricingQuery.isCustom = { $ne: true };

  const [user, schedules, blocks, pricingPlans, existingSubscription, latestPaidOrder] =
    await Promise.all([
      User.findById(userId)
        .select(
          "name lastName fullName email role creditLots fixedScheduleDebt"
        )
        .lean(),

      FixedSchedule.find({
        user: userId,
        active: true,
        serviceKey,
        startDate: { $lte: range.endYmd },
        endDate: { $gte: range.startYmd },
      })
        .sort({ startDate: 1, createdAt: 1 })
        .lean(),

      ScheduleBlock.find(buildBlocksRangeQuery(range.startYmd, range.endYmd))
        .sort({ dateFrom: 1, createdAt: 1 })
        .lean(),

      PricingPlan.find(pricingQuery)
        .sort({ credits: 1, price: 1, payMethod: 1 })
        .lean(),

      ServiceSubscription.findOne({ user: userId, serviceKey }).lean(),

      Order.findOne(buildPaidOrderQuery(userId, serviceKey))
        .sort({ paidAt: -1, createdAt: -1 })
        .lean(),
    ]);

  if (!user) {
    const error = new Error("Usuario no encontrado.");
    error.status = 404;
    throw error;
  }

  return {
    user,
    schedules,
    blocks,
    pricingPlans,
    existingSubscription,
    latestPaidOrder,
  };
}

function parseBootstrapInput(source = {}) {
  const userId = assertObjectId(source?.userId, "userId");
  const serviceKey = assertServiceKey(source?.serviceKey);
  const monthKey = assertMonthKey(source?.monthKey);
  const pricingPlanId = cleanString(source?.pricingPlanId);
  const payMethod = assertPayMethod(source?.payMethod, { optional: true });
  const monthlySessions = parseOptionalPositiveInteger(
    source?.monthlySessions,
    "monthlySessions"
  );
  const price = parseOptionalMoney(source?.price, "price");
  const includeCustomPlans = parseBoolean(source?.includeCustomPlans, false);
  const autoRenew = parseBoolean(source?.autoRenew, true);

  if (pricingPlanId) assertObjectId(pricingPlanId, "pricingPlanId");

  return {
    userId,
    serviceKey,
    monthKey,
    pricingPlanId,
    payMethod,
    monthlySessions,
    price,
    includeCustomPlans,
    autoRenew,
  };
}

function serializeSubscription(subscription = {}) {
  const doc = typeof subscription?.toObject === "function"
    ? subscription.toObject()
    : subscription;

  return {
    id: cleanString(doc?._id),
    user:
      doc?.user && typeof doc.user === "object"
        ? {
            id: cleanString(doc.user?._id),
            name: [doc.user?.name, doc.user?.lastName]
              .filter(Boolean)
              .join(" ")
              .trim(),
            email: cleanString(doc.user?.email),
          }
        : cleanString(doc?.user),
    serviceKey: cleanString(doc?.serviceKey),
    serviceName: cleanString(doc?.serviceName),
    status: cleanString(doc?.status),
    monthlySessions: Number(doc?.monthlySessions || 0),
    price: Number(doc?.price || 0),
    payMethod: cleanString(doc?.payMethod),
    autoRenew: doc?.autoRenew !== false,
    currentPeriodKey: cleanString(doc?.currentPeriodKey),
    fixedScheduleIds: (Array.isArray(doc?.fixedScheduleIds)
      ? doc.fixedScheduleIds
      : []
    ).map(String),
    bootstrap: doc?.bootstrap || null,
    createdAt: doc?.createdAt || null,
    updatedAt: doc?.updatedAt || null,
  };
}

/**
 * GET /api/admin/subscriptions/coverage-preview
 * Etapa 2, conservada sin escrituras.
 */
router.get("/coverage-preview", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");

    const userId = assertObjectId(req.query?.userId, "userId");
    const serviceKey = assertServiceKey(req.query?.serviceKey);
    const monthKey = assertMonthKey(req.query?.monthKey);
    const pricingPlanId = cleanString(req.query?.pricingPlanId);
    const payMethod = assertPayMethod(req.query?.payMethod, { optional: true });
    const includeCustomPlans = parseBoolean(
      req.query?.includeCustomPlans,
      false
    );

    if (pricingPlanId) assertObjectId(pricingPlanId, "pricingPlanId");

    const manualMonthlySessions = parseOptionalNonNegativeInteger(
      req.query?.monthlySessions,
      "monthlySessions"
    );
    const extraSessionsSelected =
      parseOptionalNonNegativeInteger(
        req.query?.extraSessionsSelected,
        "extraSessionsSelected"
      ) ?? 0;

    const context = await loadSubscriptionContext({
      userId,
      serviceKey,
      monthKey,
      payMethod,
      includeCustomPlans,
    });

    if (
      pricingPlanId &&
      !context.pricingPlans.some(
        (plan) => cleanString(plan?._id) === pricingPlanId
      )
    ) {
      return res.status(404).json({
        ok: false,
        error:
          "El plan indicado no existe, está inactivo, pertenece a otro servicio o quedó fuera del filtro seleccionado.",
      });
    }

    const preview = buildSubscriptionCoveragePreview({
      user: context.user,
      serviceKey,
      monthKey,
      schedules: context.schedules,
      blocks: context.blocks,
      pricingPlans: context.pricingPlans,
      selectedPricingPlanId: pricingPlanId,
      manualMonthlySessions,
      extraSessionsSelected,
      manualPayMethod: payMethod,
      includeCustomPlans,
    });

    return res.json({ ok: true, ...preview });
  } catch (error) {
    const status = Number(error?.status || 500);
    console.error("GET /admin/subscriptions/coverage-preview error:", error);
    return res.status(status).json({
      ok: false,
      error:
        status >= 500
          ? "No se pudo generar la previsualización mensual."
          : cleanString(error?.message) || "Solicitud inválida.",
    });
  }
});

/**
 * GET /api/admin/subscriptions/bootstrap-preview
 * Previsualiza exactamente el documento que podría crearse.
 */
router.get("/bootstrap-preview", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const input = parseBootstrapInput(req.query || {});
    const context = await loadSubscriptionContext(input);

    const candidate = buildInitialSubscriptionCandidate({
      user: context.user,
      serviceKey: input.serviceKey,
      monthKey: input.monthKey,
      schedules: context.schedules,
      blocks: context.blocks,
      pricingPlans: context.pricingPlans,
      selectedPricingPlanId: input.pricingPlanId,
      manualMonthlySessions: input.monthlySessions,
      manualPrice: input.price,
      manualPayMethod: input.payMethod,
      autoRenew: input.autoRenew,
      existingSubscription: context.existingSubscription,
      latestPaidOrder: context.latestPaidOrder,
      includeCustomPlans: input.includeCustomPlans,
    });

    return res.json({ ok: true, candidate });
  } catch (error) {
    const status = Number(error?.status || 500);
    console.error("GET /admin/subscriptions/bootstrap-preview error:", error);
    return res.status(status).json({
      ok: false,
      error:
        status >= 500
          ? "No se pudo preparar la suscripción inicial."
          : cleanString(error?.message) || "Solicitud inválida.",
    });
  }
});

/**
 * POST /api/admin/subscriptions/bootstrap
 * Crea una sola suscripción. No crea ciclos ni toca el sistema legacy.
 */
router.post("/bootstrap", async (req, res) => {
  let session = null;
  try {
    const confirmation = cleanString(req.body?.confirm);
    const apply = parseBoolean(req.body?.apply, false);

    if (!apply || confirmation !== CREATE_CONFIRMATION) {
      return res.status(400).json({
        ok: false,
        error:
          `Para crear la suscripción enviá apply=true y confirm=${CREATE_CONFIRMATION}.`,
      });
    }

    const input = parseBootstrapInput(req.body || {});
    const context = await loadSubscriptionContext(input);
    const candidate = buildInitialSubscriptionCandidate({
      user: context.user,
      serviceKey: input.serviceKey,
      monthKey: input.monthKey,
      schedules: context.schedules,
      blocks: context.blocks,
      pricingPlans: context.pricingPlans,
      selectedPricingPlanId: input.pricingPlanId,
      manualMonthlySessions: input.monthlySessions,
      manualPrice: input.price,
      manualPayMethod: input.payMethod,
      autoRenew: input.autoRenew,
      existingSubscription: context.existingSubscription,
      latestPaidOrder: context.latestPaidOrder,
      includeCustomPlans: input.includeCustomPlans,
    });

    if (!candidate.canCreate) {
      return res.status(409).json({
        ok: false,
        error: "La suscripción no puede crearse.",
        candidate,
      });
    }

    const actorId = req.user?._id || req.user?.id || null;
    const batchId = cleanString(req.body?.batchId) || crypto.randomUUID();
    const payload = buildServiceSubscriptionCreatePayload(candidate, {
      actorId,
      batchId,
      notes: cleanString(req.body?.notes),
    });

    let created = null;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const duplicate = await ServiceSubscription.findOne({
        user: input.userId,
        serviceKey: input.serviceKey,
      }).session(session);

      if (duplicate) {
        const conflict = new Error("SUBSCRIPTION_ALREADY_EXISTS");
        conflict.status = 409;
        throw conflict;
      }

      const docs = await ServiceSubscription.create([payload], { session });
      created = docs[0];
    });

    const populated = await ServiceSubscription.findById(created?._id)
      .populate("user", "name lastName fullName email")
      .lean();

    return res.status(201).json({
      ok: true,
      message:
        "Suscripción inicial creada. No se modificaron créditos, deuda, turnos, órdenes ni facturación.",
      subscription: serializeSubscription(populated || created),
      candidate,
    });
  } catch (error) {
    const duplicate = error?.code === 11000 || error?.message === "SUBSCRIPTION_ALREADY_EXISTS";
    const status = duplicate ? 409 : Number(error?.status || 500);
    console.error("POST /admin/subscriptions/bootstrap error:", error);
    return res.status(status).json({
      ok: false,
      error: duplicate
        ? "El usuario ya tiene una suscripción para este servicio."
        : status >= 500
          ? "No se pudo crear la suscripción inicial."
          : cleanString(error?.message) || "Solicitud inválida.",
    });
  } finally {
    await session?.endSession?.().catch(() => null);
  }
});

/**
 * POST /api/admin/subscriptions/bootstrap/:subscriptionId/rollback
 * Solo elimina suscripciones creadas por bootstrap que todavía no tengan ciclos.
 */
router.post("/bootstrap/:subscriptionId/rollback", async (req, res) => {
  try {
    const subscriptionId = assertObjectId(
      req.params?.subscriptionId,
      "subscriptionId"
    );
    const confirmation = cleanString(req.body?.confirm);
    const apply = parseBoolean(req.body?.apply, false);

    const subscription = await ServiceSubscription.findById(subscriptionId).lean();
    const billingCyclesCount = subscription
      ? await SubscriptionBillingCycle.countDocuments({
          subscription: subscriptionId,
        })
      : 0;

    const rollback = canRollbackBootstrapSubscription({
      subscription,
      billingCyclesCount,
    });

    if (!rollback.allowed) {
      return res.status(subscription ? 409 : 404).json({
        ok: false,
        error: rollback.reason,
        subscription: subscription
          ? serializeSubscription(subscription)
          : null,
      });
    }

    if (!apply || confirmation !== ROLLBACK_CONFIRMATION) {
      return res.json({
        ok: true,
        dryRun: true,
        message:
          `Rollback disponible. Para aplicarlo enviá apply=true y confirm=${ROLLBACK_CONFIRMATION}.`,
        subscription: serializeSubscription(subscription),
      });
    }

    await ServiceSubscription.deleteOne({ _id: subscriptionId });

    return res.json({
      ok: true,
      rolledBack: true,
      message:
        "Suscripción inicial eliminada. El sistema legacy no fue modificado.",
      subscription: serializeSubscription(subscription),
    });
  } catch (error) {
    const status = Number(error?.status || 500);
    console.error("POST /admin/subscriptions/bootstrap rollback error:", error);
    return res.status(status).json({
      ok: false,
      error:
        status >= 500
          ? "No se pudo ejecutar el rollback."
          : cleanString(error?.message) || "Solicitud inválida.",
    });
  }
});

/** GET /api/admin/subscriptions */
router.get("/", async (req, res) => {
  try {
    const query = {};
    const userId = cleanString(req.query?.userId);
    const serviceKey = cleanString(req.query?.serviceKey)
      ? assertServiceKey(req.query?.serviceKey)
      : "";
    const status = cleanString(req.query?.status);

    if (userId) query.user = assertObjectId(userId, "userId");
    if (serviceKey) query.serviceKey = serviceKey;
    if (status) query.status = status;

    const subscriptions = await ServiceSubscription.find(query)
      .populate("user", "name lastName fullName email")
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    return res.json({
      ok: true,
      count: subscriptions.length,
      subscriptions: subscriptions.map(serializeSubscription),
    });
  } catch (error) {
    const status = Number(error?.status || 500);
    return res.status(status).json({
      ok: false,
      error:
        status >= 500
          ? "No se pudieron listar las suscripciones."
          : cleanString(error?.message) || "Solicitud inválida.",
    });
  }
});

export default router;
