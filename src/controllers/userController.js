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
    lastName: json.lastName || "",
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
    photoPath: json.photoPath || "",
    initialForm: json.initialForm || null,
    createdAt: json.createdAt || null,
  };
}

// 🔹 Password temporal amigable
function generateTempPassword(length = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let pass = "";
  for (let i = 0; i < length; i++) {
    pass += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return pass;
}

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

// GET /users/:id
export const getUserById = async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    res.json(serializeUser(user));
  } catch (err) {
    console.error("Error en getUserById:", err);
    res.status(500).json({ error: "Error al obtener el usuario." });
  }
};

// POST /users (admin)
export const createUser = async (req, res) => {
  try {
    const {
      name,
      lastName,
      email,
      phone,
      dni,
      age,
      weight,
      notes,
      role = "client",
    } = req.body || {};

    const n = String(name || "").trim();
    const ln = String(lastName || "").trim();
    const em = String(email || "").trim().toLowerCase();
    const ph = String(phone || "").trim();

    if (!n || !ln || !em || !ph) {
      return res.status(400).json({
        error: "Nombre, apellido, teléfono y email son obligatorios.",
      });
    }

    const exists = await User.findOne({ email: em });
    if (exists) {
      return res.status(400).json({ error: "Ya existe un usuario con ese email." });
    }

    const tempPassword = generateTempPassword();
    const hashed = await bcrypt.hash(tempPassword, 10);

    const user = await User.create({
      name: n,
      lastName: ln,
      email: em,
      phone: ph,
      dni: dni || "",
      age: age || null,
      weight: weight || null,
      notes: notes || "",
      credits: 0,
      role,
      password: hashed,
      mustChangePassword: true,
      suspended: false,

      // coherencia con sistema de aprobación
      emailVerified: true,        // si lo crea admin, lo consideramos validado
      approvalStatus: "approved", // y aprobado
    });

    try {
      await sendUserWelcomeEmail?.(em, tempPassword);
    } catch (_) {}

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
      return res.status(400).json({ error: "El campo credits es obligatorio." });
    }

    credits = Number(credits);
    if (Number.isNaN(credits)) {
      return res.status(400).json({ error: "El valor de credits debe ser numérico." });
    }

    const user = await User.findByIdAndUpdate(id, { credits }, { new: true });
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

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

    const appointments = await Appointment.find({ user: id })
      .sort({ createdAt: 1, _id: 1 })
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
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

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

    const user = await User.findByIdAndUpdate(id, { suspended: !!suspended }, { new: true });
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    res.json(serializeUser(user));
  } catch (err) {
    console.error("Error en setSuspended:", err);
    res.status(500).json({ error: "Error al actualizar estado de usuario." });
  }
};

// DELETE /users/:id
export async function deleteUser(req, res) {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado" });

    await Appointment.deleteMany({ user: id });
    await user.deleteOne();

    return res.json({
      ok: true,
      message: "Usuario y turnos asociados eliminados correctamente",
    });
  } catch (err) {
    console.error("Error al eliminar usuario:", err);
    return res.status(500).json({ error: "Error al eliminar usuario y sus turnos" });
  }
}
