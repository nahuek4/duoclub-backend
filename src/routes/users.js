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

// ✅ MAIL
import { fireAndForget, sendUserApprovedEmail, sendUserApprovalResultEmail } from "../mail.js";

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
  const tier = String(m.tier || "").toLowerCase().trim(); // ✅ case-insensitive
  if (tier !== "plus") return false;
  if (!m.activeUntil) return false;
  return new Date(m.activeUntil) > new Date();
}

// ✅ NUEVO: BASIC=2 / PLUS=3
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
  const expireDaysDefault = plus ? 40 : 30;

  const tierNorm = String(m.tier || (plus ? "plus" : "basic"))
    .toLowerCase()
    .trim();

  return {
    tier: tierNorm || "basic",
    activeUntil: m.activeUntil || null,
    cancelHours: clamp(m.cancelHours ?? cancelHoursDefault, 1, 999),
    cancelsLeft: clamp(m.cancelsLeft ?? limit, 0, limit), // ✅ clamp 0..(2/3)
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
  const raw = lot?.serviceKey;
  const sk = String(raw || "").toUpperCase().trim();
  return sk || "ALL";
}

// ✅ servicios válidos (RF fuera)
const ALLOWED_SERVICE_KEYS = new Set(["ALL", "EP", "AR", "RA", "NUT"]);

/* ============================================
   ✅ Servicios disponibles (UI) desde creditLots
   - RF ELIMINADO
============================================ */

const SERVICE_KEY_TO_NAME = {
  EP: "Entrenamiento Personal",
  AR: "Alto Rendimiento",
  RA: "Rehabilitacion Activa",
  NUT: "Nutricion",
};

const ALL_UI_SERVICES = [
  "Entrenamiento Personal",
  "Alto Rendimiento",
  "Rehabilitacion Activa",
];

function computeServiceAccessFromLots(u) {
  const now = new Date();
  const lots = Array.isArray(u?.creditLots) ? u.creditLots : [];

  let universal = 0;
  const byKey = { EP: 0, AR: 0, RA: 0, NUT: 0 };

  for (const lot of lots) {
    const remaining = Number(lot?.remaining || 0);
    if (remaining <= 0) continue;

    const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) continue;

    const sk = String(lot?.serviceKey || "").toUpperCase().trim();

    if (sk === "ALL") {
      universal += remaining;
      continue;
    }

    // ✅ solo keys válidas (RF queda afuera)
    if (byKey[sk] !== undefined) byKey[sk] += remaining;
  }

  let allowedServices = [];

  if (universal > 0) {
    allowedServices = [...ALL_UI_SERVICES];
  } else {
    allowedServices = Object.entries(byKey)
      .filter(([k, v]) => v > 0 && SERVICE_KEY_TO_NAME[k])
      .map(([k]) => SERVICE_KEY_TO_NAME[k])
      .filter((name) => ALL_UI_SERVICES.includes(name));
  }

  const serviceCredits = {};
  for (const k of Object.keys(byKey)) {
    const name = SERVICE_KEY_TO_NAME[k];
    if (!name) continue;
    if (ALL_UI_SERVICES.includes(name) && byKey[k] > 0) {
      serviceCredits[name] = byKey[k];
    }
  }

  return {
    allowedServices,
    serviceCredits,
    universalCredits: universal,
  };
}

/* ============================================
   Créditos por servicio (ADMIN UI)
============================================ */

function sumCreditsForService(user, serviceKey) {
  const now = nowDate();
  const want = String(serviceKey || "ALL").toUpperCase().trim() || "ALL";
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];

  return lots.reduce((acc, lot) => {
    const exp = lot.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return acc;

    const lk = normalizeLotServiceKey(lot);
    const rem = Number(lot.remaining || 0);
    if (rem <= 0) return acc;

    if (want === "ALL") return acc + rem;
    if (lk === "ALL" || lk === want) return acc + rem;
    return acc;
  }, 0);
}

function consumeCreditsForService(user, toRemove, serviceKey) {
  const now = nowDate();
  let left = Math.max(0, Number(toRemove || 0));

  const want = String(serviceKey || "ALL").toUpperCase().trim() || "ALL";
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];

  const sorted = lots
    .filter((l) => Number(l.remaining || 0) > 0)
    .filter((l) => !l.expiresAt || new Date(l.expiresAt) > now)
    .filter((l) => {
      if (want === "ALL") return true;
      const lk = normalizeLotServiceKey(l);
      return lk === want || lk === "ALL";
    })
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

function buildCreditsByService(user) {
  return {
    EP: sumCreditsForService(user, "EP"),
    AR: sumCreditsForService(user, "AR"),
    RA: sumCreditsForService(user, "RA"),
    NUT: sumCreditsForService(user, "NUT"),
    ALL: sumCreditsForService(user, "ALL"),
  };
}

function stripSensitive(u) {
  if (!u || typeof u !== "object") return u;
  const { password, emailVerificationToken, emailVerificationExpires, __v, ...rest } = u;
  return rest;
}

/* ============================================
   TODAS LAS RUTAS REQUIEREN ESTAR LOGUEADO
============================================ */
router.use(protect);

// ============================================
// ✅ ADMIN - REGISTRACIONES PENDIENTES
// ============================================

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
    const { name, lastName, email, phone, dni, age, weight, notes, credits, role, password } =
      req.body || {};

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

      // ✅ NUEVO: ya lo aprobaste desde admin-create, mandamos mail 1 vez
      welcomeApprovedEmailSentAt: new Date(),
    });

    const initialCredits = Number(credits ?? 0);
    if (initialCredits > 0) {
      addCreditLot(user, { amount: initialCredits, serviceKey: "ALL", source: "admin-create" });
      await user.save();
    }

    // ✅ enviar mail de alta aprobada + password temporal (fire-and-forget)
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

    const uLean = (await User.findById(user._id).lean()) || user.toObject?.() || user;
    const svc = computeServiceAccessFromLots(uLean);
    const membership = normalizeMembershipForUI(uLean);

    res.status(201).json({
      ok: true,
      user: {
        ...stripSensitive(uLean),
        ...svc,
        membership,
      },
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

router.get("/", adminOnly, async (req, res) => {
  try {
    const list = await User.find().lean();
    res.json(list.map(stripSensitive));
  } catch (err) {
    console.error("Error en GET /users:", err);
    res.status(500).json({ error: "Error al obtener usuarios." });
  }
});

router.get("/pending", adminOnly, async (req, res) => {
  try {
    const pending = await User.find({ approvalStatus: "pending" })
      .sort({ createdAt: -1 })
      .lean();

    res.json(pending.map(stripSensitive));
  } catch (err) {
    console.error("Error en GET /users/pending:", err);
    res.status(500).json({ error: "Error al obtener pendientes." });
  }
});

/* =========================================================
   ✅ PATCH /users/:id/approval
   - Mantener "en espera hasta que admin apruebe"
   - Si aprueba: suspended=false
   - Si rechaza: suspended=true
   - No aprobar si NO verificó email
   - Mail al usuario aprobado/rechazado (+ link a DUO) — 1 sola vez
========================================================= */
router.patch("/:id/approval", adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const status = String(req.body?.status || "").toLowerCase().trim();

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Estado inválido." });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    // ✅ regla: NO aprobar si no verificó email
    if (status === "approved" && !user.emailVerified) {
      return res.status(400).json({
        error: "No se puede aprobar: el email no está verificado.",
      });
    }

    const prevStatus = String(user.approvalStatus || "pending");

    // =========================================================
    // ✅ CASO RECHAZADO -> BORRAR CUENTA
    // - mandamos mail de rechazo (si corresponde)
    // - borramos el usuario
    // - así puede registrarse de nuevo con el mismo email
    // =========================================================
    if (status === "rejected") {
      const to = String(user.email || "").trim();

      // mandamos mail solo si hay email y si no estaba ya rechazado
      const shouldSendRejectionMail = !!to && prevStatus !== "rejected";

      if (shouldSendRejectionMail) {
        fireAndForget(
          () => sendUserApprovalResultEmail(user, "rejected"),
          "MAIL_REJECT_AND_DELETE"
        );
      }

      // ✅ BORRADO DEFINITIVO
      // (Opcional) también borramos turnos asociados por limpieza
      await Appointment.deleteMany({ user: user._id });
      await user.deleteOne();

      return res.json({
        ok: true,
        deleted: true,
        message: "Usuario rechazado y eliminado. Puede registrarse nuevamente.",
      });
    }

    // =========================================================
    // ✅ CASO APROBADO -> activar + mail 1 sola vez
    // =========================================================
    user.approvalStatus = "approved";
    user.suspended = false;

    const changed = prevStatus !== "approved";

    const shouldSendApprovalMail =
      changed &&
      !!String(user.email || "").trim() &&
      !user.welcomeApprovedEmailSentAt;

    if (shouldSendApprovalMail) {
      user.welcomeApprovedEmailSentAt = new Date();
    }

    await user.save();

    if (shouldSendApprovalMail) {
      fireAndForget(() => sendUserApprovalResultEmail(user, "approved"), "MAIL_APPROVED_WEB");
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
    const lastName = typeof req.body?.lastName === "string" ? req.body.lastName.trim() : undefined;
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

    const svc = computeServiceAccessFromLots(u);
    const membership = normalizeMembershipForUI(u);

    if (!isAdmin) {
      // eslint-disable-next-line no-unused-vars
      const { clinicalNotes, ...safeUser } = stripSensitive(u);
      return res.json({ ...safeUser, ...svc, membership });
    }

    const creditsByService = buildCreditsByService(u);

    return res.json({
      ...stripSensitive(u),
      ...svc,
      membership,
      creditsByService,
    });
  } catch (err) {
    console.error("Error en GET /users/:id:", err);
    res.status(500).json({ error: "Error interno." });
  }
});

router.patch("/:id", adminOnly, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};

    const u = await User.findByIdAndUpdate(id, updates, { new: true }).lean();
    if (!u) return res.status(404).json({ error: "Usuario no encontrado." });

    const svc = computeServiceAccessFromLots(u);
    const membership = normalizeMembershipForUI(u);

    res.json({ ...stripSensitive(u), ...svc, membership });
  } catch (err) {
    console.error("Error en PATCH /users/:id:", err);
    res.status(500).json({ error: "Error interno." });
  }
});

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
   CRÉDITOS (ADMIN) ✅ POR SERVICIO (creditLots)
============================================ */
async function updateCredits(req, res) {
  try {
    const { id } = req.params;
    const { credits, delta, serviceKey, items, source } = req.body || {};

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    const applyOne = ({ credits: c, delta: d, serviceKey: skRaw, source: src }) => {
      const sk = String(skRaw || "ALL").toUpperCase().trim() || "ALL";
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

        if (diff > 0) {
          addCreditLot(user, { amount: diff, serviceKey: sk, source: src || "admin-set" });
        } else if (diff < 0) {
          consumeCreditsForService(user, Math.abs(diff), sk);
        }
        return;
      }

      if (typeof d === "number") {
        const dd = Math.round(d);

        if (dd > 0) {
          addCreditLot(user, { amount: dd, serviceKey: sk, source: src || "admin-delta" });
        } else if (dd < 0) {
          consumeCreditsForService(user, Math.abs(dd), sk);
        }
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
      applyOne({
        credits,
        delta,
        serviceKey,
        source: source || "admin-single",
      });
    }

    recalcUserCredits(user);
    await user.save();

    const creditsByService = buildCreditsByService(user);
    const svc = computeServiceAccessFromLots(user);
    const membership = normalizeMembershipForUI(user);

    res.json({
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
    res.status(status).json({ error: err?.message || "Error interno." });
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
   SUSPENDER / REACTIVAR (ADMIN)
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
