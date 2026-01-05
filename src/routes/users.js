// backend/src/routes/users.js
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import bcrypt from "bcryptjs";

import User from "../models/User.js";
import Appointment from "../models/Appointment.js";
import { protect, adminOnly } from "../middleware/auth.js";

import multer from "multer";

const router = express.Router();

/* ============================================
   CONFIGURACIÓN DE RUTAS / PATHS
   ============================================ */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadDir = path.join(__dirname, "..", "..", "uploads");

if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/* ============================================
   MULTER PARA APTOS (PDF)
   ============================================ */

const aptoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".pdf";
    const base = "apto-" + req.params.id + "-" + Date.now();
    cb(null, base + ext);
  },
});

const uploadApto = multer({
  storage: aptoStorage,
  limits: {
    fileSize: 10 * 1024 * 1024,
  },
});

/* ============================================
   MULTER PARA FOTO DE PACIENTE (AVATAR)
   ============================================ */

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const base = "avatar-" + req.params.id + "-" + Date.now();
    cb(null, base + ext);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Solo se permiten archivos de imagen."));
    }
    cb(null, true);
  },
});

/* ============================================
   TODAS LAS RUTAS REQUIEREN ESTAR LOGUEADO
   ============================================ */
router.use(protect);

// ============================================
// ✅ ADMIN - REGISTRACIONES PENDIENTES
// ============================================

// GET /users/registrations/list?status=pending|approved|rejected
router.get("/registrations/list", adminOnly, async (req, res) => {
  try {
    const status = String(req.query.status || "pending");
    const query = {};

    if (status === "pending") query.approvalStatus = "pending";
    if (status === "approved") query.approvalStatus = "approved";
    if (status === "rejected") query.approvalStatus = "rejected";

    const users = await User.find(query).sort({ createdAt: -1 }).lean();
    return res.json(users);
  } catch (err) {
    console.error("Error en GET /users/registrations/list:", err);
    return res.status(500).json({ error: "Error al obtener registraciones." });
  }
});

/* ============================================
   POST: CREAR USUARIO NUEVO (ADMIN)
   ============================================ */
router.post("/", adminOnly, async (req, res) => {
  try {
    const {
      name,
      lastName,
      email,
      phone,
      dni,
      age,
      weight,
      notes,
      credits,
      role,
      password,
    } = req.body || {};

    const n = String(name || "").trim();
    const ln = String(lastName || "").trim();
    const em = String(email || "").trim().toLowerCase();
    const ph = String(phone || "").trim();

    if (!n || !ln || !em || !ph) {
      return res.status(400).json({
        error: "Nombre, apellido, teléfono y email son obligatorios.",
      });
    }

    const plainPassword =
      password && String(password).trim().length >= 4
        ? String(password).trim()
        : Math.random().toString(36).slice(2, 10);

    const hashed = await bcrypt.hash(plainPassword, 10);

    const user = await User.create({
      name: n,
      lastName: ln,
      email: em,
      phone: ph,
      dni: dni || "",
      age: age ?? null,
      weight: weight ?? null,
      notes: notes || "",
      credits: credits ?? 0,
      role: role || "client",
      password: hashed,
      mustChangePassword: true,

      // creados por admin: habilitados
      suspended: false,
      emailVerified: true,
      approvalStatus: "approved",

      aptoPath: "",
      aptoStatus: "",
    });

    res.status(201).json({
      ok: true,
      user,
      tempPassword: password ? undefined : plainPassword,
    });
  } catch (err) {
    console.error("Error en POST /users:", err);

    if (err.code === 11000 && err.keyPattern?.email) {
      return res.status(400).json({ error: "Ya existe un usuario con ese email." });
    }

    res.status(500).json({ error: "Error al crear usuario." });
  }
});

/* ============================================
   GET: LISTAR TODOS LOS USUARIOS (ADMIN)
   ============================================ */
router.get("/", adminOnly, async (req, res) => {
  try {
    const list = await User.find().lean();
    res.json(list);
  } catch (err) {
    console.error("Error en GET /users:", err);
    res.status(500).json({ error: "Error al obtener usuarios." });
  }
});

// ✅ LISTAR PENDIENTES (solo admin)
// GET /users/pending
router.get("/pending", adminOnly, async (req, res) => {
  try {
    const pending = await User.find({ approvalStatus: "pending" })
      .sort({ createdAt: -1 })
      .lean();

    res.json(pending);
  } catch (err) {
    console.error("Error en GET /users/pending:", err);
    res.status(500).json({ error: "Error al obtener pendientes." });
  }
});

// ✅ APROBAR / RECHAZAR (solo admin)
// PATCH /users/:id/approval  body: { status: "approved" | "rejected" }
router.patch("/:id/approval", adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    if (!["approved", "rejected"].includes(String(status))) {
      return res.status(400).json({ error: "Estado inválido." });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    // No aprobar si no verificó email
    if (status === "approved" && !user.emailVerified) {
      return res.status(400).json({
        error: "No se puede aprobar: el email no está verificado.",
      });
    }

    user.approvalStatus = status;

    // ✅ regla del sistema:
    // - approved => habilitado
    // - rejected => bloqueado
    if (status === "approved") user.suspended = false;
    if (status === "rejected") user.suspended = true;

    await user.save();

    res.json({
      ok: true,
      approvalStatus: user.approvalStatus,
      suspended: user.suspended,
      emailVerified: user.emailVerified,
    });
  } catch (err) {
    console.error("Error en PATCH /users/:id/approval:", err);
    res.status(500).json({ error: "Error al actualizar aprobación." });
  }
});

/* ============================================
   GET UN USUARIO
   ============================================ */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const isAdmin = req.user.role === "admin";
    const isSelf = req.user._id.toString() === id;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        error: "No tenés permiso para ver este usuario.",
      });
    }

    const u = await User.findById(id).lean();
    if (!u) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!isAdmin) {
      // eslint-disable-next-line no-unused-vars
      const { clinicalNotes, ...safeUser } = u;
      return res.json(safeUser);
    }

    res.json(u);
  } catch (err) {
    console.error("Error en GET /users/:id:", err);
    res.status(500).json({ error: "Error interno." });
  }
});

/* ============================================
   PATCH EDITAR USUARIO (ADMIN)
   ============================================ */
router.patch("/:id", adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};

    const u = await User.findByIdAndUpdate(id, updates, { new: true });
    if (!u) return res.status(404).json({ error: "Usuario no encontrado." });

    res.json(u);
  } catch (err) {
    console.error("Error en PATCH /users/:id:", err);
    res.status(500).json({ error: "Error interno." });
  }
});

/* ============================================
   DELETE ELIMINAR USUARIO + SUS TURNOS (ADMIN)
   ============================================ */
router.delete("/:id", adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    await Appointment.deleteMany({ user: id });
    await user.deleteOne();

    res.json({
      ok: true,
      message: "Usuario y turnos asociados eliminados correctamente.",
    });
  } catch (err) {
    console.error("Error en DELETE /users/:id:", err);
    res.status(500).json({ error: "Error al eliminar usuario y sus turnos." });
  }
});

/* ============================================
   HISTORIAL
   ============================================ */
router.get("/:id/history", async (req, res) => {
  try {
    const { id } = req.params;

    const isAdmin = req.user.role === "admin";
    const isSelf = req.user._id.toString() === id;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        error: "No tenés permisos para ver el historial de este usuario.",
      });
    }

    const appointments = await Appointment.find({ user: id })
      .sort({ createdAt: 1 })
      .lean();

    const history = appointments.map((ap) => ({
      date: ap.date,
      time: ap.time,
      service: ap.service,
      serviceName: ap.service,
      status: ap.status,
      action: ap.status,
      createdAt: ap.createdAt,
    }));

    res.json(history);
  } catch (err) {
    console.error("Error en GET /users/:id/history:", err);
    res.status(500).json({ error: "Error al obtener historial." });
  }
});

/* ============================================
   HISTORIA CLÍNICA (SOLO ADMIN)
   ============================================ */

router.get("/:id/clinical-notes", adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id).lean();
    if (!user) {
      return res.status(404).json({ error: "Paciente no encontrado." });
    }
    res.json(user.clinicalNotes || []);
  } catch (err) {
    console.error("Error en GET /users/:id/clinical-notes:", err);
    res.status(500).json({ error: "Error al obtener historia clínica." });
  }
});

router.post("/:id/clinical-notes", adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body || {};

    if (!text || !String(text).trim()) {
      return res.status(400).json({
        error: "El texto de la nota clínica es obligatorio.",
      });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: "Paciente no encontrado." });
    }

    user.clinicalNotes = user.clinicalNotes || [];
    user.clinicalNotes.push({
      date: new Date(),
      author: req.user.name || req.user.email || "Admin",
      text: String(text).trim(),
    });

    await user.save();

    res.json({ ok: true, clinicalNotes: user.clinicalNotes });
  } catch (err) {
    console.error("Error en POST /users/:id/clinical-notes:", err);
    res.status(500).json({ error: "Error al guardar historia clínica." });
  }
});

/* ============================================
   CRÉDITOS (ADMIN)
   ============================================ */
async function updateCredits(req, res) {
  try {
    const { id } = req.params;
    const { credits, delta } = req.body || {};

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (typeof credits === "number") {
      user.credits = credits;
    } else if (typeof delta === "number") {
      user.credits = (user.credits || 0) + delta;
    } else {
      return res.status(400).json({ error: "Valor inválido." });
    }

    await user.save();

    res.json({ ok: true, credits: user.credits });
  } catch (err) {
    console.error("Error en créditos:", err);
    res.status(500).json({ error: "Error interno." });
  }
}

router.patch("/:id/credits", adminOnly, updateCredits);
router.post("/:id/credits", adminOnly, updateCredits);

/* ============================================
   RESET PASSWORD (ADMIN)
   ============================================ */
router.post("/:id/reset-password", adminOnly, async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    const tempPassword = Math.random().toString(36).slice(2, 10);
    const hash = await bcrypt.hash(tempPassword, 10);

    user.password = hash;
    user.mustChangePassword = true;
    await user.save();

    res.json({ ok: true, tempPassword });
  } catch (err) {
    console.error("Error en reset password:", err);
    res.status(500).json({ error: "Error interno." });
  }
});

/* ============================================
   SUSPENDER / REACTIVAR USUARIO (ADMIN)
   ============================================ */
router.patch("/:id/suspend", adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const { suspended } = req.body || {};

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    user.suspended = !!suspended;
    await user.save();

    res.json({ ok: true, suspended: user.suspended });
  } catch (err) {
    console.error("Error en PATCH /users/:id/suspend:", err);
    res.status(500).json({ error: "Error al cambiar estado de suspensión." });
  }
});

/* ============================================
   SUBIR APTO (PDF)
   ============================================ */
router.post("/:id/apto", uploadApto.single("apto"), async (req, res) => {
  try {
    const { id } = req.params;

    const isAdmin = req.user.role === "admin";
    const isSelf = req.user._id.toString() === id;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        error: "No tenés permisos para subir el apto de este usuario.",
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ningún archivo." });
    }

    const relativePath = "/uploads/" + req.file.filename;

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (user.aptoPath) {
      try {
        const old = path.join(__dirname, "..", "..", user.aptoPath.replace(/^\//, ""));
        if (fs.existsSync(old)) fs.unlinkSync(old);
      } catch {}
    }

    user.aptoPath = relativePath;
    user.aptoStatus = "uploaded";
    await user.save();

    res.json({
      ok: true,
      message: "Apto subido correctamente.",
      aptoPath: user.aptoPath,
    });
  } catch (err) {
    console.error("Error en POST /users/:id/apto:", err);
    res.status(500).json({ error: "Error al subir el apto." });
  }
});

/* ============================================
   VER APTOS
   ============================================ */
router.get("/:id/apto", async (req, res) => {
  try {
    const { id } = req.params;

    const isAdmin = req.user.role === "admin";
    const isSelf = req.user._id.toString() === id;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({ error: "No autorizado." });
    }

    const user = await User.findById(id);
    if (!user || !user.aptoPath) {
      return res.status(404).json({ error: "Apto no encontrado." });
    }

    const filePath = path.join(__dirname, "..", "..", user.aptoPath.replace(/^\//, ""));
    res.sendFile(filePath);
  } catch (err) {
    console.error("Error en GET /users/:id/apto:", err);
    res.status(500).json({ error: "Error al obtener apto." });
  }
});

/* ============================================
   DELETE APTO
   ============================================ */
router.delete("/:id/apto", async (req, res) => {
  try {
    const { id } = req.params;

    const isAdmin = req.user.role === "admin";
    const isSelf = req.user._id.toString() === id;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({ error: "No autorizado." });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (user.aptoPath) {
      try {
        const file = path.join(__dirname, "..", "..", user.aptoPath.replace(/^\//, ""));
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {}
    }

    user.aptoPath = "";
    user.aptoStatus = "";
    await user.save();

    res.json({ ok: true, message: "Apto eliminado correctamente." });
  } catch (err) {
    console.error("Error en DELETE /users/:id/apto:", err);
    res.status(500).json({ error: "Error al borrar apto." });
  }
});

/* ============================================
   FOTO DEL PACIENTE (AVATAR)
   ============================================ */
router.post("/:id/photo", avatarUpload.single("photo"), async (req, res) => {
  try {
    const { id } = req.params;

    const isAdmin = req.user.role === "admin";
    const isSelf = req.user._id.toString() === id;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        error: "Solo el paciente o un admin pueden subir la foto.",
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ninguna imagen." });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    if (user.photoPath) {
      try {
        const old = path.join(__dirname, "..", "..", user.photoPath.replace(/^\//, ""));
        if (fs.existsSync(old)) fs.unlinkSync(old);
      } catch {}
    }

    const relativePath = "/uploads/" + req.file.filename;
    user.photoPath = relativePath;
    await user.save();

    res.json({
      ok: true,
      photoPath: user.photoPath,
    });
  } catch (err) {
    console.error("Error en POST /users/:id/photo:", err);
    res.status(500).json({ error: "Error al subir foto del paciente." });
  }
});

export default router;
