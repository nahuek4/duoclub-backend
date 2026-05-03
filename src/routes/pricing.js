// backend/src/routes/pricing.js
import express from "express";
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

/* =========================
   AUTO-SEED KD PRICING
   Crea/activa planes de Kinefilaxia Deportiva copiando RA o RF.
   No inventa precios: toma los planes existentes de RA/RF.
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
  const payMethod = normalizePayMethod(plan?.payMethod);
  const credits = normalizeCredits(plan?.credits);
  const price = normalizePrice(plan?.price);

  return (
    ["CASH", "MP"].includes(payMethod) &&
    Number.isFinite(credits) &&
    credits > 0 &&
    Number.isFinite(price) &&
    price >= 0
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
  const existingKD = await PricingPlan.find({ serviceKey: KD_SERVICE_KEY }).lean();
  const activeKD = existingKD.filter((p) => p.active !== false);

  // Si ya hay al menos un plan activo de KD, no tocamos precios ni duplicamos nada.
  if (activeKD.length > 0) {
    return { created: 0, activated: 0, skipped: true, reason: "KD_ALREADY_ACTIVE" };
  }

  // Si existían planes KD pero estaban inactivos, los activamos y no cambiamos su precio.
  if (existingKD.length > 0) {
    await PricingPlan.updateMany(
      { serviceKey: KD_SERVICE_KEY },
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
        filter: { serviceKey: KD_SERVICE_KEY, payMethod, credits },
        update: {
          $setOnInsert: {
            serviceKey: KD_SERVICE_KEY,
            payMethod,
            credits,
            price,
            label: labelForKDPlan(source),
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

/**
 * GET /pricing
 * Devuelve TODOS los planes activos (para el front).
 * Podés hacerlo público o privado.
 *
 * Yo lo dejo protegido por defecto para que no sea scrapeable sin login.
 * Si lo querés público, comentás router.use(protect).
 */
router.use(protect);

// GET /pricing?active=1
router.get("/", async (req, res) => {
  try {
    await ensureKDPricingPlans();

    const active = String(req.query.active ?? "1") === "1";

    const query = active ? { active: true } : {};
    const list = await PricingPlan.find(query)
      .sort({ serviceKey: 1, payMethod: 1, credits: 1 })
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
 * body: { serviceKey, payMethod, credits, price, label, active }
 * Permite actualizar o crear sin romper.
 */
router.post("/upsert", adminOnly, async (req, res) => {
  try {
    const { serviceKey, payMethod, credits, price, label, active } = req.body || {};

    const normalizedServiceKey = normalizeServiceKey(serviceKey);
    const normalizedPayMethod = normalizePayMethod(payMethod);
    const normalizedCredits = normalizeCredits(credits);
    const normalizedPrice = normalizePrice(price);

    if (
      !normalizedServiceKey ||
      !normalizedPayMethod ||
      !Number.isFinite(normalizedCredits) ||
      !Number.isFinite(normalizedPrice)
    ) {
      return res.status(400).json({
        error:
          "Datos inválidos. Revisá serviceKey, payMethod, credits y price.",
      });
    }

    if (normalizedCredits <= 0) {
      return res.status(400).json({
        error: "La cantidad de créditos debe ser mayor a 0.",
      });
    }

    if (normalizedPrice < 0) {
      return res.status(400).json({
        error: "El precio no puede ser negativo.",
      });
    }

    const filter = {
      serviceKey: normalizedServiceKey,
      payMethod: normalizedPayMethod,
      credits: normalizedCredits,
    };

    const existing = await PricingPlan.findOne(filter).lean();

    const doc = await PricingPlan.findOneAndUpdate(
      filter,
      {
        $set: {
          serviceKey: normalizedServiceKey,
          payMethod: normalizedPayMethod,
          credits: normalizedCredits,
          price: normalizedPrice,
          label: String(label || "").trim(),
          active: typeof active === "boolean" ? active : true,
        },
      },
      { upsert: true, new: true }
    );

    await logActivity({
      req,
      category: "pricing",
      action: existing ? "pricing_updated" : "pricing_created",
      entity: "pricing_plan",
      entityId: doc._id,
      title: existing ? "Plan actualizado" : "Plan creado",
      description: "Se guardó un plan de precios.",
      meta: {
        serviceKey: doc.serviceKey,
        payMethod: doc.payMethod,
        credits: doc.credits,
        price: doc.price,
        active: doc.active,
      },
      diff: existing
        ? { before: existing, after: doc.toObject ? doc.toObject() : doc }
        : {},
    });

    res.json({ ok: true, plan: doc });
  } catch (err) {
    console.error("Error en POST /pricing/upsert:", err);
    if (err?.code === 11000) {
      return res.status(409).json({ error: "Plan duplicado." });
    }
    res.status(500).json({ error: "Error al guardar el plan." });
  }
});

export default router;
