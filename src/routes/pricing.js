// backend/src/routes/pricing.js
import express from "express";
import PricingPlan from "../models/PricingPlan.js";
import { protect, adminOnly } from "../middleware/auth.js";
import { logActivity } from "../lib/activityLogger.js";

const router = express.Router();

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

    if (!serviceKey || !payMethod || typeof credits !== "number" || typeof price !== "number") {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    const existing = await PricingPlan.findOne({
      serviceKey: String(serviceKey).toUpperCase().trim(),
      payMethod: String(payMethod).toUpperCase().trim(),
      credits,
    }).lean();

    const doc = await PricingPlan.findOneAndUpdate(
      { serviceKey: String(serviceKey).toUpperCase().trim(), payMethod: String(payMethod).toUpperCase().trim(), credits },
      {
        $set: {
          price,
          label: label || "",
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
      meta: { serviceKey: doc.serviceKey, payMethod: doc.payMethod, credits: doc.credits, price: doc.price, active: doc.active },
      diff: existing ? { before: existing, after: doc.toObject ? doc.toObject() : doc } : {},
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
