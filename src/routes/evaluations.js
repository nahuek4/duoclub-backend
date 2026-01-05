import express from "express";
import Evaluation from "../models/Evaluation.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

/* =========================================================
   GET /evaluations/me
   Cliente ve SUS evaluaciones
========================================================= */
router.get("/me", protect, async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || "200", 10)));
    const items = await Evaluation.find({ user: req.user._id })
      .select("type title notes createdAt updatedAt scoring")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({ items });
  } catch (err) {
    console.error("GET /evaluations/me error:", err);
    return res.status(500).json({ error: "Error al traer evaluaciones." });
  }
});

export default router;
