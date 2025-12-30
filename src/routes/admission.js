import express from "express";
import crypto from "crypto";
import Admission from "../models/Admission.js";
import { protect, adminOnly } from "../middleware/auth.js";

const router = express.Router();

// ===============================
// PUBLIC: guardar step1
// ===============================
router.post("/step1", async (req, res) => {
  try {
    const payload = req.body || {};
    const publicId = crypto.randomBytes(10).toString("hex");

    const doc = await Admission.create({
      publicId,
      step1Completed: true,
      step1: payload,
      ip:
        req.headers["x-forwarded-for"]
          ?.toString()
          ?.split(",")[0]
          ?.trim() ||
        req.socket?.remoteAddress ||
        "",
      userAgent: req.headers["user-agent"] || "",
    });

    return res.status(201).json({
      ok: true,
      admissionId: doc._id,
      publicId: doc.publicId,
    });
  } catch (err) {
    console.error("POST /admission/step1 error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "No se pudo guardar el formulario." });
  }
});

// ===============================
// PUBLIC: guardar step2 (actualiza el doc creado en step1)
// ===============================
router.patch("/:id/step2", async (req, res) => {
  try {
    const payload = req.body || {};
    const { id } = req.params;

    const doc = await Admission.findByIdAndUpdate(
      id,
      { step2Completed: true, step2: payload },
      { new: true, runValidators: true }
    );

    if (!doc) return res.status(404).json({ ok: false, error: "No encontrado." });

    return res.json({
      ok: true,
      admissionId: doc._id,
      publicId: doc.publicId,
    });
  } catch (err) {
    console.error("PATCH /admission/:id/step2 error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "No se pudo guardar el paso 2." });
  }
});

// ===============================
// ADMIN: listar (✅ incluye nombre/email/tel)
// ===============================
router.get("/admin", protect, adminOnly, async (req, res) => {
  try {
    const items = await Admission.find({})
      .sort({ createdAt: -1 })
      .select(
        "publicId step1.fullName step1.email step1.phone step1Completed step2Completed createdAt"
      );

    return res.json({ ok: true, items });
  } catch (err) {
    console.error("GET /admission/admin error:", err);
    return res.status(500).json({ ok: false, error: "No se pudo listar." });
  }
});

// ===============================
// ADMIN: detalle
// ===============================
router.get("/admin/:id", protect, adminOnly, async (req, res) => {
  try {
    const doc = await Admission.findById(req.params.id);
    if (!doc) return res.status(404).json({ ok: false, error: "No encontrado." });

    return res.json({ ok: true, item: doc });
  } catch (err) {
    console.error("GET /admission/admin/:id error:", err);
    return res.status(500).json({ ok: false, error: "No se pudo abrir." });
  }
});

export default router;
