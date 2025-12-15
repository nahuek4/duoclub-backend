// backend/src/routes/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";
import { sendMail } from "../mail.js";

const router = express.Router();

function signToken(user) {
  return jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: "30d" });
}

function serializeUser(u) {
  if (!u) return null;
  return {
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    role: u.role,
    credits: u.credits,
    suspended: u.suspended,
    mustChangePassword: u.mustChangePassword,
    aptoStatus: u.aptoStatus || "",
    emailVerified: !!u.emailVerified,
    approvalStatus: u.approvalStatus || "pending",
  };
}

function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

/**
 * POST /auth/login
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email y password son obligatorios." });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.status(401).json({ error: "Email o contraseña incorrectos." });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Email o contraseña incorrectos." });

    if (user.suspended) {
      return res.status(403).json({ error: "Cuenta suspendida. Contactá al administrador." });
    }

    if (!user.emailVerified) {
      return res.status(403).json({ error: "Tenés que verificar tu email antes de iniciar sesión." });
    }

    if (user.approvalStatus === "pending") {
      return res.status(403).json({
        error: "Tu cuenta está pendiente de aprobación por el administrador.",
      });
    }
    if (user.approvalStatus === "rejected") {
      return res.status(403).json({ error: "Tu cuenta fue rechazada. Contactá al administrador." });
    }

    const token = signToken(user);
    return res.json({ token, user: serializeUser(user) });
  } catch (err) {
    console.error("Error en POST /auth/login:", err);
    return res.status(500).json({ error: "Error al iniciar sesión." });
  }
});

/**
 * POST /auth/register
 * body: { name, email, password }
 */
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: "Nombre, email y contraseña son obligatorios." });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres." });
    }

    const emailLower = String(email).toLowerCase();
    const exists = await User.findOne({ email: emailLower });
    if (exists) {
      return res.status(409).json({ error: "Ya existe una cuenta con ese email." });
    }

    const hashedPass = await bcrypt.hash(password, 10);

    // ✅ token crudo para enviar por email
    const rawToken = crypto.randomBytes(32).toString("hex");
    // ✅ hash para guardar en DB
    const tokenHash = sha256(rawToken);

    const user = await User.create({
      name,
      email: emailLower,
      password: hashedPass,
      role: "client",

      // ✅ quedan “bloqueados” hasta verificación + aprobación
      suspended: true,
      approvalStatus: "pending",
      emailVerified: false,

      emailVerificationToken: tokenHash,
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24hs
    });

    const frontend = process.env.FRONTEND_URL || "https://duoclub.ar";
    const verifyUrl = `${frontend}/verificar-email?token=${rawToken}`;

    await sendMail(
      user.email,
      "Verificá tu email - DUO",
      `Hola ${user.name},

Gracias por registrarte en DUO.

Para continuar, verificá tu email haciendo click en este link:

${verifyUrl}

Este link vence en 24 horas.`
    );

    return res.status(201).json({
      ok: true,
      message: "Registro exitoso. Te enviamos un email para verificar tu cuenta.",
    });
  } catch (err) {
    console.error("Error en /auth/register:", err);
    return res.status(500).json({ error: "Error al registrarse." });
  }
});

/**
 * GET /auth/verify-email?token=...
 */
router.get("/verify-email", async (req, res) => {
  try {
    const rawToken = String(req.query.token || "");
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

    user.emailVerified = true;
    user.emailVerificationToken = "";
    user.emailVerificationExpires = null;

    // ✅ ahora sí está verificado, pero sigue pendiente de aprobación
    // (no lo des-suspendemos hasta que el admin lo apruebe)
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

/**
 * POST /auth/resend-verification
 * body: { email }
 */
router.post("/resend-verification", async (req, res) => {
  try {
    const { email } = req.body || {};
    const emailLower = String(email || "").toLowerCase();
    if (!emailLower) return res.status(400).json({ error: "Email requerido." });

    const user = await User.findOne({ email: emailLower });
    if (!user) {
      // no revelamos existencia
      return res.json({ ok: true, message: "Si el email existe, te enviamos un correo." });
    }

    if (user.emailVerified) {
      return res.json({ ok: true, message: "Tu email ya está verificado." });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = sha256(rawToken);

    user.emailVerificationToken = tokenHash;
    user.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();

    const frontend = process.env.FRONTEND_URL || "https://duoclub.ar";
    const verifyUrl = `${frontend}/verificar-email?token=${rawToken}`;

    await sendMail(
      user.email,
      "Verificá tu email - DUO",
      `Hola ${user.name},

Te reenviamos el link de verificación:

${verifyUrl}

Este link vence en 24 horas.`
    );

    return res.json({ ok: true, message: "Te reenviamos el correo de verificación." });
  } catch (err) {
    console.error("Error resend-verification:", err);
    return res.status(500).json({ error: "No se pudo reenviar el correo." });
  }
});

/**
 * GET /auth/me
 */
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

/**
 * POST /auth/change-password
 */
router.post("/change-password", protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Debés enviar contraseña actual y nueva." });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ error: "Usuario no encontrado." });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) return res.status(401).json({ error: "Contraseña actual incorrecta." });

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.mustChangePassword = false;
    await user.save();

    return res.json({ ok: true, message: "Contraseña actualizada correctamente." });
  } catch (err) {
    console.error("Error en POST /auth/change-password:", err);
    return res.status(500).json({ error: "Error al cambiar la contraseña." });
  }
});

/**
 * POST /auth/force-change-password
 */
router.post("/force-change-password", protect, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword) return res.status(400).json({ error: "Debés enviar la nueva contraseña." });

    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ error: "Usuario no encontrado." });

    if (!user.mustChangePassword) {
      return res.status(400).json({
        error: "Este usuario no requiere restablecer la contraseña de forma obligatoria.",
      });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.mustChangePassword = false;
    await user.save();

    const token = signToken(user);
    return res.json({ ok: true, message: "Contraseña actualizada correctamente.", token, user: serializeUser(user) });
  } catch (err) {
    console.error("Error en POST /auth/force-change-password:", err);
    return res.status(500).json({ error: "Error al restablecer la contraseña." });
  }
});

export default router;
