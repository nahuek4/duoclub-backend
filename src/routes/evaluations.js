// backend/src/routes/evaluations.js
import express from "express";
import Evaluation from "../models/Evaluation.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  NUT: "Nutrición",
};

const ALLOWED_SERVICE_KEYS = new Set(Object.keys(SERVICE_KEY_TO_NAME));

function toIdString(v) {
  try {
    return String(v);
  } catch {
    return "";
  }
}

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normalizeServiceKey(value) {
  const raw = String(value || "").toUpperCase().trim();
  if (raw === "AR") return "RA";
  if (ALLOWED_SERVICE_KEYS.has(raw)) return raw;

  const s = stripAccents(value).toLowerCase().trim();
  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("nutric")) return "NUT";

  return "";
}

function serviceNameFromKey(serviceKey) {
  const key = normalizeServiceKey(serviceKey);
  return key ? SERVICE_KEY_TO_NAME[key] || "" : "";
}

function serializeEval(e) {
  if (!e) return null;

  const serviceKey = normalizeServiceKey(
    e.serviceKey || e.service || e.serviceName || e.type || ""
  );

  return {
    id: toIdString(e._id),
    _id: e._id, // compatibilidad con front existente
    type: e.type || "",
    title: e.title || "",
    notes: e.notes || "",
    scoring: e.scoring || {},
    serviceKey: serviceKey || "",
    serviceName:
      serviceNameFromKey(serviceKey) || String(e.serviceName || e.service || ""),
    createdAt: e.createdAt || null,
    updatedAt: e.updatedAt || null,
  };
}

/* =========================================================
   GET /evaluations/me
   Cliente ve SUS evaluaciones
========================================================= */
router.get("/me", protect, async (req, res) => {
  try {
    const limit = Math.min(
      500,
      Math.max(1, parseInt(req.query.limit || "200", 10))
    );

    const docs = await Evaluation.find({ user: req.user._id })
      .select(
        "type title notes createdAt updatedAt scoring serviceKey service serviceName"
      )
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const items = (docs || []).map(serializeEval).filter(Boolean);

    return res.json({ items });
  } catch (err) {
    console.error("GET /evaluations/me error:", err);
    return res.status(500).json({ error: "Error al traer evaluaciones." });
  }
});

export default router;
