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
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".pdf";
    const base = "apto-" + req.params.id + "-" + Date.now();
    cb(null, base + ext);
  },
});

const uploadApto = multer({
  storage: aptoStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
});

/* ============================================
   MULTER PARA FOTO DE PACIENTE (AVATAR)
============================================ */

const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const base = "avatar-" + req.params.id + "-" + Date.now();
    cb(null, base + ext);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Solo se permiten archivos de imagen."));
    }
    cb(null, true);
  },
});

/* ============================================
   HELPERS: CREDIT LOTS (compatibles con appointments.js)
============================================ */

function nowDate() {
  return new Date();
}

function isPlusActive(user) {
  const m = user?.membership || {};
  if (String(m.tier) !== "plus") return false;
  if (!m.activeUntil) return false;
  return new Date(m.activeUntil) > new Date();
}

function recalcUserCredits(user) {
  const now = nowDate();
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];

  const sum = lots.reduce((acc, lot) => {
    const exp = lot.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return acc;
    return acc + Number(lot.remaining || 0);
  }, 0);

  user.credits = sum;
}

function addCreditLot(user, { amount, serviceKey = "ALL", source = "admin-adjust" }) {
  const now = nowDate();
  const days = isPlusActive(user) ? 40 : 30;

  const exp = new Date(now);
  exp.setDate(exp.getDate() + days);

  user.creditLots = user.creditLots || [];
  user.creditLots.push({
    serviceKey: String(serviceKey || "ALL").toUpperCase().trim(),
    amount: Number(amount || 0),
    remaining: Number(amount || 0),
    expiresAt: exp,
    source,
    orderId: null,
    createdAt: now,
  });

  recalcUserCredits(user);
}

function consumeCredits(user, toRemove) {
  const now = nowDate();
  let left = Math.max(0, Number(toRemove || 0));

  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
  const sorted = lots
    .filter((l) => Number(l.remaining || 0) > 0)
    .filter((l) => !l.expiresAt || new Date(l.expiresAt) > now)
    .sort((a, b) => {
      const ae = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
      const be = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
      if (ae !== be) return ae - be;
      const ac = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bc = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ac - bc;
    });

  for (const lot of sorted) {
    if (left <= 0) break;
    const take = Math.min(Number(lot.remaining || 0), left);
    lot.remaining = Number(lot.remaining || 0) - take;
    left -= take;
  }

  recalcUserCredits(user);
}

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

      // ✅ compat: si mandás credits, los convertimos en lots "ALL"
      credits: 0,
      creditLots: [],

      role: role || "client",
      password: hashed,
      mustChangePassword: true,

      suspended: false,
      emailVerified: true,
      approvalStatus: "approved",

      aptoPath: "",
      aptoStatus: "",
    });

    // ✅ si viene credits, los cargamos como lote
    const initialCredits = Number(credits ?? 0);
    if (initialCredits > 0) {
      addCreditLot(user, { amount: initialCredits, serviceKey: "ALL", source: "admin-create" });
      await user.save();
    }

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

    if (status === "approved" && !user.emailVerified) {
      return res.status(400).json({
        error: "No se puede aprobar: el email no está verificado.",
      });
    }

    user.approvalStatus = status;

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
   ✅ PUT: EDITAR DATOS BÁSICOS (SELF o ADMIN)
============================================ */
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const isAdmin = req.user.role === "admin";
    const isSelf = req.user._id.toString() === id;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        error: "No tenés permiso para editar este usuario.",
      });
    }

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : undefined;
    const lastName =
      typeof req.body?.lastName === "string" ? req.body.lastName.trim() : undefined;
    const phone = typeof req.body?.phone === "string" ? req.body.phone.trim() : undefined;
    const dni = typeof req.body?.dni === "string" ? req.body.dni.trim() : undefined;

    if (dni !== undefined && dni !== "" && !/^\d{6,10}$/.test(dni)) {
      return res.status(400).json({ error: "DNI inválido." });
    }

    const update = {};
    if (name !== undefined) update.name = name;
    if (lastName !== undefined) update.lastName = lastName;
    if (phone !== undefined) update.phone = phone;
    if (dni !== undefined) update.dni = dni;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "No hay campos para actualizar." });
    }

    const u = await User.findByIdAndUpdate(id, update, {
      new: true,
      runValidators: true,
    }).lean();

    if (!u) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!isAdmin) {
      // eslint-disable-next-line no-unused-vars
      const { clinicalNotes, ...safeUser } = u;
      return res.json(safeUser);
    }

    return res.json(u);
  } catch (err) {
    console.error("Error en PUT /users/:id:", err);
    return res.status(500).json({ error: "Error interno." });
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
   (ojo: esto permite tocar cualquier campo)
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
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

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
    if (!user) return res.status(404).json({ error: "Paciente no encontrado." });
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
    if (!user) return res.status(404).json({ error: "Paciente no encontrado." });

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
   CRÉDITOS (ADMIN) ✅ compatible con creditLots
   body:
   - { credits: number } => set absoluto
   - { delta: number }   => suma/resta
   opcional:
   - { serviceKey: "ALL" | "EP" | "AR" | "RA" | "NUT" }
============================================ */
async function updateCredits(req, res) {
  try {
    const { id } = req.params;
    const { credits, delta, serviceKey } = req.body || {};

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    // recalcular base
    recalcUserCredits(user);
    const current = Number(user.credits || 0);

    const sk = String(serviceKey || "ALL").toUpperCase().trim() || "ALL";

    if (typeof credits === "number") {
      const target = Math.max(0, Math.round(credits));
      const diff = target - current;

      if (diff > 0) addCreditLot(user, { amount: diff, serviceKey: sk, source: "admin-set" });
      else if (diff < 0) consumeCredits(user, Math.abs(diff));
    } else if (typeof delta === "number") {
      const d = Math.round(delta);

      if (d > 0) addCreditLot(user, { amount: d, serviceKey: sk, source: "admin-delta" });
      else if (d < 0) consumeCredits(user, Math.abs(d));
    } else {
      return res.status(400).json({ error: "Valor inválido." });
    }

    await user.save();
    res.json({ ok: true, credits: Number(user.credits || 0) });
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
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

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

    if (!isAdmin && !isSelf) return res.status(403).json({ error: "No autorizado." });

    const user = await User.findById(id);
    if (!user || !user.aptoPath) return res.status(404).json({ error: "Apto no encontrado." });

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

    if (!isAdmin && !isSelf) return res.status(403).json({ error: "No autorizado." });

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
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (user.photoPath) {
      try {
        const old = path.join(__dirname, "..", "..", user.photoPath.replace(/^\//, ""));
        if (fs.existsSync(old)) fs.unlinkSync(old);
      } catch {}
    }

    const relativePath = "/uploads/" + req.file.filename;
    user.photoPath = relativePath;
    await user.save();

    res.json({ ok: true, photoPath: user.photoPath });
  } catch (err) {
    console.error("Error en POST /users/:id/photo:", err);
    res.status(500).json({ error: "Error al subir foto del paciente." });
  }
});

export default router;
