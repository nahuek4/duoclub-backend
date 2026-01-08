// backend/src/routes/adminEvaluations.js
import express from "express";
import mongoose from "mongoose";
import crypto from "crypto";
import bcrypt from "bcryptjs";

import User from "../models/User.js";
import Evaluation from "../models/Evaluation.js";
import { protect, adminOnly } from "../middleware/auth.js";

const router = express.Router();

/* =========================
   HELPERS
========================= */
function safeInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function cleanStr(v) {
  return String(v || "").trim();
}

function titleCaseName(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function toIdString(v) {
  try {
    return String(v);
  } catch {
    return "";
  }
}

function serializeUserLite(u) {
  if (!u) return null;
  return {
    id: toIdString(u._id),
    _id: u._id,
    name: u.name || "",
    lastName: u.lastName || "",
    email: u.email || "",
    phone: u.phone || "",
    suspended: !!u.suspended,
    approvalStatus: u.approvalStatus || "",
    createdAt: u.createdAt || null,
    role: u.role || "",
  };
}

function serializeEvalLite(e) {
  if (!e) return null;
  return {
    id: toIdString(e._id),
    _id: e._id,
    type: e.type || "",
    title: e.title || "",
    notes: e.notes || "",
    scoring: e.scoring || {},
    createdBy: e.createdBy,
    createdAt: e.createdAt || null,
    updatedAt: e.updatedAt || null,
    user: e.user,
  };
}

/* =========================================================
   GET /admin/evaluations/users
========================================================= */
router.get("/users", protect, adminOnly, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const page = Math.max(1, safeInt(req.query.page, 1));
    const limit = Math.min(200, Math.max(5, safeInt(req.query.limit, 50)));
    const skip = (page - 1) * limit;

    const query = { role: "client" };

    if (q) {
      query.$or = [
        { name: new RegExp(q, "i") },
        { lastName: new RegExp(q, "i") },
        { email: new RegExp(q, "i") },
        { phone: new RegExp(q, "i") },
      ];
    }

    const [total, usersRaw] = await Promise.all([
      User.countDocuments(query),
      User.find(query)
        .select("name lastName email phone suspended approvalStatus createdAt role")
        .sort({ lastName: 1, name: 1 })
        .skip(skip)
        .limit(limit)
        .lean(),
    ]);

    const users = (usersRaw || []).map(serializeUserLite);
    const userIds = (usersRaw || []).map((u) => u._id);

    const stats = await Evaluation.aggregate([
      { $match: { user: { $in: userIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$user",
          count: { $sum: 1 },
          lastAt: { $first: "$createdAt" },
          lastType: { $first: "$type" },
          lastTitle: { $first: "$title" },
          lastEvalId: { $first: "$_id" },
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
        lastEvalTitle: s?.lastTitle || "",
        lastEvalId: s?.lastEvalId ? String(s.lastEvalId) : "",
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
   GET /admin/evaluations/guests
========================================================= */
router.get("/guests", protect, adminOnly, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const limit = Math.min(500, Math.max(1, safeInt(req.query.limit, 200)));

    const query = { role: "guest" };

    if (q) {
      query.$or = [
        { name: new RegExp(q, "i") },
        { lastName: new RegExp(q, "i") },
        { email: new RegExp(q, "i") },
        { phone: new RegExp(q, "i") },
      ];
    }

    const guestsRaw = await User.find(query)
      .select("name lastName email phone suspended approvalStatus createdAt role")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const guests = (guestsRaw || []).map(serializeUserLite);
    const guestIds = (guestsRaw || []).map((u) => u._id);

    const stats = await Evaluation.aggregate([
      { $match: { user: { $in: guestIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$user",
          count: { $sum: 1 },
          lastAt: { $first: "$createdAt" },
          lastType: { $first: "$type" },
          lastTitle: { $first: "$title" },
          lastEvalId: { $first: "$_id" },
        },
      },
    ]);

    const statsMap = new Map(stats.map((s) => [String(s._id), s]));

    const items = guests.map((u) => {
      const s = statsMap.get(String(u._id));
      return {
        ...u,
        evalCount: s?.count || 0,
        lastEvalAt: s?.lastAt || null,
        lastEvalType: s?.lastType || "",
        lastEvalTitle: s?.lastTitle || "",
        lastEvalId: s?.lastEvalId ? String(s.lastEvalId) : "",
      };
    });

    return res.json({ items });
  } catch (err) {
    console.error("GET /admin/evaluations/guests error:", err);
    return res.status(500).json({ error: "Error al listar invitados." });
  }
});

/* =========================================================
   POST /admin/evaluations/guest
========================================================= */
router.post("/guest", protect, adminOnly, async (req, res) => {
  try {
    const name = titleCaseName(cleanStr(req.body?.name));
    const lastName = titleCaseName(cleanStr(req.body?.lastName));
    const emailRaw = cleanStr(req.body?.email);
    const phoneRaw = cleanStr(req.body?.phone);

    if (!name || !lastName) {
      return res.status(400).json({ error: "name y lastName son requeridos." });
    }

    const email = emailRaw ? emailRaw.toLowerCase() : "";

    if (email) {
      const exists = await User.findOne({ email }).select("_id").lean();
      if (exists) {
        return res.status(409).json({ error: "Ese email ya existe." });
      }
    }

    const rawPassword = crypto.randomBytes(24).toString("hex");
    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    const guest = await User.create({
      name,
      lastName,
      email,
      phone: phoneRaw || "",
      role: "guest",
      password: hashedPassword,
      mustChangePassword: true,
      suspended: true,
      emailVerified: false,
      approvalStatus: "approved",
    });

    const item = {
      ...serializeUserLite(guest.toObject()),
      evalCount: 0,
      lastEvalAt: null,
      lastEvalType: "",
      lastEvalTitle: "",
      lastEvalId: "",
    };

    return res.status(201).json({ item });
  } catch (err) {
    console.error("POST /admin/evaluations/guest error:", err);
    return res.status(500).json({ error: "Error al crear invitado." });
  }
});

/* =========================================================
   DELETE /admin/evaluations/guest/:id
========================================================= */
router.delete("/guest/:id", protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "id inválido." });
    }

    const guest = await User.findById(id).select("_id role").lean();
    if (!guest) return res.status(404).json({ error: "Invitado no encontrado." });

    if (guest.role !== "guest") {
      return res.status(400).json({
        error: "Solo se pueden eliminar usuarios guest desde esta ruta.",
      });
    }

    await Promise.all([Evaluation.deleteMany({ user: id }), User.findByIdAndDelete(id)]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/evaluations/guest/:id error:", err);
    return res.status(500).json({ error: "Error al eliminar invitado." });
  }
});

/* =========================================================
   GET /admin/evaluations/user/:userId
========================================================= */
router.get("/user/:userId", protect, adminOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(200, Math.max(1, safeInt(req.query.limit, 50)));

    if (!isValidObjectId(userId)) {
      return res.status(400).json({ error: "userId inválido." });
    }

    const docs = await Evaluation.find({ user: userId })
      .select("type title notes createdBy createdAt updatedAt scoring")
      .populate("createdBy", "name lastName email")
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const items = (docs || []).map(serializeEvalLite).filter(Boolean);
    return res.json({ items });
  } catch (err) {
    console.error("GET /admin/evaluations/user/:userId error:", err);
    return res.status(500).json({ error: "Error al traer historial." });
  }
});

/* =========================================================
   POST /admin/evaluations/user/:userId
========================================================= */
router.post("/user/:userId", protect, adminOnly, async (req, res) => {
  try {
    const { userId } = req.params;
    const { type, title = "", scoring = {}, notes = "" } = req.body || {};

    if (!isValidObjectId(userId)) {
      return res.status(400).json({ error: "userId inválido." });
    }

    if (!type || typeof type !== "string") {
      return res.status(400).json({ error: "type es requerido." });
    }

    if (scoring && typeof scoring !== "object") {
      return res.status(400).json({ error: "scoring inválido." });
    }

    const target = await User.findById(userId).select("_id role").lean();
    if (!target) return res.status(404).json({ error: "Usuario no encontrado." });

    const ev = await Evaluation.create({
      user: userId,
      type: String(type).toUpperCase().trim(),
      title: String(title || "").trim(),
      scoring: scoring || {},
      notes: String(notes || ""),
      createdBy: req.user._id,
    });

    return res.status(201).json({ item: serializeEvalLite(ev.toObject()) });
  } catch (err) {
    console.error("POST /admin/evaluations/user/:userId error:", err);
    return res.status(500).json({ error: "Error al crear evaluación." });
  }
});

/* =========================================================
   GET /admin/evaluations/:id
   ✅ SOLO evaluationId (SIN FALLBACK)
========================================================= */
router.get("/:id", protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "id inválido." });
    }

    const ev = await Evaluation.findById(id)
      .populate("user", "name lastName email phone role")
      .populate("createdBy", "name lastName email")
      .lean();

    if (!ev) return res.status(404).json({ error: "Evaluación no encontrada." });

    return res.json({
      item: {
        ...serializeEvalLite(ev),
        user: ev.user,
        createdBy: ev.createdBy,
        resolvedFrom: "evaluationId",
      },
    });
  } catch (err) {
    console.error("GET /admin/evaluations/:id error:", err);
    return res.status(500).json({ error: "Error al traer evaluación." });
  }
});

/* =========================================================
   PATCH /admin/evaluations/:id
========================================================= */
router.patch("/:id", protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, scoring, notes } = req.body || {};

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "id inválido." });
    }

    const patch = {};
    if (title !== undefined) patch.title = String(title || "").trim();
    if (notes !== undefined) patch.notes = String(notes || "");

    if (scoring !== undefined) {
      if (scoring && typeof scoring !== "object") {
        return res.status(400).json({ error: "scoring inválido." });
      }
      patch.scoring = scoring || {};
    }

    const ev = await Evaluation.findByIdAndUpdate(id, patch, { new: true }).lean();
    if (!ev) return res.status(404).json({ error: "Evaluación no encontrada." });

    return res.json({ item: serializeEvalLite(ev) });
  } catch (err) {
    console.error("PATCH /admin/evaluations/:id error:", err);
    return res.status(500).json({ error: "Error al actualizar evaluación." });
  }
});

/* =========================================================
   DELETE /admin/evaluations/:id
========================================================= */
router.delete("/:id", protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).json({ error: "id inválido." });
    }

    const ev = await Evaluation.findByIdAndDelete(id).lean();
    if (!ev) return res.status(404).json({ error: "Evaluación no encontrada." });

    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admin/evaluations/:id error:", err);
    return res.status(500).json({ error: "Error al eliminar evaluación." });
  }
});

export default router;
