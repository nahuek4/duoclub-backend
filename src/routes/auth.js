// backend/src/routes/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";

// ✅ antes: import { sendVerifyEmail } from "../mail.js";
import {
  sendVerifyEmail,
  sendUserRegistrationReceivedEmail,
  sendAdminNewRegistrationEmail,
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
  return String(v || "").trim().replace(/[^\d+\s()-]/g, "");
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
   Servicios oficiales:
   - EP  Entrenamiento Personal
   - RF  Reeducacion Funcional
   - RA  Rehabilitacion Activa
   - NUT Nutricion
============================================ */

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
    .map(([k]) => SERVICE_KEY_TO_NAME[k]);

  const serviceCredits = {};
  for (const [k, v] of Object.entries(byKey)) {
    if (v > 0) serviceCredits[SERVICE_KEY_TO_NAME[k]] = v;
  }

  return { allowedServices, serviceCredits };
}

/* ============================================
   ✅ Membership helpers (solo tier/activeUntil + vencimiento créditos)
   (sin cancelaciones)
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
============================================ */

function serializeUser(u) {
  if (!u) return null;

  const m = u.membership || {};
  const svc = computeServiceAccessFromLots(u);

  const plus = isPlusActive(u);
  const creditsExpireDaysDefault = plus ? 40 : 30;

  const tierNorm = String(m.tier || (plus ? "plus" : "basic"))
    .toLowerCase()
    .trim();

  return {
    id: u._id.toString(),
    name: u.name || "",
    lastName: u.lastName || "",
    email: u.email || "",
    phone: u.phone || "",
    role: u.role,
    credits: u.credits,
    suspended: u.suspended,
    mustChangePassword: u.mustChangePassword,
    aptoStatus: u.aptoStatus || "",
    photoPath: u.photoPath || "",
    emailVerified: !!u.emailVerified,
    approvalStatus: u.approvalStatus || "pending",
    createdAt: u.createdAt || null,

    allowedServices: svc.allowedServices,
    serviceCredits: svc.serviceCredits,
    universalCredits: svc.universalCredits,

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

      emailVerificationToken: tokenHash,
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const frontend = process.env.FRONTEND_URL || "https://duoclub.ar";
    const verifyUrl = `${frontend}/verificar-email?token=${rawToken}`;

    // ✅ mantenemos tu comportamiento (verificación inmediata)
    await sendVerifyEmail(user, verifyUrl);

    // ✅ NUEVO: mail al usuario “registro recibido / esperá aprobación”
    fireAndForget(() => sendUserRegistrationReceivedEmail(user), "MAIL_REGISTER_RECEIVED");

    // ✅ NUEVO: mail al admin con botones
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
    if (np.length < 8) return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres." });

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (String(user.role || "").toLowerCase() === "guest") {
      return res.status(403).json({ error: "Acción no permitida para invitados." });
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

export default router;
