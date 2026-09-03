// backend/src/routes/pricing.js
import express from "express";
import mongoose from "mongoose";

import PricingPlan, { normalizeServiceKey } from "../models/PricingPlan.js";
import ServiceDefinition, {
  CORE_SERVICE_DEFINITIONS,
} from "../models/ServiceDefinition.js";
import { protect, adminOnly } from "../middleware/auth.js";
import { logActivity } from "../lib/activityLogger.js";

const router = express.Router();

// STEP3B3B_PUBLIC_DYNAMIC_PRICING
// /pricing?active=1 se filtra por el catálogo dinámico: servicio activo,
// visible, comprable y no legacy.

function normalizePayMethod(value) {
  return String(value || "").toUpperCase().trim();
}

function normalizeCredits(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return Math.trunc(n);
}

function normalizePrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return n;
}

function normalizeNullablePrice(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return null;
  }
  return normalizePrice(value);
}

function cleanString(value) {
  return String(value || "").trim();
}

function validObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""));
}

function sameIndexKey(indexKey = {}, expectedKey = {}) {
  const a = JSON.stringify(indexKey || {});
  const b = JSON.stringify(expectedKey || {});
  return a === b;
}

async function ensurePricingIndexesForCustomCards() {
  try {
    const legacyUniqueKey = { serviceKey: 1, payMethod: 1, credits: 1 };
    const indexes = await PricingPlan.collection.indexes();

    for (const idx of indexes) {
      if (!idx?.unique) continue;
      if (!sameIndexKey(idx.key, legacyUniqueKey)) continue;

      await PricingPlan.collection.dropIndex(idx.name);
      console.log("[PRICING][INDEX] Índice único de precios eliminado:", idx.name);
    }

    await PricingPlan.collection.createIndex(
      { serviceKey: 1, payMethod: 1, credits: 1, isCustom: 1, active: 1 },
      { name: "pricing_lookup", unique: false }
    );

    await PricingPlan.collection.createIndex(
      { isCustom: 1, customTitle: 1, serviceKey: 1, payMethod: 1, credits: 1 },
      { name: "pricing_custom_title_lookup", unique: false }
    );
  } catch (err) {
    const msg = String(err?.message || "");
    const codeName = String(err?.codeName || "");
    const ignorable =
      msg.includes("already exists") ||
      msg.includes("IndexOptionsConflict") ||
      msg.includes("IndexKeySpecsConflict") ||
      codeName === "IndexOptionsConflict" ||
      codeName === "IndexKeySpecsConflict";

    if (!ignorable) {
      console.error("[PRICING][INDEX] No se pudo preparar índices de precios:", err);
      throw err;
    }
  }
}

async function publicPurchasableServiceKeys() {
  try {
    const services = await ServiceDefinition.find({
      active: true,
      catalogVisible: { $ne: false },
      purchasable: { $ne: false },
      legacy: { $ne: true },
    })
      .select("serviceKey")
      .lean();

    const keys = services
      .map((service) => normalizeServiceKey(service?.serviceKey))
      .filter(Boolean);

    if (keys.length) return [...new Set(keys)];

    const catalogInitialized = Boolean(await ServiceDefinition.exists({}));
    if (catalogInitialized) return [];
  } catch (error) {
    console.error("[PRICING] publicPurchasableServiceKeys:", error);
  }

  return CORE_SERVICE_DEFINITIONS
    .filter(
      (service) =>
        service?.legacy !== true &&
        service?.active !== false &&
        service?.catalogVisible !== false &&
        service?.purchasable !== false
    )
    .map((service) => normalizeServiceKey(service?.serviceKey))
    .filter(Boolean);
}

async function getCatalogServiceOrThrow(serviceKey) {
  const normalized = normalizeServiceKey(serviceKey);

  if (!normalized) {
    const error = new Error("Servicio inválido.");
    error.status = 400;
    throw error;
  }

  const service = await ServiceDefinition.findOne({ serviceKey: normalized }).lean();

  if (!service) {
    const error = new Error(
      `El servicio ${normalized} no existe en el catálogo. Crealo primero desde Gestionar servicios.`
    );
    error.status = 400;
    error.code = "SERVICE_NOT_IN_CATALOG";
    throw error;
  }

  if (service.legacy === true) {
    const error = new Error(
      `${service.name || normalized} es un servicio histórico y no admite nuevos planes.`
    );
    error.status = 409;
    error.code = "LEGACY_SERVICE";
    throw error;
  }

  if (service.purchasable === false) {
    const error = new Error(
      `${service.name || normalized} está configurado como no comprable.`
    );
    error.status = 409;
    error.code = "SERVICE_NOT_PURCHASABLE";
    throw error;
  }

  return service;
}

router.use(protect);

// GET /pricing?active=1
router.get("/", async (req, res) => {
  try {
    await ensurePricingIndexesForCustomCards();

    const active = String(req.query.active ?? "1") === "1";

    const query = active
      ? {
          active: true,
          serviceKey: { $in: await publicPurchasableServiceKeys() },
        }
      : {};

    const list = await PricingPlan.find(query)
      .sort({ isCustom: 1, serviceKey: 1, payMethod: 1, credits: 1, createdAt: 1 })
      .lean();

    return res.json(list);
  } catch (err) {
    console.error("Error en GET /pricing:", err);
    return res.status(500).json({ error: "Error al obtener precios." });
  }
});

/**
 * ADMIN
 * POST /pricing/upsert
 * body estándar: { serviceKey, payMethod, credits, price, coveragePrice?, label, active }
 * body tarjeta libre: { id?, isCustom: true, customTitle, serviceKey, payMethod, credits, price, coveragePrice?, active }
 */
router.post("/upsert", adminOnly, async (req, res) => {
  try {
    await ensurePricingIndexesForCustomCards();

    const {
      id,
      serviceKey,
      payMethod,
      credits,
      price,
      coveragePrice,
      label,
      active,
      isCustom,
      customTitle,
    } = req.body || {};

    const service = await getCatalogServiceOrThrow(serviceKey);
    const normalizedServiceKey = String(service.serviceKey || "").toUpperCase().trim();
    const normalizedPayMethod = normalizePayMethod(payMethod);
    const normalizedCredits = normalizeCredits(credits);
    const normalizedPrice = normalizePrice(price);
    const normalizedCoveragePrice = normalizeNullablePrice(coveragePrice);
    const custom = Boolean(isCustom);
    const title = cleanString(customTitle || label);
    const cleanLabel = cleanString(label || customTitle);

    if (
      !normalizedServiceKey ||
      !["CASH", "MP"].includes(normalizedPayMethod) ||
      !Number.isFinite(normalizedCredits) ||
      !Number.isFinite(normalizedPrice)
    ) {
      return res.status(400).json({
        error: "Datos inválidos. Revisá serviceKey, payMethod, credits y price.",
      });
    }

    if (normalizedCredits <= 0) {
      return res
        .status(400)
        .json({ error: "La cantidad de créditos debe ser mayor a 0." });
    }

    if (normalizedPrice < 0) {
      return res.status(400).json({ error: "El precio no puede ser negativo." });
    }

    if (
      normalizedCoveragePrice !== null &&
      (!Number.isFinite(normalizedCoveragePrice) || normalizedCoveragePrice < 0)
    ) {
      return res.status(400).json({
        error: "El precio con obra social debe ser mayor o igual a 0 o quedar vacío.",
      });
    }

    if (custom && !title) {
      return res
        .status(400)
        .json({ error: "La tarjeta libre necesita un título." });
    }

    let existing = null;
    let doc = null;

    if (custom) {
      if (id) {
        if (!validObjectId(id)) {
          return res.status(400).json({ error: "ID inválido." });
        }

        existing = await PricingPlan.findById(id).lean();
        if (!existing) {
          return res.status(404).json({ error: "Tarjeta no encontrada." });
        }

        doc = await PricingPlan.findByIdAndUpdate(
          id,
          {
            $set: {
              serviceKey: normalizedServiceKey,
              payMethod: normalizedPayMethod,
              credits: normalizedCredits,
              price: normalizedPrice,
              coveragePrice: normalizedCoveragePrice,
              label: cleanLabel || title,
              customTitle: title,
              isCustom: true,
              active: typeof active === "boolean" ? active : true,
            },
          },
          { new: true, runValidators: true }
        );
      } else {
        doc = await PricingPlan.create({
          serviceKey: normalizedServiceKey,
          payMethod: normalizedPayMethod,
          credits: normalizedCredits,
          price: normalizedPrice,
          coveragePrice: normalizedCoveragePrice,
          label: cleanLabel || title,
          customTitle: title,
          isCustom: true,
          active: typeof active === "boolean" ? active : true,
        });
      }
    } else {
      const filter = {
        serviceKey: normalizedServiceKey,
        payMethod: normalizedPayMethod,
        credits: normalizedCredits,
        isCustom: { $ne: true },
      };

      existing = await PricingPlan.findOne(filter).lean();

      doc = await PricingPlan.findOneAndUpdate(
        filter,
        {
          $set: {
            serviceKey: normalizedServiceKey,
            payMethod: normalizedPayMethod,
            credits: normalizedCredits,
            price: normalizedPrice,
            coveragePrice: normalizedCoveragePrice,
            label: cleanLabel,
            isCustom: false,
            customTitle: "",
            active: typeof active === "boolean" ? active : true,
          },
        },
        { upsert: true, new: true, runValidators: true }
      );
    }

    await logActivity({
      req,
      category: "pricing",
      action: existing ? "pricing_updated" : "pricing_created",
      entity: "pricing_plan",
      entityId: doc._id,
      title: existing
        ? "Plan actualizado"
        : custom
          ? "Tarjeta libre creada"
          : "Plan creado",
      description: custom
        ? "Se guardó una tarjeta libre de precios."
        : "Se guardó un plan de precios.",
      meta: {
        serviceKey: doc.serviceKey,
        payMethod: doc.payMethod,
        credits: doc.credits,
        price: doc.price,
        coveragePrice: doc.coveragePrice ?? null,
        active: doc.active,
        isCustom: doc.isCustom,
        customTitle: doc.customTitle,
      },
      diff: existing
        ? { before: existing, after: doc.toObject ? doc.toObject() : doc }
        : {},
    });

    return res.json({ ok: true, plan: doc });
  } catch (err) {
    console.error("Error en POST /pricing/upsert:", err);

    if (err?.code === 11000) {
      return res.status(409).json({
        error: "Plan duplicado. Revisá los índices de MongoDB.",
      });
    }

    return res
      .status(Number(err?.status || 500))
      .json({ error: err?.message || "Error al guardar el plan.", code: err?.code });
  }
});

router.delete("/:id", adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (!validObjectId(id)) {
      return res.status(400).json({ error: "ID inválido." });
    }

    const existing = await PricingPlan.findById(id).lean();
    if (!existing) {
      return res.status(404).json({ error: "Plan no encontrado." });
    }

    await PricingPlan.deleteOne({ _id: id });

    await logActivity({
      req,
      category: "pricing",
      action: "pricing_deleted",
      entity: "pricing_plan",
      entityId: id,
      title: existing?.isCustom ? "Tarjeta libre eliminada" : "Plan eliminado",
      description: "Se eliminó un plan/tarjeta de precios.",
      meta: {
        serviceKey: existing.serviceKey,
        payMethod: existing.payMethod,
        credits: existing.credits,
        price: existing.price,
        coveragePrice: existing.coveragePrice ?? null,
        active: existing.active,
        isCustom: existing.isCustom,
        customTitle: existing.customTitle,
      },
      diff: { before: existing, after: null },
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error en DELETE /pricing/:id:", err);
    return res.status(500).json({ error: "Error al eliminar el plan." });
  }
});

export default router;
