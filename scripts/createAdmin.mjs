import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import connectDB from "../src/config/db.js";
import User from "../src/models/User.js";

dotenv.config();

async function main() {
  try {
    await connectDB();

    // ��� CONFIGURÁ EL MAIL Y LA PASS ACÁ
    const email = "admin2@duoclub.ar";
    const password = "admin123";
    const name = "Nuevo Admin";

    // Revisa si existe
    const exists = await User.findOne({ email });
    if (exists) {
      console.log("❗ Ya existe un usuario con este email:", email);
      console.log("No se creó nada.");
      process.exit(0);
    }

    // Encripta contraseña
    const hashed = await bcrypt.hash(password, 10);

    // Crea admin
    await User.create({
      name,
      email,
      password: hashed,
      role: "admin",
      credits: 0,
      suspended: false,
    });

    console.log("✅ ADMIN CREADO CORRECTAMENTE");
    console.log("Email:", email);
    console.log("Password:", password);
    process.exit(0);
  } catch (err) {
    console.error("❌ Error creando admin:", err);
    process.exit(1);
  }
}

main();
