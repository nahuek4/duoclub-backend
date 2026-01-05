// backend/src/middleware/auth.js
import jwt from "jsonwebtoken";
import User from "../models/User.js";

// Middleware de protección: requiere token Bearer válido
async function protect(req, res, next) {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "No autorizado. Falta token de autenticación.",
      });
    }

    const token = authHeader.split(" ")[1];

    if (!process.env.JWT_SECRET) {
      console.warn("⚠️ JWT_SECRET no definido en .env, usando 'dev_secret'");
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || "dev_secret");

    // decoded.id viene de signToken({ id: user._id })
    const userId = decoded.id || decoded._id;

    if (!userId) {
      return res.status(401).json({ error: "Token inválido." });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ error: "Usuario no encontrado." });
    }

    req.user = user; // 👈 queda disponible en las rutas
    next();
  } catch (err) {
    console.error("Error en middleware protect:", err);
    return res.status(401).json({
      error: "Token inválido o expirado. Iniciá sesión de nuevo.",
    });
  }
}

// ✅ Solo admin
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "No autorizado. Solo administradores." });
  }
  next();
}

// Exportamos como named y como default para evitar líos con los imports
export { protect, adminOnly };
export default protect;
