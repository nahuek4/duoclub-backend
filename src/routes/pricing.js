// backend/src/routes/pricing.js
import express from "express";
import mongoose from "mongoose";
import PricingPlan from "../models/PricingPlan.js";
import { protect, adminOnly } from "../middleware/auth.js";
import { logActivity } from "../lib/activityLogger.js";

const router = express.Router();

const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RF", "RA", "KD", "NUT"]);
const SERVICE_KEY_ALIASES = {
  AR: "RA",
};

function normalizeServiceKey(value) {
  const raw = String(value || "").toUpperCase().trim();
  if (!raw) return "";

  const canonical = SERVICE_KEY_ALIASES[raw] || raw;
  return ALLOWED_SERVICE_KEYS.has(canonical) ? canonical : "";
}

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

function normalizeOptionalPrice(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return n;
}

function cleanString(value) {
  return String(value || "").trim();
}

function validObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value || ""));
}

/* =========================
   AUTO-SEED KD PRICING
========================= */
const KD_SERVICE_KEY = "KD";
const KD_SEED_SOURCE_KEYS = ["RA", "RF"];

function pricingIdentityKey(plan) {
  return [
    String(plan?.payMethod || "").toUpperCase().trim(),
    Number(plan?.credits || 0),
  ].join("__");
}

function planIsUsableForSeed(plan) {
  // No copiamos tarjetas libres para evitar duplicaciones de promos personalizadas.
  if (plan?.isCustom === true) return false;

  const payMethod = normalizePayMethod(plan?.payMethod);
  const credits = normalizeCredits(plan?.credits);
  const price = normalizePrice(plan?.price);
  const coveragePrice = normalizeOptionalPrice(plan?.coveragePrice);

  return (
    ["CASH", "MP"].includes(payMethod) &&
    Number.isFinite(credits) &&
    credits > 0 &&
    Number.isFinite(price) &&
    price >= 0 &&
    (coveragePrice === null || (Number.isFinite(coveragePrice) && coveragePrice >= 0))
  );
}

function labelForKDPlan(sourcePlan) {
  const current = String(sourcePlan?.label || "").trim();
  if (current) return current;

  const credits = Number(sourcePlan?.credits || 0);
  if (credits === 1) return "1 sesión";
  if (credits > 1) return `${credits} sesiones`;
  return "";
}

function pickSourcePlansForKD(allSourcePlans = []) {
  const usable = allSourcePlans.filter(planIsUsableForSeed);

  const activeRA = usable.filter(
    (p) => String(p.serviceKey || "").toUpperCase() === "RA" && p.active !== false
  );
  if (activeRA.length) return activeRA;

  const activeRF = usable.filter(
    (p) => String(p.serviceKey || "").toUpperCase() === "RF" && p.active !== false
  );
  if (activeRF.length) return activeRF;

  const anyRA = usable.filter((p) => String(p.serviceKey || "").toUpperCase() === "RA");
  if (anyRA.length) return anyRA;

  const anyRF = usable.filter((p) => String(p.serviceKey || "").toUpperCase() === "RF");
  if (anyRF.length) return anyRF;

  return [];
}

async function ensureKDPricingPlans() {
  const existingKD = await PricingPlan.find({
    serviceKey: KD_SERVICE_KEY,
    isCustom: { $ne: true },
  }).lean();
  const activeKD = existingKD.filter((p) => p.active !== false);

  if (activeKD.length > 0) {
    return { created: 0, activated: 0, skipped: true, reason: "KD_ALREADY_ACTIVE" };
  }

  if (existingKD.length > 0) {
    await PricingPlan.updateMany(
      { serviceKey: KD_SERVICE_KEY, isCustom: { $ne: true } },
      { $set: { active: true } }
    );
    return {
      created: 0,
      activated: existingKD.length,
      skipped: false,
      reason: "KD_EXISTING_PLANS_ACTIVATED",
    };
  }

  const sourcePlans = await PricingPlan.find({
    serviceKey: { $in: KD_SEED_SOURCE_KEYS },
    isCustom: { $ne: true },
  })
    .sort({ serviceKey: 1, payMethod: 1, credits: 1 })
    .lean();

  const selectedSources = pickSourcePlansForKD(sourcePlans);

  if (!selectedSources.length) {
    console.warn(
      "[PRICING][KD_SEED] No se encontraron planes RA/RF para copiar. Cargá al menos un plan RA o RF para crear KD automáticamente."
    );
    return { created: 0, activated: 0, skipped: true, reason: "NO_SOURCE_PLANS" };
  }

  const uniqueSources = new Map();
  for (const source of selectedSources) {
    const key = pricingIdentityKey(source);
    if (!uniqueSources.has(key)) uniqueSources.set(key, source);
  }

  const operations = [...uniqueSources.values()].map((source) => {
    const payMethod = normalizePayMethod(source.payMethod);
    const credits = normalizeCredits(source.credits);
    const price = normalizePrice(source.price);

    return {
      updateOne: {
        filter: {
          serviceKey: KD_SERVICE_KEY,
          payMethod,
          credits,
          isCustom: { $ne: true },
        },
        update: {
          $setOnInsert: {
            serviceKey: KD_SERVICE_KEY,
            payMethod,
            credits,
            price,
            coveragePrice:
              source.coveragePrice === null || source.coveragePrice === undefined
                ? null
                : Number(source.coveragePrice),
            label: labelForKDPlan(source),
            isCustom: false,
            customTitle: "",
          },
          $set: { active: true },
        },
        upsert: true,
      },
    };
  });

  if (!operations.length) {
    return { created: 0, activated: 0, skipped: true, reason: "NO_VALID_SOURCE_DOCS" };
  }

  const result = await PricingPlan.bulkWrite(operations, { ordered: false });
  const created = Number(result?.upsertedCount || 0);
  const modified = Number(result?.modifiedCount || 0);

  console.log("[PRICING][KD_SEED] Planes KD sincronizados automáticamente:", {
    created,
    modified,
  });

  return {
    created,
    activated: modified,
    skipped: false,
    reason: "KD_CREATED_FROM_RA_OR_RF",
  };
}

router.use(protect);

// GET /pricing?active=1
router.get("/", async (req, res) => {
  try {
    await ensureKDPricingPlans();

    const active = String(req.query.active ?? "1") === "1";

    const query = active ? { active: true } : {};
    const list = await PricingPlan.find(query)
      .sort({ isCustom: 1, serviceKey: 1, payMethod: 1, credits: 1, createdAt: 1 })
      .lean();

    res.json(list);
  } catch (err) {
    console.error("Error en GET /pricing:", err);
    res.status(500).json({ error: "Error al obtener precios." });
  }
});

/**
 * ADMIN
 * POST /pricing/upsert
 * body estándar: { serviceKey, payMethod, credits, price, label, active }
 * body tarjeta libre: { id?, isCustom: true, customTitle, serviceKey, payMethod, credits, price, active }
 */
router.post("/upsert", adminOnly, async (req, res) => {
  try {
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

    const normalizedServiceKey = normalizeServiceKey(serviceKey);
    const normalizedPayMethod = normalizePayMethod(payMethod);
    const normalizedCredits = normalizeCredits(credits);
    const normalizedPrice = normalizePrice(price);
    const normalizedCoveragePrice = normalizeOptionalPrice(coveragePrice);
    const custom = Boolean(isCustom);
    const title = cleanString(customTitle || label);
    const cleanLabel = cleanString(label || customTitle);

    if (
      !normalizedServiceKey ||
      !["CASH", "MP"].includes(normalizedPayMethod) ||
      !Number.isFinite(normalizedCredits) ||
      !Number.isFinite(normalizedPrice) ||
      (normalizedCoveragePrice !== null && !Number.isFinite(normalizedCoveragePrice))
    ) {
      return res.status(400).json({
        error: "Datos inválidos. Revisá serviceKey, payMethod, credits y price.",
      });
    }

    if (normalizedCredits <= 0) {
      return res.status(400).json({ error: "La cantidad de créditos debe ser mayor a 0." });
    }

    if (normalizedPrice < 0) {
      return res.status(400).json({ error: "El precio no puede ser negativo." });
    }

    if (normalizedCoveragePrice !== null && normalizedCoveragePrice < 0) {
      return res.status(400).json({ error: "El precio con obra social no puede ser negativo." });
    }

    if (custom && !title) {
      return res.status(400).json({ error: "La tarjeta libre necesita un título." });
    }

    let existing = null;
    let doc = null;

    if (custom) {
      if (id) {
        if (!validObjectId(id)) return res.status(400).json({ error: "ID inválido." });
        existing = await PricingPlan.findById(id).lean();
        if (!existing) return res.status(404).json({ error: "Tarjeta no encontrada." });

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
      title: existing ? "Plan actualizado" : custom ? "Tarjeta libre creada" : "Plan creado",
      description: custom ? "Se guardó una tarjeta libre de precios." : "Se guardó un plan de precios.",
      meta: {
        serviceKey: doc.serviceKey,
        payMethod: doc.payMethod,
        credits: doc.credits,
        price: doc.price,
        coveragePrice: doc.coveragePrice,
        active: doc.active,
        isCustom: doc.isCustom,
        customTitle: doc.customTitle,
      },
      diff: existing ? { before: existing, after: doc.toObject ? doc.toObject() : doc } : {},
    });

    res.json({ ok: true, plan: doc });
  } catch (err) {
    console.error("Error en POST /pricing/upsert:", err);
    if (err?.code === 11000) {
      return res.status(409).json({ error: "Plan duplicado. Revisá los índices de MongoDB." });
    }
    res.status(500).json({ error: err?.message || "Error al guardar el plan." });
  }
});

router.delete("/:id", adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    if (!validObjectId(id)) return res.status(400).json({ error: "ID inválido." });

    const existing = await PricingPlan.findById(id).lean();
    if (!existing) return res.status(404).json({ error: "Plan no encontrado." });

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
        coveragePrice: existing.coveragePrice,
        active: existing.active,
        isCustom: existing.isCustom,
        customTitle: existing.customTitle,
      },
      diff: { before: existing, after: null },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Error en DELETE /pricing/:id:", err);
    res.status(500).json({ error: "Error al eliminar el plan." });
  }
});

export default router;
