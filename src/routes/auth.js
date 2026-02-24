// backend/src/routes/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/User.js";
import Appointment from "../models/Appointment.js";
import { protect } from "../middleware/auth.js";

import {
  sendVerifyEmail,
  sendUserRegistrationReceivedEmail,
  sendAdminNewRegistrationEmail,
  sendUserApprovalResultEmail,
  fireAndForget,
} from "../mail.js";

const router = express.Router();

/* ============================================
   HELPERS
============================================ */

function signToken(user) {
  return jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
}

function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function normText(v) {
  return String(v || "").trim();
}

function normPhone(v) {
  return String(v || "")
    .trim()
    .replace(/[^\d+\s()-]/g, "");
}

// ✅ base URL del backend para armar links de aprobar/rechazar
function getBackendBase(req) {
  const env = String(process.env.BACKEND_URL || "").trim();
  if (env) return env.replace(/\/+$/, "");

  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "https")
    .toString()
    .split(",")[0]
    .trim();

  const host = (req.headers["x-forwarded-host"] || req.get("host") || "")
    .toString()
    .split(",")[0]
    .trim();

  return `${proto}://${host}`;
}

/* ============================================
   ✅ Servicios disponibles (UI) desde creditLots
============================================ */

const SERVICE_KEY_TO_NAME = {
  EP: "Entrenamiento Personal",
  RF: "Reeducacion Funcional",
  RA: "Rehabilitacion Activa",
  NUT: "Nutricion",
};

const SERVICE_KEYS = ["EP", "RF", "RA", "NUT"];

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

  // ✅ útil para UI / debug (por serviceKey)
  const creditsByServiceKey = { EP: 0, RF: 0, RA: 0, NUT: 0 };
  for (const k of SERVICE_KEYS) creditsByServiceKey[k] = Number(byKey[k] || 0);

  return { allowedServices, serviceCredits, creditsByServiceKey };
}

// ✅ recalcular cache credits desde lots (evita desync)
function recalcCreditsCache(u) {
  const now = new Date();
  const lots = Array.isArray(u?.creditLots) ? u.creditLots : [];
  const sum = lots.reduce((acc, lot) => {
    const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return acc;
    return acc + Number(lot?.remaining || 0);
  }, 0);
  u.credits = sum;
}

/* ============================================
   ✅ Membership helpers
============================================ */

function isPlusActive(u) {
  const m = u?.membership || {};
  const tier = String(m.tier || "").toLowerCase().trim();
  if (tier !== "plus") return false;
  if (!m.activeUntil) return false;
  return new Date(m.activeUntil) > new Date();
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(Math.max(x, min), max);
}

/* ============================================
   serializeUser
   ✅ IMPORTANTE: ahora incluye creditLots
============================================ */

function serializeUser(u) {
  if (!u) return null;

  // ✅ mantener credits coherente
  recalcCreditsCache(u);

  const m = u.membership || {};
  const svc = computeServiceAccessFromLots(u);

  const plus = isPlusActive(u);
  const creditsExpireDaysDefault = 30;

  const tierNorm = String(m.tier || (plus ? "plus" : "basic"))
    .toLowerCase()
    .trim();

  // ✅ sanitizar creditLots para UI (solo campos útiles)
  const creditLotsSafe = (Array.isArray(u.creditLots) ? u.creditLots : []).map((lot) => ({
    _id: lot?._id?.toString?.() || String(lot?._id || ""),
    serviceKey: String(lot?.serviceKey || "EP").toUpperCase().trim(),
    amount: Number(lot?.amount || 0),
    remaining: Number(lot?.remaining || 0),
    expiresAt: lot?.expiresAt || null,
    source: String(lot?.source || ""),
    orderId: lot?.orderId || null,
    createdAt: lot?.createdAt || null,
  }));

  return {
    id: u._id.toString(),
    name: u.name || "",
    lastName: u.lastName || "",
    email: u.email || "",
    phone: u.phone || "",
    dni: u.dni ?? "",

    role: u.role,
    credits: Number(u.credits || 0),

    suspended: !!u.suspended,
    mustChangePassword: !!u.mustChangePassword,

    // ✅ apto / foto
    aptoStatus: u.aptoStatus || "",
    aptoPath: u.aptoPath || "",
    photoPath: u.photoPath || "",

    emailVerified: !!u.emailVerified,
    approvalStatus: u.approvalStatus || "pending",
    createdAt: u.createdAt || null,

    // ✅ LO QUE USA EL FRONT PARA HABILITAR SERVICIOS
    creditLots: creditLotsSafe,

    // ✅ conveniencia para UI
    allowedServices: svc.allowedServices,
    serviceCredits: svc.serviceCredits,
    creditsByServiceKey: svc.creditsByServiceKey,

    membership: {
      tier: tierNorm || "basic",
      activeUntil: m.activeUntil || null,
      creditsExpireDays: clamp(m.creditsExpireDays ?? creditsExpireDaysDefault, 1, 999),
    },
  };
}

/* ============================================
   POST /auth/login
============================================ */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email y password son obligatorios." });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.status(401).json({ error: "Email o contraseña incorrectos." });

    if (String(user.role || "").toLowerCase() === "guest") {
      return res.status(403).json({ error: "Usuario invitado. Acceso no permitido." });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Email o contraseña incorrectos." });

    if (!user.emailVerified) {
      return res.status(403).json({ error: "Tenés que verificar tu email antes de iniciar sesión." });
    }

    if (user.approvalStatus === "pending") {
      return res.status(403).json({ error: "Tu cuenta está pendiente de aprobación por el administrador." });
    }

    if (user.approvalStatus === "rejected") {
      return res.status(403).json({ error: "Tu cuenta fue rechazada. Contactá al administrador." });
    }

    if (user.suspended) {
      return res.status(403).json({ error: "Cuenta suspendida. Contactá al administrador." });
    }

    const token = signToken(user);
    return res.json({ token, user: serializeUser(user) });
  } catch (err) {
    console.error("Error en POST /auth/login:", err);
    return res.status(500).json({ error: "Error al iniciar sesión." });
  }
});

/* ============================================
   POST /auth/register
============================================ */
router.post("/register", async (req, res) => {
  try {
    const { name, lastName, phone, email, password } = req.body || {};

    const n = normText(name);
    const ln = normText(lastName);
    const ph = normPhone(phone);
    const em = normText(email).toLowerCase();

    if (!n || !ln || !ph || !em || !password) {
      return res.status(400).json({
        error: "Nombre, apellido, teléfono, email y contraseña son obligatorios.",
      });
    }

    if (String(password).length < 8) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres." });
    }

    const exists = await User.findOne({ email: em });
    if (exists) return res.status(409).json({ error: "Ya existe una cuenta con ese email." });

    const hashedPass = await bcrypt.hash(password, 10);

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = sha256(rawToken);

    const user = await User.create({
      name: n,
      lastName: ln,
      phone: ph,

      email: em,
      password: hashedPass,
      role: "client",

      suspended: true,
      approvalStatus: "pending",
      emailVerified: false,

      credits: 0,
      creditLots: [],

      mustChangePassword: false,

      emailVerificationToken: tokenHash,
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const frontend = process.env.FRONTEND_URL || "https://duoclub.ar";
    const verifyUrl = `${frontend}/verificar-email?token=${rawToken}`;

    await sendVerifyEmail(user, verifyUrl);

    fireAndForget(() => sendUserRegistrationReceivedEmail(user), "MAIL_REGISTER_RECEIVED");

    const backendBase = getBackendBase(req);

    const approveToken = jwt.sign(
      { uid: user._id.toString(), action: "approved", kind: "admin_approval" },
      process.env.JWT_SECRET,
      { expiresIn: "14d" }
    );

    const rejectToken = jwt.sign(
      { uid: user._id.toString(), action: "rejected", kind: "admin_approval" },
      process.env.JWT_SECRET,
      { expiresIn: "14d" }
    );

    const approveUrl = `${backendBase}/auth/admin-approval?t=${encodeURIComponent(approveToken)}`;
    const rejectUrl = `${backendBase}/auth/admin-approval?t=${encodeURIComponent(rejectToken)}`;

    fireAndForget(
      () => sendAdminNewRegistrationEmail({ user, approveUrl, rejectUrl }),
      "MAIL_ADMIN_NEW_REGISTER"
    );

    return res.status(201).json({
      ok: true,
      message: "Registro exitoso. Te enviamos un email para verificar tu cuenta.",
    });
  } catch (err) {
    console.error("Error en /auth/register:", err);
    if (err?.code === 11000 && err?.keyPattern?.email) {
      return res.status(409).json({ error: "Ya existe una cuenta con ese email." });
    }
    return res.status(500).json({ error: "Error al registrarse." });
  }
});

/* ============================================
   POST /auth/force-change-password
============================================ */
router.post("/force-change-password", protect, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    const np = String(newPassword || "").trim();

    if (!np) return res.status(400).json({ error: "Ingresá una contraseña nueva." });
    if (np.length < 8) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres." });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (String(user.role || "").toLowerCase() === "guest") {
      return res.status(403).json({ error: "Acción no permitida para invitados." });
    }

    const same = await bcrypt.compare(np, user.password || "");
    if (same) {
      return res.status(400).json({ error: "La nueva contraseña no puede ser igual a la actual." });
    }

    user.password = await bcrypt.hash(np, 10);
    user.mustChangePassword = false;

    await user.save();
    return res.json({ ok: true });
  } catch (err) {
    console.error("Error en POST /auth/force-change-password:", err);
    return res.status(500).json({ error: "No se pudo actualizar la contraseña." });
  }
});

/* ============================================
   GET /auth/verify-email
============================================ */
router.get("/verify-email", async (req, res) => {
  try {
    const rawToken = String(req.query.token || "").trim();
    if (!rawToken) return res.status(400).json({ error: "Token inválido." });

    const tokenHash = sha256(rawToken);

    const user = await User.findOne({
      emailVerificationToken: tokenHash,
      emailVerificationExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({
        error: "Token inválido o expirado. Pedí un nuevo correo de verificación.",
      });
    }

    if (String(user.role || "").toLowerCase() === "guest") {
      return res.status(400).json({ error: "Usuario invitado inválido para verificación." });
    }

    user.emailVerified = true;
    user.emailVerificationToken = "";
    user.emailVerificationExpires = null;

    await user.save();

    return res.json({
      ok: true,
      message: "Email verificado correctamente. Tu cuenta será revisada por un administrador.",
    });
  } catch (err) {
    console.error("Error verify-email:", err);
    return res.status(500).json({ error: "Error al verificar email." });
  }
});

/* ============================================
   POST /auth/resend-verification
============================================ */
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body || {};
    const emailLower = String(email || "").toLowerCase().trim();
    if (!emailLower) return res.status(400).json({ error: "Email requerido." });

    const user = await User.findOne({ email: emailLower });

    if (!user) return res.json({ ok: true, message: "Si el email existe, te enviamos un correo." });

    if (String(user.role || "").toLowerCase() === "guest") {
      return res.json({ ok: true, message: "Si el email existe, te enviamos un correo." });
    }

    if (user.emailVerified) return res.json({ ok: true, message: "Tu email ya está verificado." });

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = sha256(rawToken);

    user.emailVerificationToken = tokenHash;
    user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    const frontend = process.env.FRONTEND_URL || "https://duoclub.ar";
    const verifyUrl = `${frontend}/verificar-email?token=${rawToken}`;

    await sendVerifyEmail(user, verifyUrl);

    return res.json({ ok: true, message: "Te reenviamos el correo de verificación." });
  } catch (err) {
    console.error("Error resend-verification:", err);
    return res.status(500).json({ error: "No se pudo reenviar el correo." });
  }
});

/* ============================================
   GET /auth/me
   ✅ ahora devuelve creditLots + creditsByServiceKey
============================================ */
router.get("/me", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ error: "Usuario no encontrado." });

    return res.json(serializeUser(user));
  } catch (err) {
    console.error("Error en GET /auth/me:", err);
    return res.status(500).json({ error: "Error al obtener el usuario." });
  }
});

/* ============================================
   ✅ GET /auth/admin-approval?t=TOKEN
============================================ */
router.get("/admin-approval", async (req, res) => {
  try {
    const t = String(req.query.t || "").trim();
    if (!t) return res.status(400).send("Token faltante.");

    let payload;
    try {
      payload = jwt.verify(t, process.env.JWT_SECRET);
    } catch {
      return res.status(400).send("Token inválido o expirado.");
    }

    if (payload?.kind !== "admin_approval") return res.status(400).send("Token inválido.");

    const uid = String(payload?.uid || "").trim();
    const action = String(payload?.action || "").toLowerCase().trim();

    if (!uid || !["approved", "rejected"].includes(action))
      return res.status(400).send("Token inválido.");

    const user = await User.findById(uid);
    if (!user) return res.status(404).send("Usuario no encontrado.");

    if (action === "approved" && !user.emailVerified) {
      return res.status(400).send("No se puede aprobar: el email no está verificado.");
    }

    const prev = String(user.approvalStatus || "pending");

    if (action === "rejected") {
      const to = String(user.email || "").trim();
      const shouldSend = !!to && prev !== "rejected";

      if (shouldSend) {
        fireAndForget(() => sendUserApprovalResultEmail(user, "rejected"), "MAIL_REJECT_FROM_LINK");
      }

      await Appointment.deleteMany({ user: user._id });
      await user.deleteOne();

      return res.send("✅ Usuario rechazado y eliminado. Puede registrarse nuevamente.");
    }

    user.approvalStatus = "approved";
    user.suspended = false;

    const changed = prev !== "approved";
    const shouldSendApprovalMail =
      changed && !!String(user.email || "").trim() && !user.welcomeApprovedEmailSentAt;

    if (shouldSendApprovalMail) user.welcomeApprovedEmailSentAt = new Date();

    await user.save();

    if (shouldSendApprovalMail) {
      fireAndForget(() => sendUserApprovalResultEmail(user, "approved"), "MAIL_APPROVE_FROM_LINK");
    }

    return res.send("✅ Usuario aprobado correctamente.");
  } catch (err) {
    console.error("Error en GET /auth/admin-approval:", err);
    return res.status(500).send("Error interno.");
  }
});

export default router;