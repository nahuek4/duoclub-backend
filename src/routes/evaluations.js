// backend/src/routes/evaluations.js
import express from "express";
import Evaluation from "../models/Evaluation.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

function toIdString(v) {
  try {
    return String(v);
  } catch {
    return "";
  }
}

function serializeEval(e) {
  if (!e) return null;
  return {
    id: toIdString(e._id),
    _id: e._id, // lo dejamos por compatibilidad
    type: e.type || "",
    title: e.title || "",
    notes: e.notes || "",
    scoring: e.scoring || {},
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
      .select("type title notes createdAt updatedAt scoring")
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
