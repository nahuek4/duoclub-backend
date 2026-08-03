// backend/src/routes/adminSubscriptions.js
// Etapa 2: previsualización administrativa estrictamente de solo lectura.

import express from "express";
import mongoose from "mongoose";

import { protect, adminOnly } from "../middleware/auth.js";
import User from "../models/User.js";
import FixedSchedule from "../models/FixedSchedule.js";
import ScheduleBlock from "../models/ScheduleBlock.js";
import PricingPlan from "../models/PricingPlan.js";

import {
  isValidMonthKey,
  monthRangeFromKey,
  normalizeServiceKey,
} from "../services/subscriptions/fixedScheduleCoverage.js";
import { buildSubscriptionCoveragePreview } from "../services/subscriptions/subscriptionCoveragePreview.js";

const router = express.Router();
router.use(protect, adminOnly);

const RECURRING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN", "NUT"]);

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

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = cleanString(value).toLowerCase();
  return ["1", "true", "yes", "si", "sí"].includes(normalized);
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

/**
 * GET /api/admin/subscriptions/coverage-preview
 *
 * Query obligatoria:
 * - userId
 * - serviceKey: EP, RA, RF, KD, SYN o NUT
 * - monthKey: YYYY-MM
 *
 * Query opcional:
 * - pricingPlanId
 * - monthlySessions (previsualización manual)
 * - extraSessionsSelected
 * - payMethod: CASH o MP (filtra comparaciones)
 * - includeCustomPlans=true
 */
router.get("/coverage-preview", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");

    const userId = cleanString(req.query?.userId);
    const serviceKey = normalizeServiceKey(req.query?.serviceKey);
    const monthKey = cleanString(req.query?.monthKey);
    const pricingPlanId = cleanString(req.query?.pricingPlanId);
    const payMethod = cleanString(req.query?.payMethod).toUpperCase();
    const includeCustomPlans = parseBoolean(req.query?.includeCustomPlans, false);

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ ok: false, error: "userId inválido." });
    }

    if (!serviceKey || !RECURRING_SERVICE_KEYS.has(serviceKey)) {
      return res.status(400).json({
        ok: false,
        error: "serviceKey inválido. Valores permitidos: EP, RA, RF, KD, SYN, NUT.",
      });
    }

    if (!isValidMonthKey(monthKey)) {
      return res.status(400).json({
        ok: false,
        error: "monthKey inválido. Usá el formato YYYY-MM.",
      });
    }

    if (pricingPlanId && !mongoose.Types.ObjectId.isValid(pricingPlanId)) {
      return res.status(400).json({ ok: false, error: "pricingPlanId inválido." });
    }

    if (payMethod && !["CASH", "MP"].includes(payMethod)) {
      return res.status(400).json({
        ok: false,
        error: "payMethod inválido. Valores permitidos: CASH o MP.",
      });
    }

    const manualMonthlySessions = parseOptionalNonNegativeInteger(
      req.query?.monthlySessions,
      "monthlySessions"
    );
    const extraSessionsSelected =
      parseOptionalNonNegativeInteger(
        req.query?.extraSessionsSelected,
        "extraSessionsSelected"
      ) ?? 0;

    const range = monthRangeFromKey(monthKey);

    const pricingQuery = {
      active: true,
      serviceKey,
    };
    if (payMethod) pricingQuery.payMethod = payMethod;
    if (!includeCustomPlans) pricingQuery.isCustom = { $ne: true };

    const [user, schedules, blocks, pricingPlans] = await Promise.all([
      User.findById(userId)
        .select("name lastName fullName email creditLots fixedScheduleDebt")
        .lean(),

      FixedSchedule.find({
        user: userId,
        active: true,
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
    ]);

    if (!user) {
      return res.status(404).json({ ok: false, error: "Usuario no encontrado." });
    }

    if (
      pricingPlanId &&
      !pricingPlans.some((plan) => String(plan?._id || "") === pricingPlanId)
    ) {
      return res.status(404).json({
        ok: false,
        error:
          "El plan indicado no existe, está inactivo, pertenece a otro servicio o quedó fuera del filtro seleccionado.",
      });
    }

    const preview = buildSubscriptionCoveragePreview({
      user,
      serviceKey,
      monthKey,
      schedules,
      blocks,
      pricingPlans,
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

export default router;
