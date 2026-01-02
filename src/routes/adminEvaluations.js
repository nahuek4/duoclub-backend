import express from "express";
import User from "../models/User.js";
import Evaluation from "../models/Evaluation.js";
import { protect, adminOnly } from "../middleware/auth.js";

const router = express.Router();

function safeInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/* =========================================================
   GET /admin/evaluations/users
   Lista usuarios (SOLO clientes) + count eval + última eval
========================================================= */
router.get("/users", protect, adminOnly, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const page = Math.max(1, safeInt(req.query.page, 1));
    const limit = Math.min(200, Math.max(5, safeInt(req.query.limit, 50)));
    const skip = (page - 1) * limit;

    const query = { role: "client" }; // ✅ SOLO CLIENTES

    if (q) {
      query.$or = [
        { name: new RegExp(q, "i") },
        { lastName: new RegExp(q, "i") },
        { email: new RegExp(q, "i") },
        { phone: new RegExp(q, "i") },
      ];
    }

    const [total, users] = await Promise.all([
      User.countDocuments(query),
      User.find(query)
        .select("name lastName email phone suspended approvalStatus createdAt")
        .sort({ lastName: 1, name: 1 }) // ✅ ORDEN ALFABÉTICO
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const userIds = users.map((u) => u._id);

    // ✅ Conteo + última evaluación REAL
    const stats = await Evaluation.aggregate([
      { $match: { user: { $in: userIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$user",
          count: { $sum: 1 },
          lastAt: { $first: "$createdAt" },
          lastType: { $first: "$type" },
        },
      },
    ]);

    const statsMap = new Map(stats.map((s) => [String(s._id), s]));

    const items = users.map((u) => {
      const s = statsMap.get(String(u._id));
      return {
        ...u,
        evalCount: s?.count || 0,
        lastEvalAt: s?.lastAt || null,
        lastEvalType: s?.lastType || "",
      };
    });

    return res.json({
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      items,
    });
  } catch (err) {
    console.error("GET /admin/evaluations/users error:", err);
    return res.status(500).json({ error: "Error al listar usuarios." });
  }
});

/* =========================================================
   GET /admin/evaluations/user/:userId
   Historial (últimas N)
========================================================= */
router.get("/user/:userId", protect, adminOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(200, Math.max(1, safeInt(req.query.limit, 50)));

    const items = await Evaluation.find({ user: userId })
      .select("type title notes createdBy createdAt updatedAt")
      .populate("createdBy", "name lastName email")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({ items });
  } catch (err) {
    console.error("GET /admin/evaluations/user/:userId error:", err);
    return res.status(500).json({ error: "Error al traer historial." });
  }
});

/* =========================================================
   POST /admin/evaluations/user/:userId
   Crear evaluación
========================================================= */
router.post("/user/:userId", protect, adminOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    const { type, title = "", scoring = {}, notes = "" } = req.body || {};

    if (!type || typeof type !== "string") {
      return res.status(400).json({ error: "type es requerido." });
    }

    if (scoring && typeof scoring !== "object") {
      return res.status(400).json({ error: "scoring inválido." });
    }

    const target = await User.findById(userId).select("_id role").lean();
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    // Si querés bloquear eval a no-client, descomentá:
    // if (target.role !== "client") return res.status(400).json({ error: "Solo se evalúan clientes." });

    const ev = await Evaluation.create({
      user: userId,
      type: String(type).toUpperCase().trim(),
      title: String(title || "").trim(),
      scoring: scoring || {},
      notes: String(notes || ""),
      createdBy: req.user._id,
    });

    return res.status(201).json({ item: ev });
  } catch (err) {
    console.error("POST /admin/evaluations/user/:userId error:", err);
    return res.status(500).json({ error: "Error al crear evaluación." });
  }
});

/* =========================================================
   GET /admin/evaluations/:id
========================================================= */
router.get("/:id", protect, adminOnly, async (req, res) => {
  try {
    const ev = await Evaluation.findById(req.params.id)
      .populate("user", "name lastName email phone")
      .populate("createdBy", "name lastName email")
      .lean();

    if (!ev) return res.status(404).json({ error: "Evaluación no encontrada." });
    return res.json({ item: ev });
  } catch (err) {
    console.error("GET /admin/evaluations/:id error:", err);
    return res.status(500).json({ error: "Error al traer evaluación." });
  }
});

/* =========================================================
   PATCH /admin/evaluations/:id (opcional)
========================================================= */
router.patch("/:id", protect, adminOnly, async (req, res) => {
  try {
    const { title, scoring, notes } = req.body || {};

    const patch = {};
    if (title !== undefined) patch.title = String(title || "").trim();
    if (notes !== undefined) patch.notes = String(notes || "");
    if (scoring !== undefined) {
      if (scoring && typeof scoring !== "object") {
        return res.status(400).json({ error: "scoring inválido." });
      }
      patch.scoring = scoring || {};
    }

    const ev = await Evaluation.findByIdAndUpdate(req.params.id, patch, {
      new: true,
    }).lean();

    if (!ev) return res.status(404).json({ error: "Evaluación no encontrada." });
    return res.json({ item: ev });
  } catch (err) {
    console.error("PATCH /admin/evaluations/:id error:", err);
    return res.status(500).json({ error: "Error al actualizar evaluación." });
  }
});

/* =========================================================
   DELETE /admin/evaluations/:id (opcional)
========================================================= */
router.delete("/:id", protect, adminOnly, async (req, res) => {
  try {
    const ev = await Evaluation.findByIdAndDelete(req.params.id).lean();
    if (!ev) return res.status(404).json({ error: "Evaluación no encontrada." });
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/evaluations/:id error:", err);
    return res.status(500).json({ error: "Error al eliminar evaluación." });
  }
});

export default router;
