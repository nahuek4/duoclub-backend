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
  return jwt.sign({ id: user._id }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
}

function serializeUser(u) {
  return {
    id: u._id.toString(),
    name: u.name,
    email: u.email,
    role: u.role,
    credits: u.credits,
    suspended: !!u.suspended,
    mustChangePassword: !!u.mustChangePassword,
    aptoStatus: u.aptoStatus || "",
    emailVerified: !!u.emailVerified,
    approvalStatus: u.approvalStatus || "pending",
  };
}

const sha256 = (str) =>
  crypto.createHash("sha256").update(str).digest("hex");

// ===============================
// LOGIN
// ===============================
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "Email y password son obligatorios." });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(401).json({ error: "Email o contraseña incorrectos." });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "Email o contraseña incorrectos." });

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
    res.json({ token, user: serializeUser(user) });
  } catch (err) {
    console.error("Error login:", err);
    res.status(500).json({ error: "Error al iniciar sesión." });
  }
});

// ===============================
// REGISTER
// ===============================
router.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
      return res.status(400).json({ error: "Datos incompletos." });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres." });
    }

    const emailLower = email.toLowerCase();
    if (await User.findOne({ email: emailLower })) {
      return res.status(409).json({ error: "Ya existe una cuenta con ese email." });
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = sha256(rawToken);

    const user = await User.create({
      name,
      email: emailLower,
      password: await bcrypt.hash(password, 10),
      role: "client",
      suspended: true,
      approvalStatus: "pending",
      emailVerified: false,
      emailVerificationToken: tokenHash,
      emailVerificationExpires: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    const verifyUrl = `${process.env.FRONTEND_URL}/verificar-email?token=${rawToken}`;

    await sendMail(
      user.email,
      "Verificá tu email - DUO",
      `Hola ${user.name}\n\nVerificá tu email acá:\n${verifyUrl}`
    );

    res.status(201).json({
      ok: true,
      message: "Registro exitoso. Revisá tu email para verificar la cuenta.",
    });
  } catch (err) {
    console.error("Error register:", err);
    res.status(500).json({ error: "Error al registrarse." });
  }
});

// ===============================
// VERIFY EMAIL
// ===============================
router.get("/verify-email", async (req, res) => {
  try {
    const rawToken = String(req.query.token || "");
    const tokenHash = sha256(rawToken);

    const user = await User.findOne({
      emailVerificationToken: tokenHash,
      emailVerificationExpires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ error: "Token inválido o expirado." });
    }

    user.emailVerified = true;
    user.emailVerificationToken = "";
    user.emailVerificationExpires = null;
    await user.save();

    res.json({
      ok: true,
      message: "Email verificado. Quedás pendiente de aprobación.",
    });
  } catch (err) {
    console.error("Error verify-email:", err);
    res.status(500).json({ error: "Error al verificar email." });
  }
});

// ===============================
// ME
// ===============================
router.get("/me", protect, async (req, res) => {
  res.json(serializeUser(req.user));
});

export default router;
