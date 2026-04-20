import jwt from "jsonwebtoken";
import User from "../models/User.js";

function normalizeUrl(url) {
  const raw = String(url || "").split("?")[0].trim();
  if (!raw) return "";
  return raw.startsWith("/api/") ? raw.slice(4) : raw;
}

function getAuthHeader(req) {
  return (
    req.headers?.authorization ||
    req.headers?.Authorization ||
    req.get?.("authorization") ||
    req.get?.("Authorization") ||
    ""
  );
}

function getBearerToken(req) {
  const raw = String(getAuthHeader(req) || "").trim();
  if (!raw.toLowerCase().startsWith("bearer ")) return "";
  const parts = raw.split(/\s+/).filter(Boolean);
  return parts.length >= 2 ? parts[1] : "";
}

const PASS_CHANGE_ALLOWLIST = [
  "/auth/me",
  "/auth/force-change-password",
];

function isAllowedDuringForcedPasswordChange(req) {
  const url = normalizeUrl(req.originalUrl || req.url || "");
  return PASS_CHANGE_ALLOWLIST.some((path) => url === path || url.startsWith(path + "/"));
}

export async function protect(req, res, next) {
  try {
    const token = getBearerToken(req);

    if (!token) {
      return res.status(401).json({ error: "No autorizado. Falta token." });
    }

    const secret = process.env.JWT_SECRET || "dev_secret";
    const decoded = jwt.verify(token, secret);

    const userId = decoded?.id || decoded?._id || "";
    if (!userId) {
      return res.status(401).json({ error: "Token inválido." });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(401).json({ error: "Usuario no encontrado." });
    }

    req.user = user;

    const role = String(user.role || "").toLowerCase().trim();
    const isAdmin = role === "admin";
    const mustChangePassword = !!user.mustChangePassword;

    if (!isAdmin && mustChangePassword && !isAllowedDuringForcedPasswordChange(req)) {
      return res.status(403).json({
        error: "Debés restablecer tu contraseña para continuar.",
        code: "MUST_CHANGE_PASSWORD",
      });
    }

    return next();
  } catch (err) {
    console.error("protect() error:", err?.message || err);
    return res.status(401).json({ error: "Token inválido o expirado." });
  }
}

export function adminOnly(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase().trim();
  if (role !== "admin") {
    return res.status(403).json({ error: "No autorizado. Solo administradores." });
  }
  return next();
}

export function adminOrProfessor(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase().trim();
  if (!["admin", "profesor", "staff"].includes(role)) {
    return res.status(403).json({ error: "No autorizado." });
  }
  return next();
}

export default protect;
