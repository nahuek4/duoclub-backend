// backend/src/middleware/auth.js
import jwt from "jsonwebtoken";
import User from "../models/User.js";

export async function protect(req, res, next) {
  try {
    const authHeader =
      req.headers.authorization ||
      req.headers.Authorization ||
      req.get?.("authorization") ||
      req.get?.("Authorization") ||
      "";

    const raw = String(authHeader || "").trim();
    if (!raw.toLowerCase().startsWith("bearer ")) {
      return res.status(401).json({ error: "No autorizado. Falta token." });
    }

    const token = raw.split(/\s+/)[1];
    if (!token) return res.status(401).json({ error: "Token inválido." });

    const secret = process.env.JWT_SECRET || "dev_secret";
    const decoded = jwt.verify(token, secret);

    const userId = decoded?.id || decoded?._id;
    if (!userId) return res.status(401).json({ error: "Token inválido." });

    const user = await User.findById(userId);
    if (!user) return res.status(401).json({ error: "Usuario no encontrado." });

    req.user = user;
    next();
  } catch (err) {
    console.error("protect() error:", err?.message || err);
    return res.status(401).json({ error: "Token inválido o expirado." });
  }
}

export function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "No autorizado. Solo administradores." });
  }
  next();
}

export default protect;