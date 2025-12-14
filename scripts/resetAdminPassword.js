// resetAdminPassword.js
import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import User from "../src/models/User.js";

dotenv.config({ path: "../.env" }); // Ì±à carga el .env correcto

// Ì∫® Ajust√° estos dos si quer√©s otro mail/clave
const email = "admin@duoclub.ar";   // Ì±à el mail que quieras
const plainPassword = "Duoclub123"; // Ì±à la clave que quieras

async function main() {
  try {
    if (!process.env.MONGO_URI) {
      console.error("‚ùå MONGO_URI no definido en .env");
      process.exit(1);
    }

    console.log("Conectando a MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);

    console.log(`Buscando usuario con email: ${email}`);
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      console.error("‚ùå No se encontr√≥ ning√∫n usuario con ese email.");
      process.exit(1);
    }

    console.log(`Usuario encontrado: ${user.name || "(sin nombre)"} (${user.email})`);

    const hash = await bcrypt.hash(plainPassword, 10);

    user.password = hash;
    user.mustChangePassword = false;
    user.role = "admin";

    await user.save();

    console.log("‚úÖ Contrase√±a actualizada correctamente.");
    console.log("=======================================");
    console.log(` Email: ${email}`);
    console.log(` Nueva contrase√±a: ${plainPassword}`);
    console.log("=======================================");

    await mongoose.disconnect();
    process.exit(0);
  } catch (err) {
    console.error("‚ùå Error al resetear contrase√±a:", err);
    process.exit(1);
  }
}

main();
