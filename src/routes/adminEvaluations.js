import express from "express";
import mongoose from "mongoose";
import { protect, adminOnly } from "../middleware/auth.js";
import User from "../models/User.js";
import Evaluation from "../models/Evaluation.js";

const router = express.Router();

// todo admin
router.use(protect, adminOnly);

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

/* =========================================
   GET /admin/evaluations/users
   Lista de clientes + info de última evaluación
   - Solo role=client
   - Ordenado alfabético
   - Incluye evalCount y lastEval (fecha/tipo)
   ========================================= */
router.get("/users", async (req, res) => {
  try {
    const users = await User.find({ role: "client" })
      .select("name lastName email phone role createdAt")
      .lean();

    const ids = users.map((u) => u._id);

    // Traemos última evaluación por usuario (bulk)
    const lastEvals = await Evaluation.aggregate([
      { $match: { user: { $in: ids } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$user",
          lastCreatedAt: { $first: "$createdAt" },
          lastType: { $first: "$type" },
          lastTitle: { $first: "$title" },
        },
      },
    ]);

    const counts = await Evaluation.aggregate([
      { $match: { user: { $in: ids } } },
      { $group: { _id: "$user", count: { $sum: 1 } } },
    ]);

    const mapLast = new Map(lastEvals.map((x) => [String(x._id), x]));
    const mapCount = new Map(counts.map((x) => [String(x._id), x.count]));

    // ordenar alfabético por "Apellido Nombre"
    const withMeta = users
      .map((u) => {
        const k = String(u._id);
        return {
          ...u,
          id: k,
          evalCount: mapCount.get(k) || 0,
          lastEvalAt: mapLast.get(k)?.lastCreatedAt || null,
          lastEvalType: mapLast.get(k)?.lastType || "",
          lastEvalTitle: mapLast.get(k)?.lastTitle || "",
        };
      })
      .sort((a, b) => {
        const an = `${a.lastName || ""} ${a.name || ""}`.trim().toLowerCase();
        const bn = `${b.lastName || ""} ${b.name || ""}`.trim().toLowerCase();
        return an.localeCompare(bn, "es");
      });

    return res.json(withMeta);
  } catch (err) {
    console.error("GET /admin/evaluations/users error:", err);
    return res.status(500).json({ error: "Error al listar usuarios para evaluar." });
  }
});

/* =========================================
   GET /admin/evaluations/user/:userId
   Historial de evaluaciones de un usuario
   ========================================= */
router.get("/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!isValidId(userId)) {
      return res.status(400).json({ error: "userId inválido." });
    }

    const items = await Evaluation.find({ user: userId })
      .sort({ createdAt: -1 })
      .select("type title createdAt notes")
      .lean();

    return res.json(items);
  } catch (err) {
    console.error("GET /admin/evaluations/user/:userId error:", err);
    return res.status(500).json({ error: "Error al obtener historial de evaluaciones." });
  }
});

/* =========================================
   POST /admin/evaluations/user/:userId
   Crear evaluación (SFMA etc)
   body: { type, title, scoring, notes }
   ========================================= */
router.post("/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    if (!isValidId(userId)) {
      return res.status(400).json({ error: "userId inválido." });
    }

    const { type, title, scoring, notes } = req.body || {};

    const t = String(type || "").trim().toUpperCase();
    if (!t) return res.status(400).json({ error: "type es obligatorio." });

    const user = await User.findById(userId).select("_id").lean();
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    const created = await Evaluation.create({
      user: userId,
      type: t,
      title: String(title || t),
      scoring: scoring || {},
      notes: String(notes || ""),
      createdBy: req.user?._id || null,
    });

    return res.status(201).json({ ok: true, item: created });
  } catch (err) {
    console.error("POST /admin/evaluations/user/:userId error:", err);
    return res.status(500).json({ error: "Error al guardar evaluación." });
  }
});

/* =========================================
   GET /admin/evaluations/:id
   Ver una evaluación específica (para el botón VER)
   ========================================= */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidId(id)) {
      return res.status(400).json({ error: "id inválido." });
    }

    const item = await Evaluation.findById(id)
      .populate("user", "name lastName email phone")
      .lean();

    if (!item) return res.status(404).json({ error: "Evaluación no encontrada." });

    return res.json({ ok: true, item });
  } catch (err) {
    console.error("GET /admin/evaluations/:id error:", err);
    return res.status(500).json({ error: "Error al obtener evaluación." });
  }
});

export default router;
