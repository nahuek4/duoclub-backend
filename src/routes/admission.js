// backend/src/routes/admission.js
import express from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import Admission from "../models/Admission.js";
import User from "../models/User.js";
import { protect, adminOnly } from "../middleware/auth.js";

import {
  fireAndForget,
  sendAdminAdmissionCompletedEmail,
  sendUserAdmissionReceivedEmail,
} from "../mail.js";
import { logActivity, buildUserSubject } from "../lib/activityLogger.js";

const router = express.Router();

/* =========================================================
   HELPERS (mapping admission -> user)
========================================================= */

function splitFullName(fullName) {
  const clean = String(fullName || "")
    .trim()
    .replace(/\s+/g, " ");
  if (!clean) return { name: "", lastName: "" };
  const parts = clean.split(" ");
  if (parts.length === 1) return { name: parts[0], lastName: "-" };
  return {
    name: parts.slice(0, -1).join(" "),
    lastName: parts.slice(-1).join(" "),
  };
}

function toNumberOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function computeAgeFromBirth(step1) {
  const d = Number(step1?.birthDay);
  const m = Number(step1?.birthMonth);
  const y = Number(step1?.birthYear);
  if (!d || !m || !y) return null;

  const birth = new Date(y, m - 1, d);
  if (Number.isNaN(birth.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const mm = now.getMonth() - birth.getMonth();
  if (mm < 0 || (mm === 0 && now.getDate() < birth.getDate())) age--;

  return age > 0 && age < 120 ? age : null;
}

function buildNotesFromAdmission(step1 = {}, step2 = {}) {
  const lines = [];

  if (step1.fitnessLevel) lines.push(`Fitness: ${step1.fitnessLevel}`);

  if (step1.hasContraindication) {
    lines.push(
      step1.hasContraindication === "SI"
        ? `Contraindicación: SI (${step1.contraindicationDetail || "-"})`
        : `Contraindicación: ${step1.hasContraindication}`
    );
  }

  if (step1.hasCondition) {
    lines.push(
      step1.hasCondition === "SI"
        ? `Condición: SI (${step1.conditionDetail || "-"})`
        : `Condición: ${step1.hasCondition}`
    );
  }

  if (step1.hadInjuryLastYear) {
    lines.push(
      step1.hadInjuryLastYear === "SI"
        ? `Lesión último año: SI (${step1.injuryDetail || "-"})`
        : `Lesión último año: ${step1.hadInjuryLastYear}`
    );
  }

  if (step1.diabetes) {
    lines.push(
      step1.diabetes === "SI"
        ? `Diabetes: SI (${step1.diabetesType || "-"})`
        : `Diabetes: ${step1.diabetes}`
    );
  }

  if (step1.bloodPressure) lines.push(`Presión arterial: ${step1.bloodPressure}`);

  if (step1.smokes) {
    lines.push(
      step1.smokes === "SI"
        ? `Fuma: SI (${step1.cigarettesPerDay || "-"} cig/día)`
        : `Fuma: ${step1.smokes}`
    );
  }

  if (step1.heartProblems) {
    lines.push(
      step1.heartProblems === "SI"
        ? `Cardíaco: SI (${step1.heartDetail || "-"})`
        : `Cardíaco: ${step1.heartProblems}`
    );
  }

  if (step1.orthoProblem) {
    lines.push(
      step1.orthoProblem === "SI"
        ? `Ortopédico: SI (${step1.orthoDetail || "-"})`
        : `Ortopédico: ${step1.orthoProblem}`
    );
  }

  if (step1.pregnant) {
    lines.push(
      step1.pregnant === "SI"
        ? `Embarazo: SI (${step1.pregnantWeeks || "-"} semanas)`
        : `Embarazo: ${step1.pregnant}`
    );
  }

  if (step1.lastBloodTest) lines.push(`Último análisis: ${step1.lastBloodTest}`);
  if (step1.relevantInfo) lines.push(`Info relevante: ${step1.relevantInfo}`);

  // Step2
  if (step2?.needsRehab) lines.push(`Rehab: ${step2.needsRehab}`);
  if (step2?.symptoms) lines.push(`Síntomas: ${step2.symptoms}`);
  if (step2?.immediateGoal) lines.push(`Objetivo: ${step2.immediateGoal}`);
  if (step2?.modality) lines.push(`Modalidad: ${step2.modality}`);
  if (step2?.weeklySessions) lines.push(`Sesiones/sem: ${step2.weeklySessions}`);

  return lines.filter(Boolean).join("\n");
}

function mapAdmissionToUserUpdate(adm) {
  const s1 = adm.step1 || {};
  const s2 = adm.step2 || {};

  const { name, lastName } = splitFullName(s1.fullName);

  const age = computeAgeFromBirth(s1);
  const weight = toNumberOrNull(s1.weight);

  const update = {
    name: name || undefined,
    lastName: lastName || undefined,
    phone: String(s1.phone || "").trim() || undefined,

    // ⚠️ no tocamos email por seguridad acá
    age: age ?? null,
    weight: weight ?? null,
    notes: buildNotesFromAdmission(s1, s2) || "",
  };

  Object.keys(update).forEach((k) => update[k] === undefined && delete update[k]);
  return update;
}

function getClientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.toString()?.split(",")[0]?.trim() ||
    req.socket?.remoteAddress ||
    ""
  );
}

function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}

/* =========================================================
   PUBLIC: guardar step1 (ANTI DUPLICADOS por email)
   - Si existe el email con step2Completed=true -> 409
   - Si existe el email con step2Completed=false -> REUSA ese registro (no crea otro)
========================================================= */
router.post("/step1", async (req, res) => {
  try {
    const payload = req.body || {};
    const email = normEmail(payload?.email);

    if (!email) {
      return res.status(400).json({ ok: false, error: "Email requerido." });
    }

    // Guardar email normalizado en step1
    payload.email = email;

    // Buscar la última admisión por email
    const existing = await Admission.findOne({ "step1.email": email }).sort({ createdAt: -1 });

    // Ya enviada -> bloquear (esto evita que te llenen la tabla)
    if (existing?.step2Completed) {
      return res.status(409).json({
        ok: false,
        error: "Este formulario ya fue enviado anteriormente.",
        code: "ADMISSION_ALREADY_SUBMITTED",
      });
    }

    // En progreso -> reusar
    if (existing && !existing.step2Completed) {
      existing.step1Completed = true;
      existing.step1 = { ...(existing.step1 || {}), ...payload };
      existing.ip = getClientIp(req);
      existing.userAgent = req.headers["user-agent"] || "";
      await existing.save();

      return res.status(200).json({
        ok: true,
        admissionId: existing._id,
        publicId: existing.publicId,
        reused: true,
      });
    }

    // No existe -> crear nueva
    const publicId = crypto.randomBytes(10).toString("hex");

    const doc = await Admission.create({
      publicId,
      step1Completed: true,
      step1: payload,
      ip: getClientIp(req),
      userAgent: req.headers["user-agent"] || "",
    });

    return res.status(201).json({
      ok: true,
      admissionId: doc._id,
      publicId: doc.publicId,
      reused: false,
    });
  } catch (err) {
    console.error("POST /admission/step1 error:", err);
    return res.status(500).json({ ok: false, error: "No se pudo guardar el formulario." });
  }
});

/* =========================================================
   PUBLIC: guardar step2 + mails (admin + user) UNA SOLA VEZ
   ✅ FIX: Step2 idempotente (si ya estaba completo -> 409)
   ✅ FIX: step2EmailSent solo se marca si el envío salió OK
========================================================= */
router.patch("/:id/step2", async (req, res) => {
  try {
    const payload = req.body || {};
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ ok: false, error: "ID inválido." });
    }

    // ✅ Idempotencia real: SOLO completar si aún NO estaba completo
    const doc = await Admission.findOneAndUpdate(
      { _id: id, step2Completed: { $ne: true } },
      { $set: { step2Completed: true, step2: payload } },
      { new: true }
    );

    // Si no actualizó es porque ya estaba completado (o no existe)
    if (!doc) {
      // ver si existe para diferenciar 404 vs 409
      const exists = await Admission.findById(id).select("_id").lean();
      if (!exists) return res.status(404).json({ ok: false, error: "No encontrado." });

      return res.status(409).json({
        ok: false,
        error: "Este formulario ya fue enviado anteriormente.",
        code: "ADMISSION_ALREADY_SUBMITTED",
      });
    }

    // Si por algún motivo ya estaba marcado mails enviados, no reintentar
    if (doc.step2EmailSent) {
      return res.json({
        ok: true,
        admissionId: doc._id,
        publicId: doc.publicId,
        mailsSent: false,
        reason: "already_sent",
      });
    }

    // Intento async: si falla, NO dejamos el flag trabado
    fireAndForget(async () => {
      const s1 = doc.step1 || {};
      const fullName = String(s1.fullName || "").trim();
      const { name, lastName } = splitFullName(fullName);

      const pseudoUser = {
        name: name || "",
        lastName: lastName || "",
        fullName,
        email: String(s1.email || "").trim(),
        phone: String(s1.phone || "").trim(),
      };

      console.log("[MAIL][ADM] step2 attempt ->", {
        admissionId: String(doc._id),
        publicId: doc.publicId,
        adminTo: process.env.ADMIN_EMAIL,
        userTo: pseudoUser.email,
      });

      try {
        await sendAdminAdmissionCompletedEmail(doc, pseudoUser);
        await sendUserAdmissionReceivedEmail(doc, pseudoUser);

        await Admission.updateOne(
          { _id: doc._id, step2EmailSent: false },
          { $set: { step2EmailSent: true, step2EmailSentAt: new Date() } }
        );

        console.log("[MAIL][ADM] step2 mails SENT ok", {
          admissionId: String(doc._id),
          publicId: doc.publicId,
        });
      } catch (e) {
        await Admission.updateOne(
          { _id: doc._id },
          { $set: { step2EmailSent: false, step2EmailSentAt: null } }
        );

        console.log("[MAIL][ADM] step2 mails FAILED", e?.message || e);
      }
    }, "ADMISSION_STEP2_MAIL");

    return res.json({
      ok: true,
      admissionId: doc._id,
      publicId: doc.publicId,
      mailsSent: true, // “se intentó”
    });
  } catch (err) {
    console.error("PATCH /admission/:id/step2 error:", err);
    return res.status(500).json({ ok: false, error: "No se pudo guardar el paso 2." });
  }
});

/* =========================================================
   ADMIN: listar
========================================================= */
router.get("/admin", protect, adminOnly, async (req, res) => {
  try {
    const items = await Admission.find({})
      .sort({ createdAt: -1 })
      .select(
        [
          "publicId",
          "user",
          "syncedToUser",
          "syncedAt",
          "step1.fullName",
          "step1.email",
          "step1.phone",
          "step1.city",
          "step1.cityOther",
          "step1Completed",
          "step2Completed",
          "step2EmailSent",
          "step2EmailSentAt",
          "createdAt",
        ].join(" ")
      )
      .lean();

    return res.json({ ok: true, items });
  } catch (err) {
    console.error("GET /admission/admin error:", err);
    return res.status(500).json({ ok: false, error: "No se pudo listar." });
  }
});

/* =========================================================
   ADMIN: detalle
========================================================= */
router.get("/admin/:id", protect, adminOnly, async (req, res) => {
  try {
    const doc = await Admission.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ ok: false, error: "No encontrado." });

    return res.json({ ok: true, item: doc });
  } catch (err) {
    console.error("GET /admission/admin/:id error:", err);
    return res.status(500).json({ ok: false, error: "No se pudo abrir." });
  }
});

/* =========================================================
   ADMIN: crear/vincular usuario desde admisión + sync perfil
========================================================= */
router.post("/admin/:id/create-user", protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const adm = await Admission.findById(id);
    if (!adm) return res.status(404).json({ ok: false, error: "Admisión no encontrada." });

    const s1 = adm.step1 || {};
    const fullName = String(s1.fullName || "").trim();
    const email = String(s1.email || "").trim().toLowerCase();
    const phone = String(s1.phone || "").trim();

    if (!fullName) return res.status(400).json({ ok: false, error: "La admisión no tiene nombre completo." });
    if (!email) return res.status(400).json({ ok: false, error: "La admisión no tiene email." });
    if (!phone) return res.status(400).json({ ok: false, error: "La admisión no tiene teléfono." });

    // 1) buscar user existente (primero por adm.user, si no por email)
    let user = null;
    if (adm.user) user = await User.findById(adm.user);
    if (!user) user = await User.findOne({ email });

    let created = false;
    let tempPassword = "";

    // 2) si no existe user => crearlo
    if (!user) {
      const { name, lastName } = splitFullName(fullName);

      tempPassword = Math.random().toString(36).slice(2, 10);
      const hashed = await bcrypt.hash(tempPassword, 10);

      user = await User.create({
        name: name || "SinNombre",
        lastName: lastName || "-",
        email,
        phone,

        dni: "",
        age: computeAgeFromBirth(s1),
        weight: toNumberOrNull(s1.weight),
        notes: "",
        credits: 0,
        role: "client",

        password: hashed,
        mustChangePassword: true,

        suspended: false,
        emailVerified: true,
        approvalStatus: "approved",

        aptoPath: "",
        aptoStatus: "",
      });

      created = true;
    }

    // 3) sync perfil con datos del formulario (NO toca email)
    const update = mapAdmissionToUserUpdate(adm);

    const updatedUser = await User.findByIdAndUpdate(user._id, update, {
      new: true,
      runValidators: true,
    }).lean();

    // 4) vincular admisión a user + marcar sync
    adm.user = user._id;
    adm.syncedToUser = true;
    adm.syncedAt = new Date();
    await adm.save();

    await logActivity({
      req,
      category: "admissions",
      action: created ? "admission_user_created" : "admission_user_synced",
      entity: "admission",
      entityId: adm._id,
      title: created ? "Usuario creado desde admisión" : "Admisión sincronizada",
      description: created ? "Se creó un usuario desde una admisión." : "Se vinculó/sincronizó la admisión con un usuario existente.",
      subject: buildUserSubject(updatedUser),
      meta: { admissionId: adm._id, userId: updatedUser?._id || user._id },
    });

    return res.json({
      ok: true,
      created,
      tempPassword: created ? tempPassword : undefined,
      user: updatedUser,
      admissionId: adm._id,
    });
  } catch (err) {
    console.error("POST /admission/admin/:id/create-user error:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* =========================================================
   ADMIN: vincular usuario existente por email
========================================================= */
router.post("/admin/:id/link-user", protect, adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const email = String(req.body?.email || "").trim().toLowerCase();

    if (!email) return res.status(400).json({ ok: false, error: "Email es requerido." });

    const adm = await Admission.findById(id);
    if (!adm) return res.status(404).json({ ok: false, error: "Admisión no encontrada." });

    const user = await User.findOne({ email }).lean();
    if (!user) return res.status(404).json({ ok: false, error: "No existe usuario con ese email." });

    const update = mapAdmissionToUserUpdate(adm);
    const updatedUser = await User.findByIdAndUpdate(user._id, update, {
      new: true,
      runValidators: true,
    }).lean();

    adm.user = user._id;
    adm.syncedToUser = true;
    adm.syncedAt = new Date();
    await adm.save();

    await logActivity({
      req,
      category: "admissions",
      action: "admission_user_linked",
      entity: "admission",
      entityId: adm._id,
      title: "Admisión vinculada",
      description: "Se vinculó una admisión a un usuario existente.",
      subject: buildUserSubject(updatedUser),
      meta: { admissionId: adm._id, userId: updatedUser?._id || user._id },
    });

    return res.json({ ok: true, user: updatedUser, admissionId: adm._id });
  } catch (err) {
    console.error("POST /admission/admin/:id/link-user error:", err);
    return res.status(500).json({ ok: false, error: "Error interno." });
  }
});

/* =========================================================
   ADMIN: eliminar admisión
========================================================= */
router.delete("/admin/:id", protect, adminOnly, async (req, res) => {
  try {
    const doc = await Admission.findById(req.params.id);
    if (!doc) return res.status(404).json({ ok: false, error: "No encontrado." });

    await logActivity({
      req,
      category: "admissions",
      action: "admission_deleted",
      entity: "admission",
      entityId: doc._id,
      title: "Admisión eliminada",
      description: "Se eliminó una admisión desde admin.",
      meta: { admissionId: doc._id, linkedUserId: doc.user || "" },
      deletedSnapshot: doc.toObject(),
    });

    await doc.deleteOne();
    return res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /admission/admin/:id error:", err);
    return res.status(500).json({ ok: false, error: "No se pudo eliminar la admisión." });
  }
});

export default router;
