// backend/src/scripts/seedAdmin.js
import dotenv from "dotenv";
import bcrypt from "bcryptjs";

import connectDB from "../config/db.js";
import User from "../models/User.js";

dotenv.config();

async function run() {
  try {
    await connectDB();

    const email = "admin@duoclub.ar";   // 👈 el mail que quieras
    const plainPassword = "Duoclub123"; // 👈 la clave que quieras

    let user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      console.log("No existe admin, creando uno nuevo...");
      const hash = await bcrypt.hash(plainPassword, 10);

      user = await User.create({
        name: "Admin DUO",
        email: email.toLowerCase(),
        password: hash,
        role: "admin",
        credits: 0,
        suspended: false,
        mustChangePassword: false, // o true si querés obligar cambio
      });
    } else {
      console.log("Admin ya existe, actualizando password/rol...");
      const hash = await bcrypt.hash(plainPassword, 10);
      user.password = hash;
      user.role = "admin";
      user.suspended = false;
      user.mustChangePassword = false;
      await user.save();
    }

    console.log("✅ Admin listo:");
    console.log("Email:", email);
    console.log("Pass :", plainPassword);
  } catch (err) {
    console.error("Error en seedAdmin:", err);
  } finally {
    process.exit(0);
  }
}

run();
