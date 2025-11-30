// backend/src/routes/auth.js
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { id: user._id },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
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
  };
}

/**
 * POST /auth/login
 * body: { email, password }
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email y password son obligatorios." });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      // No revelamos si el email existe
      return res.status(401).json({ error: "Email o contraseña incorrectos." });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: "Email o contraseña incorrectos." });
    }

    if (user.suspended) {
      return res.status(403).json({ error: "Cuenta suspendida. Contactá al administrador." });
    }

    const token = signToken(user);
    const safeUser = serializeUser(user);

    res.json({ token, user: safeUser });
  } catch (err) {
    console.error("Error en POST /auth/login:", err);
    res.status(500).json({ error: "Error al iniciar sesión." });
  }
});

/**
 * GET /auth/me
 * Devuelve el usuario actual (según token)
 */
router.get("/me", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(401).json({ error: "Usuario no encontrado." });
    }
    res.json(serializeUser(user));
  } catch (err) {
    console.error("Error en GET /auth/me:", err);
    res.status(500).json({ error: "Error al obtener el usuario." });
  }
});

/**
 * POST /auth/change-password
 * Cambio normal: requiere password actual
 * body: { currentPassword, newPassword }
 */
router.post("/change-password", protect, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Debés enviar contraseña actual y nueva." });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(401).json({ error: "Usuario no encontrado." });
    }

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      return res.status(401).json({ error: "Contraseña actual incorrecta." });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.mustChangePassword = false; // por las dudas
    await user.save();

    res.json({ ok: true, message: "Contraseña actualizada correctamente." });
  } catch (err) {
    console.error("Error en POST /auth/change-password:", err);
    res.status(500).json({ error: "Error al cambiar la contraseña." });
  }
});

/**
 * POST /auth/force-change-password
 * ⚠️ NO pide contraseña vieja.
 * Para usuarios con contraseña provisoria / primer login.
 * body: { newPassword }
 */
router.post("/force-change-password", protect, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword) {
      return res.status(400).json({ error: "Debés enviar la nueva contraseña." });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(401).json({ error: "Usuario no encontrado." });
    }

    if (!user.mustChangePassword) {
      // Opcional: bloquear si no está en modo "debe cambiar"
      return res.status(400).json({
        error: "Este usuario no requiere restablecer la contraseña de forma obligatoria.",
      });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(newPassword, salt);
    user.mustChangePassword = false;
    await user.save();

    // Podés devolver un nuevo token si querés
    const token = signToken(user);
    res.json({
      ok: true,
      message: "Contraseña actualizada correctamente.",
      token,
      user: serializeUser(user),
    });
  } catch (err) {
    console.error("Error en POST /auth/force-change-password:", err);
    res.status(500).json({ error: "Error al restablecer la contraseña." });
  }
});

export default router;
