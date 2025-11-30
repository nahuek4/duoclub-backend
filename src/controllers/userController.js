// backend/src/controllers/userController.js
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";

import User from "../models/User.js";
import Appointment from "../models/Appointment.js";
import { sendUserWelcomeEmail } from "../mail.js";

// 🔹 Normalizar usuario para el frontend
function serializeUser(u) {
  if (!u) return null;
  const json = u.toObject ? u.toObject() : u;

  return {
    id: json._id?.toString?.() || json.id || json.userId,
    name: json.name || "",
    email: json.email || "",
    phone: json.phone || "",
    dni: json.dni || "",
    age: json.age ?? null,
    weight: json.weight ?? null,
    credits: json.credits ?? 0,
    suspended: !!json.suspended,
    role: json.role || "client",
    aptoPath: json.aptoPath || "",
    aptoStatus: json.aptoStatus || "",
    createdAt: json.createdAt || null,
  };
}

// 🔹 Password temporal amigable
function generateTempPassword(length = 8) {
  const chars =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let pass = "";
  for (let i = 0; i < length; i++) {
    pass += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pass;
}

/* =========================
   CONTROLADORES PRINCIPALES
   ========================= */

// GET /users
export const listUsers = async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json(users.map(serializeUser));
  } catch (err) {
    console.error("Error en listUsers:", err);
    res.status(500).json({ error: "Error al obtener usuarios." });
  }
};

// POST /users
export const createUser = async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      dni,
      age,
      weight,
      notes,
      role = "client",
    } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: "El email es obligatorio." });
    }

    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) {
      return res
        .status(400)
        .json({ error: "Ya existe un usuario con ese email." });
    }

    const tempPassword = generateTempPassword();
    const hashed = await bcrypt.hash(tempPassword, 10);

    const user = await User.create({
      name: name || "",
      email: email.toLowerCase(),
      phone: phone || "",
      dni: dni || "",
      age: age || null,
      weight: weight || null,
      notes: notes || "",
      credits: 0,
      role,
      password: hashed,
      mustChangePassword: true,
      suspended: false,
    });

    // Intentamos mandar mail, pero no rompemos si falla
    try {
      await sendUserWelcomeEmail?.(email, tempPassword);
    } catch (_) {
      // silencioso
    }

    res.status(201).json({
      user: serializeUser(user),
      tempPassword,
    });
  } catch (err) {
    console.error("Error en createUser:", err);
    res.status(500).json({ error: "Error al crear el usuario." });
  }
};

// PATCH /users/:id/credits
export const patchCredits = async (req, res) => {
  try {
    const { id } = req.params;
    let { credits } = req.body || {};

    if (credits === undefined || credits === null) {
      return res
        .status(400)
        .json({ error: "El campo credits es obligatorio." });
    }

    credits = Number(credits);
    if (Number.isNaN(credits)) {
      return res
        .status(400)
        .json({ error: "El valor de credits debe ser numérico." });
    }

    const user = await User.findByIdAndUpdate(
      id,
      { credits },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    res.json(serializeUser(user));
  } catch (err) {
    console.error("Error en patchCredits:", err);
    res.status(500).json({ error: "Error al actualizar créditos." });
  }
};

// GET /users/:id/history
export const userHistory = async (req, res) => {
  try {
    const { id } = req.params;

    // 🔹 Ordenamos por "orden de creación" (orden de llegada)
    //    Si tu esquema tiene timestamps, createdAt refleja eso.
    const appointments = await Appointment.find({ user: id })
      .sort({ createdAt: 1, _id: 1 }) // primero el más viejo, último el más nuevo
      .lean();

    const history = appointments.map((ap) => ({
      id: ap._id?.toString?.(),
      date: ap.date,
      time: ap.time,
      service: ap.service || ap.serviceName || "Turno",
      status: ap.status || "reserved",
      action: ap.status || "reserved",
    }));

    res.json(history);
  } catch (err) {
    console.error("Error en userHistory:", err);
    res.status(500).json({ error: "Error al obtener el historial." });
  }
};

// POST /users/:id/reset-password
export const resetPassword = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    const tempPassword = generateTempPassword();
    const hashed = await bcrypt.hash(tempPassword, 10);

    user.password = hashed;
    user.mustChangePassword = true;
    await user.save();

    res.json({ tempPassword });
  } catch (err) {
    console.error("Error en resetPassword:", err);
    res.status(500).json({ error: "Error al resetear la contraseña." });
  }
};

// PATCH /users/:id/suspend
export const setSuspended = async (req, res) => {
  try {
    const { id } = req.params;
    const { suspended } = req.body || {};

    const user = await User.findByIdAndUpdate(
      id,
      { suspended: !!suspended },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    res.json(serializeUser(user));
  } catch (err) {
    console.error("Error en setSuspended:", err);
    res
      .status(500)
      .json({ error: "Error al actualizar estado de usuario." });
  }
};

// DELETE /users/:id
export async function deleteUser(req, res) {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado" });
    }

    // 1) Borrar TODOS los turnos asociados a este usuario
    // 👉 Usá el campo que tengas en tu modelo de Appointment:
    //    - si tu schema tiene user: { type: ObjectId, ref: "User" } → { user: id }
    //    - si tu schema usa userId: String → { userId: id }
    await Appointment.deleteMany({ user: id }); // o { userId: id }

    // 2) Borrar el usuario
    await user.deleteOne();

    return res.json({
      ok: true,
      message: "Usuario y turnos asociados eliminados correctamente",
    });
  } catch (err) {
    console.error("Error al eliminar usuario:", err);
    return res
      .status(500)
      .json({ error: "Error al eliminar usuario y sus turnos" });
  }
}

/* =========================
   APTOS (PDF)
   ========================= */

// POST /users/:id/apto  (req.file viene de multer)
export const uploadUserApto = async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No se recibió ningún archivo PDF." });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    // Ruta accesible desde el frontend
    const fileUrl = `/uploads/apto/${req.file.filename}`;

    user.aptoPath = fileUrl;
    user.aptoStatus = "uploaded";
    await user.save();

    res.json({
      message: "Apto físico subido correctamente.",
      user: serializeUser(user),
    });
  } catch (err) {
    console.error("Error en uploadUserApto:", err);
    res.status(500).json({ error: "Error al subir el apto." });
  }
};

// DELETE /users/:id/apto
export const deleteUserApto = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }

    // Si querés borrar también el archivo físico:
    if (user.aptoPath) {
      const filePath = path.join(
        process.cwd(),
        user.aptoPath.replace(/^\//, "")
      );
      fs.unlink(filePath, (err) => {
        if (err) {
          console.warn("No se pudo borrar archivo de apto:", err.message);
        }
      });
    }

    user.aptoPath = "";
    user.aptoStatus = "";
    await user.save();

    res.json({
      message: "Apto físico eliminado correctamente.",
      user: serializeUser(user),
    });
  } catch (err) {
    console.error("Error en deleteUserApto:", err);
    res.status(500).json({ error: "Error al eliminar el apto." });
  }
};

// Opcionalmente, si querés aprobar / rechazar aptos desde admin:

export const approveApto = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }
    if (!user.aptoPath) {
      return res
        .status(400)
        .json({ error: "No hay apto para aprobar." });
    }
    user.aptoStatus = "approved";
    await user.save();
    res.json({ ok: true, aptoStatus: user.aptoStatus });
  } catch (err) {
    console.error("Error en approveApto:", err);
    res.status(500).json({ error: "Error al aprobar apto." });
  }
};

export const rejectApto = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ error: "Usuario no encontrado." });
    }
    if (!user.aptoPath) {
      return res
        .status(400)
        .json({ error: "No hay apto para rechazar." });
    }
    user.aptoStatus = "rejected";
    await user.save();
    res.json({ ok: true, aptoStatus: user.aptoStatus });
  } catch (err) {
    console.error("Error en rejectApto:", err);
    res.status(500).json({ error: "Error al rechazar apto." });
  }
};
