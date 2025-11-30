// scripts/createAdminDirect.mjs
import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../src/models/User.js";

dotenv.config();

async function main() {
  try {
    console.log("Ì∫Ä Iniciando script de creaci√≥n de admin...");

    const uri = process.env.MONGO_URI;
    if (!uri) {
      console.error("‚ùå MONGO_URI no definido en .env");
      process.exit(1);
    }

    console.log("Ì¥å Conectando a MongoDB...");
    await mongoose.connect(uri, {
      // estos options son seguros con versiones nuevas
    });
    console.log("‚úÖ Conectado a MongoDB");

    // ‚úèÔ∏è CAMBI√Å ESTOS DATOS SI QUER√âS OTRO ADMIN
    const email = "admin2@duoclub.ar";
    const password = "admin123";
    const name = "Nuevo Admin DUO";

    console.log("Ì¥ç Buscando si ya existe el usuario:", email);
    const existing = await User.findOne({ email });

    if (existing) {
      console.log("‚ùó Ya existe un usuario con este email:", email);
      console.log("   No se cre√≥ ning√∫n usuario nuevo.");
      await mongoose.disconnect();
      process.exit(0);
    }

    console.log("Ì¥ê Hasheando contrase√±a...");
    const hashed = await bcrypt.hash(password, 10);

    console.log("Ì∑ë‚ÄçÌ≤º Creando usuario admin...");
    await User.create({
      name,
      email,
      password: hashed,
      role: "admin",
      credits: 0,
      suspended: false,
    });

    console.log("‚úÖ ADMIN CREADO CORRECTAMENTE");
    console.log("Ì≥ß Email   :", email);
    console.log("Ì¥ë Password:", password);

    await mongoose.disconnect();
    console.log("Ì¥å Desconectado de MongoDB");
    process.exit(0);
  } catch (err) {
    console.error("‚ùå Error en el script:", err);
    try {
      await mongoose.disconnect();
    } catch {}
    process.exit(1);
  }
}

main();
