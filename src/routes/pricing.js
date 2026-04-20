// backend/src/routes/pricing.js
import express from "express";
import PricingPlan from "../models/PricingPlan.js";
import { protect, adminOnly } from "../middleware/auth.js";
import { logActivity } from "../lib/activityLogger.js";

const router = express.Router();

const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RF", "RA", "NUT"]);
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
