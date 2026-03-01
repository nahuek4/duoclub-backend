// backend/src/middleware/auth.js
import jwt from "jsonwebtoken";
import User from "../models/User.js";

function normalizeUrl(u) {
  const raw = String(u || "").split("?")[0];
  return raw.startsWith("/api/") ? raw.slice(4) : raw; // "/api/auth/me" => "/auth/me"
}

const PASS_CHANGE_ALLOWLIST = [
  "/auth/me",
  "/auth/force-change-password",
];

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

    // ✅ BLOQUEO POR CONTRASEÑA TEMPORAL (solo no-admin)
    const isAdmin = String(user.role || "").toLowerCase() === "admin";
    const mustChange = !!user.mustChangePassword;

    if (!isAdmin && mustChange) {
      const url = normalizeUrl(req.originalUrl || req.url || "");
      const allowed = PASS_CHANGE_ALLOWLIST.some((p) => url.startsWith(p));
      if (!allowed) {
        return res.status(403).json({
          error: "Debés restablecer tu contraseña para continuar.",
          code: "MUST_CHANGE_PASSWORD",
        });
      }
    }

    next();
  } catch (err) {
    console.error("protect() error:", err?.message || err);
    return res.status(401).json({ error: "Token inválido o expirado." });
  }
}

export function adminOnly(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (role !== "admin") {
    return res.status(403).json({ error: "No autorizado. Solo administradores." });
  }
  next();
}

export function adminOrProfessor(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();
  if (role !== "admin" && role !== "profesor") {
    return res.status(403).json({ error: "No autorizado." });
  }
  next();
}

export default protect;