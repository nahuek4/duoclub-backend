import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

// 🔹 Normalizar usuario para el frontend
function serializeUser(u) {
  if (!u) return null;
  const json = u.toObject ? u.toObject() : u;

  return {
    id: json._id?.toString?.() || json.id,
    name: json.name || "",
    lastName: json.lastName || "",
    email: json.email || "",
    phone: json.phone || "",
    dni: json.dni ?? "",
    age: json.age ?? null,
    weight: json.weight ?? null,
    notes: json.notes || "",
    credits: json.credits ?? 0,
    role: json.role || "client",
    suspended: !!json.suspended,
    mustChangePassword: !!json.mustChangePassword,
    aptoPath: json.aptoPath || "",
    aptoStatus: json.aptoStatus || "",
    emailVerified: !!json.emailVerified,
    approvalStatus: json.approvalStatus || "pending",
    createdAt: json.createdAt || null,
  };
}

function signToken(user) {
  if (!process.env.JWT_SECRET) {
    console.warn("⚠️ JWT_SECRET no está definido en .env");
  }

  return jwt.sign(
    { id: user._id.toString(), role: user.role || "client" },
    process.env.JWT_SECRET || "dev_secret",
    { expiresIn: "7d" }
  );
}

// ==========================
//  POST /auth/login
// ==========================
export async function login(req, res) {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "Email y contraseña son obligatorios." });
    }

    const user = await User.findOne({ email: String(email).toLowerCase() });
    if (!user) return res.status(401).json({ error: "Email o contraseña incorrectos." });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Email o contraseña incorrectos." });

    // mismo orden que auth.js
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
    return res.status(500).json({ error: "Error interno en el login. Revisá el servidor." });
  }
}

// ==========================
//  GET /auth/me
// ==========================
export async function me(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: "No autorizado." });

    const fresh = await User.findById(req.user._id);
    if (!fresh) return res.status(401).json({ error: "Usuario no encontrado." });

    return res.json(serializeUser(fresh));
  } catch (err) {
    console.error("Error en GET /auth/me:", err);
    return res.status(500).json({ error: "Error al obtener el usuario." });
  }
}

// ==========================
//  POST /auth/change-password
// ==========================
export async function changePassword(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: "No autorizado." });

    const { oldPassword, currentPassword, newPassword } = req.body || {};
    const current = oldPassword || currentPassword;

    if (!current || !newPassword) {
      return res.status(400).json({
        error: "Debés enviar la contraseña actual (oldPassword/currentPassword) y la nueva (newPassword).",
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    const match = await bcrypt.compare(current, user.password);
    if (!match) return res.status(401).json({ error: "La contraseña actual no es correcta." });

    const hashed = await bcrypt.hash(newPassword, 10);
    user.password = hashed;
    user.mustChangePassword = false;
    await user.save();

    return res.json({ ok: true, message: "Contraseña actualizada correctamente." });
  } catch (err) {
    console.error("Error en POST /auth/change-password:", err);
    return res.status(500).json({ error: "Error al cambiar la contraseña." });
  }
}

// ==========================
//  POST /auth/force-change-password
// ==========================
export async function forceChangePassword(req, res) {
  try {
    if (!req.user) return res.status(401).json({ error: "No autorizado." });

    const { newPassword } = req.body || {};
    if (!newPassword) return res.status(400).json({ error: "Debés enviar la nueva contraseña." });

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (!user.mustChangePassword) {
      return res.status(400).json({
        error: "Este usuario no requiere restablecer la contraseña de forma obligatoria.",
      });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    user.password = hashed;
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
}

export { serializeUser, signToken };
