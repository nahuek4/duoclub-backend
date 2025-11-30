// backend/src/middleware/auth.js
import jwt from "jsonwebtoken";
import User from "../models/User.js";

export async function protect(req, res, next) {
  try {
    let token;

    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith("Bearer ")
    ) {
      token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
      return res.status(401).json({ error: "No autorizado, faltan credenciales." });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.id) {
      return res.status(401).json({ error: "Token inválido." });
    }

    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ error: "Usuario no encontrado." });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("Error en middleware protect:", err);
    return res.status(401).json({ error: "Token inválido o expirado." });
  }
}
