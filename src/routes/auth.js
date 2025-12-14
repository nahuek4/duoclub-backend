// backend/src/routes/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";
import { sendVerifyEmail } from "../mail.js";

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

    // ✅ nuevos
    emailVerified: !!u.emailVerified,
    approvalStatus: u.approvalStatus || "pending",
  };
}

// helpers token
function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

/**
 * POST /auth/register
 * body: { name, email, password }
 */
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email y contraseña son obligatorios." });
    }

    if (String(password).trim().length < 6) {
      return res
        .status(400)
        .json({ error: "La contraseña debe tener al menos 6 caracteres." });
    }

    const exists = await User.findOne({ email: String(email).toLowerCase() });
    if (exists) {
      // no revelamos demasiado
      return res.status(400).json({ error: "No se pudo registrar el usuario." });
    }

    const hashedPass = await bcrypt.hash(String(password).trim(), 10);

    // token verificación
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = sha256(rawToken);
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24); // 24hs

    const user = await User.create({
      name: name || "",
      email: String(email).toLowerCase(),
      password: hashedPass,
      role: "client",
      credits: 0,

      suspended: true,
      mustChangePassword: false,

      // ✅ flujo nuevo
      emailVerified: false,
      approvalStatus: "pending",
      emailVerifyTokenHash: tokenHash,
      emailVerifyTokenExpires: expires,
    });

    const FRONTEND_URL =
      process.env.FRONTEND_URL || "https://app.duoclub.ar";

    const verifyUrl = `${FRONTEND_URL}/verify-email?token=${rawToken}`;

    // mandamos mail (si smtp falla, no rompemos registro)
    try {
      await sendVerifyEmail(user, verifyUrl);
    } catch (e) {
      console.warn("[MAIL] No se pudo enviar verificación:", e?.message);
    }

    return res.status(201).json({
      ok: true,
      message:
        "Registro exitoso. Revisá tu correo para verificar el email. Luego el admin debe aprobar tu cuenta.",
    });
  } catch (err) {
    console.error("Error en POST /auth/register:", err);
    return res.status(500).json({ error: "Error al registrar usuario." });
  }
});

/**
 * GET /auth/verify-email?token=...
 */
router.get("/verify-email", async (req, res) => {
  try {
    const token = String(req.query.token || "");
    if (!token) return res.status(400).json({ error: "Token faltante." });

    const tokenHash = sha256(token);

    const user = await User.findOne({
      emailVerifyTokenHash: tokenHash,
      emailVerifyTokenExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({
        error: "Token inválido o expirado. Pedí un nuevo correo de verificación.",
      });
    }

    user.emailVerified = true;
    user.emailVerifyTokenHash = "";
    user.emailVerifyTokenExpires = null;
    await user.save();

    return res.json({
      ok: true,
      message: "Email verificado correctamente. Tu cuenta queda pendiente de aprobación.",
    });
  } catch (err) {
    console.error("Error en GET /auth/verify-email:", err);
    return res.status(500).json({ error: "Error al verificar el email." });
  }
});

/**
 * POST /auth/login
 * body: { email, password }
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res
        .status(400)
        .json({ error: "Email y password son obligatorios." });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) {
      return res.status(401).json({ error: "Email o contraseña incorrectos." });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: "Email o contraseña incorrectos." });
    }

    if (user.suspended) {
      return res
        .status(403)
        .json({ error: "Cuenta suspendida. Contactá al administrador." });
    }

    // ✅ Validación de email
    if (!user.emailVerified) {
      return res.status(403).json({
        error: "Tenés que verificar tu email antes de iniciar sesión.",
      });
    }

    // ✅ Aprobación admin
    if (user.approvalStatus === "pending") {
      return res.status(403).json({
        error: "Tu cuenta está pendiente de aprobación por el administrador.",
      });
    }
    if (user.approvalStatus === "rejected") {
      return res.status(403).json({
        error: "Tu cuenta fue rechazada. Contactá al administrador.",
      });
    }

    const token = signToken(user);
    const safeUser = serializeUser(user);

    return res.json({ token, user: safeUser });
  } catch (err) {
    console.error("Error en POST /auth/login:", err);
    return res.status(500).json({ error: "Error al iniciar sesión." });
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
      return res
        .status(400)
        .json({ error: "Debés enviar contraseña actual y nueva." });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ error: "Usuario no encontrado." });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      return res.status(401).json({ error: "Contraseña actual incorrecta." });
    }

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
    if (!newPassword) {
      return res.status(400).json({ error: "Debés enviar la nueva contraseña." });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(401).json({ error: "Usuario no encontrado." });

    if (!user.mustChangePassword) {
      return res.status(400).json({
        error:
          "Este usuario no requiere restablecer la contraseña de forma obligatoria.",
      });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.mustChangePassword = false;
    await user.save();

    const token = signToken(user);
    return res.json({
      ok: true,
      message: "Contraseña actualizada correctamente.",
      token,
      user: serializeUser(user),
    });
  } catch (err) {
    console.error("Error en POST /auth/force-change-password:", err);
    return res.status(500).json({ error: "Error al restablecer la contraseña." });
  }
});

export default router;
