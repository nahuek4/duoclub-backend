// backend/src/routes/users.js
import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import User from "../models/User.js";
import Appointment from "../models/Appointment.js";
import { protect, adminOnly, adminOrProfessor } from "../middleware/auth.js";

import multer from "multer";

// ✅ MAIL
import {
  fireAndForget,
  sendUserApprovedEmail,
  sendUserApprovalResultEmail,
} from "../mail.js";

const router = express.Router();

/* ============================================
   ✅ CONFIG GLOBAL: VENCIMIENTO CRÉDITOS
============================================ */
const CREDITS_EXPIRE_DAYS = 30;

/* ============================================
   PATHS
============================================ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ uploads root: backend/uploads
// backend/src/routes  -> backend/src -> backend/uploads
const uploadRoot = path.join(__dirname, "..", "..", "uploads");
const aptosDir = path.join(uploadRoot, "aptos");

if (!fs.existsSync(uploadRoot)) fs.mkdirSync(uploadRoot, { recursive: true });
if (!fs.existsSync(aptosDir)) fs.mkdirSync(aptosDir, { recursive: true });

function safeUnlink(absPath) {
  try {
    if (absPath && fs.existsSync(absPath)) fs.unlinkSync(absPath);
  } catch {
    // no-op (no queremos 500 por unlink)
  }
}

/**
 * ✅ Convierte un publicPath a una ruta absoluta real dentro de backend/uploads
 * Acepta:
 *  - "/uploads/file.jpg"
 *  - "/api/uploads/file.jpg"
 *  - "/uploads/aptos/file.pdf"
 *  - "/api/uploads/aptos/file.pdf"
 *  - también con query/hash: "/api/uploads/x.jpg?t=123"
 *
 * Importante:
 *  - limpia ?query y #hash
 *  - preserva subcarpetas dentro de uploads/
 *  - sanitiza cada segmento con path.basename (evita traversal)
 */
function absFromPublicUploadsPath(publicPath) {
  const raw = String(publicPath || "").trim();
  if (!raw) return "";

  const clean = raw.split("?")[0].split("#")[0]; // ✅ sin cache bust
  const parts = clean.split("/").filter(Boolean);

  // buscamos el segmento "uploads"
  const uploadsIdx = parts.findIndex((p) => p === "uploads");
  if (uploadsIdx === -1) {
    // fallback: solo filename
    const filename = path.basename(clean);
    return filename ? path.join(uploadRoot, filename) : "";
  }

  // todo lo que viene después de uploads/ (puede incluir subcarpetas)
  const relParts = parts.slice(uploadsIdx + 1);
  if (!relParts.length) return "";

  const safeParts = relParts.map((p) => path.basename(p)).filter(Boolean);
  if (!safeParts.length) return "";

  return path.join(uploadRoot, ...safeParts);
}

/* ============================================
   ✅ VALIDACIÓN ID (evita CastError -> 500)
============================================ */
function validateObjectIdParam(req, res, next) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(id || ""))) {
    return res.status(400).json({ error: "ID inválido." });
  }
  next();
}

/* ============================================
   MULTER APTOS (PDF) ✅ ROBUSTO
============================================ */
const aptoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, aptosDir), // ✅ aptos/
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".pdf";
    const base = "apto-" + req.params.id + "-" + Date.now();
    cb(null, base + ext);
  },
});

const uploadApto = multer({
  storage: aptoStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const nameOk = String(file.originalname || "")
      .toLowerCase()
      .endsWith(".pdf");
    const mimeOk =
      file.mimetype === "application/pdf" ||
      file.mimetype === "application/octet-stream";
    if (!nameOk && !mimeOk) return cb(new Error("Solo se permite PDF."));
    cb(null, true);
  },
});

function uploadAptoSingle(req, res, next) {
  const handler = uploadApto.single("apto");
  handler(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "El PDF supera el límite de 10MB." });
    }
    return res
      .status(400)
      .json({ error: err.message || "Error al subir el archivo." });
  });
}

/* ============================================
   MULTER AVATAR ✅ ROBUSTO
============================================ */
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadRoot),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const base = "avatar-" + req.params.id + "-" + Date.now();
    cb(null, base + ext);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const mt = String(file.mimetype || "");
    if (!mt.startsWith("image/"))
      return cb(new Error("Solo se permiten imágenes."));
    cb(null, true);
  },
});

function avatarUploadSingle(req, res, next) {
  const handler = avatarUpload.single("photo");
  handler(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res
        .status(400)
        .json({ error: "La imagen supera el límite de 5MB." });
    }
    return res
      .status(400)
      .json({ error: err.message || "Error al subir la imagen." });
  });
}

/* ============================================
   HELPERS: CREDIT LOTS (tu lógica original)
============================================ */
function nowDate() {
  return new Date();
}

function isPlusActive(user) {
  const m = user?.membership || {};
  const tier = String(m.tier || "").toLowerCase().trim();
  if (tier !== "plus") return false;
  if (!m.activeUntil) return false;
  return new Date(m.activeUntil) > new Date();
}

function getMonthlyCancelLimit(user) {
  return isPlusActive(user) ? 3 : 2;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(Math.max(x, min), max);
}

function normalizeMembershipForUI(user) {
  const m = user?.membership || {};
  const plus = isPlusActive(user);
  const limit = getMonthlyCancelLimit(user);

  const cancelHoursDefault = plus ? 12 : 24;
  const expireDaysDefault = CREDITS_EXPIRE_DAYS;

  const tierNorm = String(m.tier || (plus ? "plus" : "basic"))
    .toLowerCase()
    .trim();

  return {
    tier: tierNorm || "basic",
    activeUntil: m.activeUntil || null,
    cancelHours: clamp(m.cancelHours ?? cancelHoursDefault, 1, 999),
    cancelsLeft: clamp(m.cancelsLeft ?? limit, 0, limit),
    creditsExpireDays: clamp(m.creditsExpireDays ?? expireDaysDefault, 1, 999),
  };
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

function normalizeLotServiceKey(lot) {
  const sk = String(lot?.serviceKey || "").toUpperCase().trim();
  return sk || "EP";
}

const ALLOWED_SERVICE_KEYS = new Set(["EP", "RF", "RA", "NUT"]);

const SERVICE_KEY_TO_NAME = {
  EP: "Entrenamiento Personal",
  RF: "Reeducacion Funcional",
  RA: "Rehabilitacion Activa",
  NUT: "Nutricion",
};

function computeServiceAccessFromLots(u) {
  const now = new Date();
  const lots = Array.isArray(u?.creditLots) ? u.creditLots : [];
  const byKey = { EP: 0, RF: 0, RA: 0, NUT: 0 };

  for (const lot of lots) {
    const remaining = Number(lot?.remaining || 0);
    if (remaining <= 0) continue;

    const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) continue;

    const sk = String(lot?.serviceKey || "").toUpperCase().trim();
    if (byKey[sk] !== undefined) byKey[sk] += remaining;
  }

  const allowedServices = Object.entries(byKey)
    .filter(([, v]) => v > 0)
    .map(([k]) => SERVICE_KEY_TO_NAME[k])
    .filter(Boolean);

  const serviceCredits = {};
  for (const [k, v] of Object.entries(byKey)) {
    if (v > 0) serviceCredits[SERVICE_KEY_TO_NAME[k]] = v;
  }

  return { allowedServices, serviceCredits };
}

function sumCreditsForService(user, serviceKey) {
  const now = nowDate();
  const want = String(serviceKey || "EP").toUpperCase().trim() || "EP";
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];

  return lots.reduce((acc, lot) => {
    const exp = lot.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return acc;

    const lk = normalizeLotServiceKey(lot);
    const rem = Number(lot.remaining || 0);
    if (rem <= 0) return acc;

    if (lk === want) return acc + rem;
    return acc;
  }, 0);
}

function consumeCreditsForService(user, toRemove, serviceKey) {
  const now = nowDate();
  let left = Math.max(0, Number(toRemove || 0));

  const want = String(serviceKey || "EP").toUpperCase().trim() || "EP";
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];

  const sorted = lots
    .filter((l) => Number(l.remaining || 0) > 0)
    .filter((l) => !l.expiresAt || new Date(l.expiresAt) > now)
    .filter((l) => normalizeLotServiceKey(l) === want)
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

function addCreditLot(
  user,
  { amount, serviceKey = "EP", source = "admin-adjust" }
) {
  const now = nowDate();
  const exp = new Date(now);
  exp.setDate(exp.getDate() + CREDITS_EXPIRE_DAYS);

  const sk = String(serviceKey || "EP").toUpperCase().trim() || "EP";

  user.creditLots = user.creditLots || [];
  user.creditLots.push({
    serviceKey: sk,
    amount: Number(amount || 0),
    remaining: Number(amount || 0),
    expiresAt: exp,
    source,
    orderId: null,
    createdAt: now,
  });

  recalcUserCredits(user);
}

function buildCreditsByService(user) {
  return {
    EP: sumCreditsForService(user, "EP"),
    RF: sumCreditsForService(user, "RF"),
    RA: sumCreditsForService(user, "RA"),
    NUT: sumCreditsForService(user, "NUT"),
  };
}

function stripSensitive(u) {
  if (!u || typeof u !== "object") return u;
  const {
    password,
    emailVerificationToken,
    emailVerificationExpires,
    __v,
    ...rest
  } = u;
  return rest;
}

/* ============================================
   ✅ TODAS LAS RUTAS REQUIEREN LOGIN
============================================ */
router.use(protect);

/* ============================================
   ✅ ADMIN - REGISTRACIONES
============================================ */
router.get("/registrations/list", adminOnly, async (req, res) => {
  try {
    const status = String(req.query.status || "pending");
    const query = {};
    if (status === "pending") query.approvalStatus = "pending";
    if (status === "approved") query.approvalStatus = "approved";
    if (status === "rejected") query.approvalStatus = "rejected";
    const users = await User.find(query).sort({ createdAt: -1 }).lean();
    return res.json(users.map(stripSensitive));
  } catch (err) {
    console.error("Error en GET /users/registrations/list:", err);
    return res.status(500).json({ error: "Error al obtener registraciones." });
  }
});

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

      welcomeApprovedEmailSentAt: new Date(),
    });

    const initialCredits = Number(credits ?? 0);
    if (initialCredits > 0) {
      addCreditLot(user, {
        amount: initialCredits,
        serviceKey: "EP",
        source: "admin-create",
      });
      await user.save();
    }

    fireAndForget(
      async () => {
        await sendUserApprovedEmail({
          to: em,
          user: { name: n, lastName: ln, email: em },
          password: plainPassword,
        });
      },
      "MAIL_APPROVED_CREATE"
    );

    const uLean =
      (await User.findById(user._id).lean()) || user.toObject?.() || user;
    const svc = computeServiceAccessFromLots(uLean);
    const membership = normalizeMembershipForUI(uLean);

    return res.status(201).json({
      ok: true,
      user: { ...stripSensitive(uLean), ...svc, membership },
      tempPassword: password ? undefined : plainPassword,
    });
  } catch (err) {
    console.error("Error en POST /users:", err);
    if (err.code === 11000 && err.keyPattern?.email) {
      return res
        .status(400)
        .json({ error: "Ya existe un usuario con ese email." });
    }
    return res.status(500).json({ error: "Error al crear usuario." });
  }
});

router.get("/", adminOrProfessor, async (req, res) => {
  try {
    const list = await User.find().lean();
    return res.json(list.map(stripSensitive));
  } catch (err) {
    console.error("Error en GET /users:", err);
    return res.status(500).json({ error: "Error al obtener usuarios." });
  }
});

router.get("/pending", adminOnly, async (req, res) => {
  try {
    const pending = await User.find({ approvalStatus: "pending" })
      .sort({ createdAt: -1 })
      .lean();
    return res.json(pending.map(stripSensitive));
  } catch (err) {
    console.error("Error en GET /users/pending:", err);
    return res.status(500).json({ error: "Error al obtener pendientes." });
  }
});

router.patch("/:id/approval", adminOnly, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;
    const status = String(req.body?.status || "").toLowerCase().trim();

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Estado inválido." });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (status === "approved" && !user.emailVerified) {
      return res
        .status(400)
        .json({ error: "No se puede aprobar: el email no está verificado." });
    }

    const prevStatus = String(user.approvalStatus || "pending");

    if (status === "rejected") {
      const to = String(user.email || "").trim();
      const shouldSendRejectionMail = !!to && prevStatus !== "rejected";

      if (shouldSendRejectionMail) {
        fireAndForget(
          () => sendUserApprovalResultEmail(user, "rejected"),
          "MAIL_REJECT_AND_DELETE"
        );
      }

      await Appointment.deleteMany({ user: user._id });
      await user.deleteOne();

      return res.json({
        ok: true,
        deleted: true,
        message: "Usuario rechazado y eliminado. Puede registrarse nuevamente.",
      });
    }

    user.approvalStatus = "approved";
    user.suspended = false;

    const changed = prevStatus !== "approved";
    const shouldSendApprovalMail =
      changed &&
      !!String(user.email || "").trim() &&
      !user.welcomeApprovedEmailSentAt;

    if (shouldSendApprovalMail) user.welcomeApprovedEmailSentAt = new Date();

    await user.save();

    if (shouldSendApprovalMail) {
      fireAndForget(
        () => sendUserApprovalResultEmail(user, "approved"),
        "MAIL_APPROVED_WEB"
      );
    }

    return res.json({
      ok: true,
      approvalStatus: user.approvalStatus,
      suspended: user.suspended,
      emailVerified: user.emailVerified,
    });
  } catch (err) {
    console.error("Error en PATCH /users/:id/approval:", err);
    return res.status(500).json({ error: "Error al actualizar aprobación." });
  }
});

router.put("/:id", validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;

    const role = String(req.user?.role || "").toLowerCase();
    const isAdmin = role === "admin";
    const isProfessor = role === "profesor";
    const isStaff = isAdmin || isProfessor;
    const isSelf = req.user._id.toString() === id;

    if (!isStaff && !isSelf) {
      return res
        .status(403)
        .json({ error: "No tenés permiso para editar este usuario." });
    }

    const name =
      typeof req.body?.name === "string" ? req.body.name.trim() : undefined;
    const lastName =
      typeof req.body?.lastName === "string"
        ? req.body.lastName.trim()
        : undefined;
    const phone =
      typeof req.body?.phone === "string" ? req.body.phone.trim() : undefined;
    const dni =
      typeof req.body?.dni === "string" ? req.body.dni.trim() : undefined;

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

    const svc = computeServiceAccessFromLots(u);
    const membership = normalizeMembershipForUI(u);

    if (!isAdmin) {
      // eslint-disable-next-line no-unused-vars
      const { clinicalNotes, ...safeUser } = stripSensitive(u);
      return res.json({ ...safeUser, ...svc, membership });
    }

    const creditsByService = buildCreditsByService(u);
    return res.json({ ...stripSensitive(u), ...svc, membership, creditsByService });
  } catch (err) {
    console.error("Error en PUT /users/:id:", err);
    return res.status(500).json({ error: "Error interno." });
  }
});

router.get("/:id", validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;

    const role = String(req.user?.role || "").toLowerCase();
    const isAdmin = role === "admin";
    const isProfessor = role === "profesor";
    const isStaff = isAdmin || isProfessor;
    const isSelf = req.user._id.toString() === id;

    if (!isStaff && !isSelf) {
      return res
        .status(403)
        .json({ error: "No tenés permiso para ver este usuario." });
    }

    const u = await User.findById(id).lean();
    if (!u) return res.status(404).json({ error: "Usuario no encontrado." });

    const svc = computeServiceAccessFromLots(u);
    const membership = normalizeMembershipForUI(u);

    if (!isAdmin) {
      // eslint-disable-next-line no-unused-vars
      const { clinicalNotes, ...safeUser } = stripSensitive(u);
      return res.json({ ...safeUser, ...svc, membership });
    }

    const creditsByService = buildCreditsByService(u);
    return res.json({ ...stripSensitive(u), ...svc, membership, creditsByService });
  } catch (err) {
    console.error("Error en GET /users/:id:", err);
    return res.status(500).json({ error: "Error interno." });
  }
});

router.patch("/:id/role", adminOnly, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;
    const rawRole = String(req.body?.role || "").toLowerCase().trim();

    const nextRole =
      rawRole === "usuario"
        ? "client"
        : rawRole;

    if (!["admin", "profesor", "client"].includes(nextRole)) {
      return res.status(400).json({ error: "Rol inválido." });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    user.role = nextRole;
    await user.save();

    const saved = user.toObject();
    const svc = computeServiceAccessFromLots(saved);
    const membership = normalizeMembershipForUI(saved);
    const creditsByService = buildCreditsByService(saved);

    return res.json({
      ok: true,
      user: { ...stripSensitive(saved), ...svc, membership, creditsByService },
    });
  } catch (err) {
    console.error("Error en PATCH /users/:id/role:", err);
    return res.status(500).json({ error: "Error al actualizar rol." });
  }
});

router.patch("/:id", adminOnly, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};
    const u = await User.findByIdAndUpdate(id, updates, { new: true }).lean();
    if (!u) return res.status(404).json({ error: "Usuario no encontrado." });

    const svc = computeServiceAccessFromLots(u);
    const membership = normalizeMembershipForUI(u);

    return res.json({ ...stripSensitive(u), ...svc, membership });
  } catch (err) {
    console.error("Error en PATCH /users/:id:", err);
    return res.status(500).json({ error: "Error interno." });
  }
});

router.delete("/:id", adminOnly, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    await Appointment.deleteMany({ user: id });
    await user.deleteOne();

    return res.json({
      ok: true,
      message: "Usuario y turnos asociados eliminados correctamente.",
    });
  } catch (err) {
    console.error("Error en DELETE /users/:id:", err);
    return res
      .status(500)
      .json({ error: "Error al eliminar usuario y sus turnos." });
  }
});

router.get("/:id/history", validateObjectIdParam, async (req, res) => {
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

    return res.json(history);
  } catch (err) {
    console.error("Error en GET /users/:id/history:", err);
    return res.status(500).json({ error: "Error al obtener historial." });
  }
});

router.get("/:id/clinical-notes", adminOrProfessor, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id).lean();
    if (!user) return res.status(404).json({ error: "Paciente no encontrado." });
    return res.json(user.clinicalNotes || []);
  } catch (err) {
    console.error("Error en GET /users/:id/clinical-notes:", err);
    return res
      .status(500)
      .json({ error: "Error al obtener historia clínica." });
  }
});

router.post("/:id/clinical-notes", adminOrProfessor, validateObjectIdParam, async (req, res) => {
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
    return res.json({ ok: true, clinicalNotes: user.clinicalNotes });
  } catch (err) {
    console.error("Error en POST /users/:id/clinical-notes:", err);
    return res
      .status(500)
      .json({ error: "Error al guardar historia clínica." });
  }
});

/* ============================================
   ✅ CRÉDITOS (tu código original)
============================================ */
async function updateCredits(req, res) {
  try {
    const { id } = req.params;
    const { credits, delta, serviceKey, items, source } = req.body || {};

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    const applyOne = ({ credits: c, delta: d, serviceKey: skRaw, source: src }) => {
      const sk = String(skRaw || "EP").toUpperCase().trim() || "EP";
      if (!ALLOWED_SERVICE_KEYS.has(sk)) {
        const err = new Error("serviceKey inválido.");
        err.status = 400;
        throw err;
      }

      recalcUserCredits(user);
      const currentForService = sumCreditsForService(user, sk);

      if (typeof c === "number") {
        const target = Math.max(0, Math.round(c));
        const diff = target - currentForService;
        if (diff > 0)
          addCreditLot(user, { amount: diff, serviceKey: sk, source: src || "admin-set" });
        else if (diff < 0) consumeCreditsForService(user, Math.abs(diff), sk);
        return;
      }

      if (typeof d === "number") {
        const dd = Math.round(d);
        if (dd > 0)
          addCreditLot(user, { amount: dd, serviceKey: sk, source: src || "admin-delta" });
        else if (dd < 0) consumeCreditsForService(user, Math.abs(dd), sk);
        return;
      }

      const err = new Error("Valor inválido.");
      err.status = 400;
      throw err;
    };

    if (Array.isArray(items) && items.length > 0) {
      for (const it of items) {
        applyOne({
          credits: it?.credits,
          delta: it?.delta,
          serviceKey: it?.serviceKey,
          source: it?.source || source || "admin-batch",
        });
      }
    } else {
      applyOne({ credits, delta, serviceKey, source: source || "admin-single" });
    }

    recalcUserCredits(user);
    await user.save();

    const creditsByService = buildCreditsByService(user);
    const svc = computeServiceAccessFromLots(user);
    const membership = normalizeMembershipForUI(user);

    return res.json({
      ok: true,
      credits: Number(user.credits || 0),
      creditsByService,
      creditLots: user.creditLots || [],
      ...svc,
      membership,
    });
  } catch (err) {
    console.error("Error en créditos:", err);
    const status = err?.status || 500;
    return res.status(status).json({ error: err?.message || "Error interno." });
  }
}
router.patch("/:id/credits", adminOnly, validateObjectIdParam, updateCredits);
router.post("/:id/credits", adminOnly, validateObjectIdParam, updateCredits);

router.post("/:id/reset-password", adminOnly, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    const tempPassword = Math.random().toString(36).slice(2, 10);
    const hash = await bcrypt.hash(tempPassword, 10);

    user.password = hash;
    user.mustChangePassword = true;
    await user.save();

    return res.json({ ok: true, tempPassword });
  } catch (err) {
    console.error("Error en reset password:", err);
    return res.status(500).json({ error: "Error interno." });
  }
});

router.patch("/:id/suspend", adminOnly, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;
    const { suspended } = req.body || {};

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    user.suspended = !!suspended;
    await user.save();

    return res.json({ ok: true, suspended: user.suspended });
  } catch (err) {
    console.error("Error en PATCH /users/:id/suspend:", err);
    return res
      .status(500)
      .json({ error: "Error al cambiar estado de suspensión." });
  }
});

/* ============================================
   ✅ APTO: SUBIR / VER / BORRAR  (FIX SIN save())
============================================ */
router.post("/:id/apto", validateObjectIdParam, uploadAptoSingle, async (req, res) => {
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

    // 1) busco usuario (solo para saber si había un apto previo y borrarlo)
    const prevUser = await User.findById(id).lean();
    if (!prevUser) return res.status(404).json({ error: "Usuario no encontrado." });

    if (prevUser.aptoPath) {
      safeUnlink(absFromPublicUploadsPath(prevUser.aptoPath));
    }

    // 2) update atómico (NO dispara validation required de otros campos)
    const newPath = "/api/uploads/" + req.file.filename;

    await User.updateOne(
      { _id: id },
      { $set: { aptoPath: newPath, aptoStatus: "uploaded" } }
      // runValidators: false (por defecto) => NO valida lastName/phone faltantes
    );

    return res.json({
      ok: true,
      message: "Apto subido correctamente.",
      aptoPath: newPath,
    });
  } catch (err) {
    console.error("Error en POST /users/:id/apto:", err);
    return res.status(500).json({
      error: "Error al subir el apto.",
      detail: err?.message || String(err),
    });
  }
});

router.get("/:id/apto", validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;

    const role = String(req.user?.role || "").toLowerCase();
    const isStaff = role === "admin" || role === "profesor";
    const isSelf = req.user._id.toString() === id;
    if (!isStaff && !isSelf) return res.status(403).json({ error: "No autorizado." });

    const user = await User.findById(id).lean();
    if (!user || !user.aptoPath) return res.status(404).json({ error: "Apto no encontrado." });

    const abs = absFromPublicUploadsPath(user.aptoPath);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).json({ error: "El archivo no existe en el servidor." });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="apto.pdf"');
    return res.sendFile(abs);
  } catch (err) {
    console.error("Error en GET /users/:id/apto:", err);
    return res.status(500).json({ error: "Error al obtener apto." });
  }
});

router.delete("/:id/apto", validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;

    const isAdmin = req.user.role === "admin";
    const isSelf = req.user._id.toString() === id;
    if (!isAdmin && !isSelf) return res.status(403).json({ error: "No autorizado." });

    // 1) leo usuario para saber qué archivo borrar
    const prevUser = await User.findById(id).lean();
    if (!prevUser) return res.status(404).json({ error: "Usuario no encontrado." });

    if (prevUser.aptoPath) {
      safeUnlink(absFromPublicUploadsPath(prevUser.aptoPath));
    }

    // 2) update atómico (NO save)
    await User.updateOne(
      { _id: id },
      { $set: { aptoPath: "", aptoStatus: "" } }
    );

    return res.json({ ok: true, message: "Apto eliminado correctamente." });
  } catch (err) {
    console.error("Error en DELETE /users/:id/apto:", err);
    return res.status(500).json({
      error: "Error al borrar apto.",
      detail: err?.message || String(err),
    });
  }
});

/* ============================================
   ✅ FOTO (AVATAR) - SUBIR  (FIX SIN save())
============================================ */
router.post("/:id/photo", validateObjectIdParam, avatarUploadSingle, async (req, res) => {
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

    // 1) leo usuario para borrar foto previa
    const prevUser = await User.findById(id).lean();
    if (!prevUser) return res.status(404).json({ error: "Usuario no encontrado." });

    if (prevUser.photoPath) {
      safeUnlink(absFromPublicUploadsPath(prevUser.photoPath));
    }

    // 2) update atómico
    const newPath = "/api/uploads/" + req.file.filename;

    await User.updateOne({ _id: id }, { $set: { photoPath: newPath } });

    return res.json({ ok: true, photoPath: newPath });
  } catch (err) {
    console.error("Error en POST /users/:id/photo:", err);
    return res.status(500).json({
      error: "Error al subir foto del paciente.",
      detail: err?.message || String(err),
    });
  }
});

export default router;