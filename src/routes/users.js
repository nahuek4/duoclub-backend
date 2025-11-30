// backend/src/routes/users.js
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import bcrypt from "bcryptjs";

import User from "../models/User.js";
import Appointment from "../models/Appointment.js";
import { protect } from "../middleware/auth.js";

import multer from "multer";

const router = express.Router();

/* ============================================
   CONFIGURACIÓN DE RUTAS / PATHS
   ============================================ */

// Resolver rutas correctamente en ESModules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carpeta de uploads (debe existir)
const uploadDir = path.join(__dirname, "..", "..", "uploads");

// Crear carpeta si no existe
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

/* ============================================
   CONFIGURACIÓN DE MULTER PARA SUBIR APTOS
   ============================================ */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".pdf";
    const base = "apto-" + req.params.id + "-" + Date.now();
    cb(null, base + ext);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
});

/* ============================================
   TODAS LAS RUTAS REQUIEREN ESTAR LOGUEADO
   ============================================ */
router.use(protect);

/* ============================================
   POST: CREAR USUARIO NUEVO (ADMIN)
   ============================================ */
router.post("/", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "No autorizado." });
    }

    const {
      name,
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

    if (!email) {
      return res.status(400).json({ error: "El email es obligatorio." });
    }

    const plainPassword =
      password && String(password).trim().length >= 4
        ? String(password).trim()
        : Math.random().toString(36).slice(2, 10);

    const hashed = await bcrypt.hash(plainPassword, 10);

    const user = await User.create({
      name: name || "",
      email: email.toLowerCase(),
      phone: phone || "",
      dni: dni || "",
      age: age ?? null,
      weight: weight ?? null,
      notes: notes || "",
      credits: credits ?? 0,
      role: role || "client",
      password: hashed,
      mustChangePassword: true,
      suspended: false,
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
      return res
        .status(400)
        .json({ error: "Ya existe un usuario con ese email." });
    }

    res.status(500).json({ error: "Error al crear usuario." });
  }
});

/* ============================================
   GET: LISTAR TODOS LOS USUARIOS (ADMIN)
   ============================================ */
router.get("/", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "Solo un admin puede ver usuarios." });
    }

    const list = await User.find().lean();
    res.json(list);
  } catch (err) {
    console.error("Error en GET /users:", err);
    res.status(500).json({ error: "Error al obtener usuarios." });
  }
});

/* ============================================
   GET UN USUARIO
   ============================================ */
router.get("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user.role !== "admin" && req.user._id.toString() !== id) {
      return res.status(403).json({
        error: "No tenés permiso para ver este usuario.",
      });
    }

    const u = await User.findById(id);
    if (!u) return res.status(404).json({ error: "Usuario no encontrado." });

    res.json(u);
  } catch (err) {
    console.error("Error en GET /users/:id:", err);
    res.status(500).json({ error: "Error interno." });
  }
});

/* ============================================
   PATCH EDITAR USUARIO
   ============================================ */
router.patch("/:id", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "No autorizado." });
    }

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
   DELETE ELIMINAR USUARIO
   ============================================ */
router.delete("/:id", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "No autorizado." });
    }

    const { id } = req.params;
    const u = await User.findByIdAndDelete(id);
    if (!u) return res.status(404).json({ error: "Usuario no encontrado." });

    res.json({ ok: true });
  } catch (err) {
    console.error("Error en DELETE /users/:id:", err);
    res.status(500).json({ error: "Error interno." });
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
   CRÉDITOS
   ============================================ */
async function updateCredits(req, res) {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "No autorizado." });
    }

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

router.patch("/:id/credits", updateCredits);
router.post("/:id/credits", updateCredits);

/* ============================================
   🚨 RESET PASSWORD (ADMIN)
   ============================================ */
router.post("/:id/reset-password", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "No autorizado." });
    }

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
   🚨 SUSPENDER / REACTIVAR USUARIO (ADMIN)
   PATCH /users/:id/suspend
   Body: { suspended: boolean }
   ============================================ */
router.patch("/:id/suspend", async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ error: "No autorizado." });
    }

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
   SUBIR APTO
   ============================================ */
router.post("/:id/apto", upload.single("apto"), async (req, res) => {
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
        const old = path.join(
          __dirname,
          "..",
          "..",
          user.aptoPath.replace(/^\//, "")
        );
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
   VER APTO
   ============================================ */
router.get("/:id/apto", async (req, res) => {
  try {
    const { id } = req.params;

    const isAdmin = req.user.role === "admin";
    const isSelf = req.user._id.toString() === id;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        error: "No autorizado.",
      });
    }

    const user = await User.findById(id);
    if (!user || !user.aptoPath) {
      return res.status(404).json({ error: "Apto no encontrado." });
    }

    const filePath = path.join(
      __dirname,
      "..",
      "..",
      user.aptoPath.replace(/^\//, "")
    );

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
      return res.status(403).json({
        error: "No autorizado.",
      });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (user.aptoPath) {
      try {
        const file = path.join(
          __dirname,
          "..",
          "..",
          user.aptoPath.replace(/^\//, "")
        );
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

export default router;
