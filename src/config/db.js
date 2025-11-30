// backend/src/config/db.js
import mongoose from "mongoose";

async function connectDB() {
  try {
    const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/duo-agenda";

    await mongoose.connect(uri, {
      // estas opciones ya no son necesarias en mongoose 7+, pero no molestan
      // useNewUrlParser: true,
      // useUnifiedTopology: true,
    });

    console.log("✅ MongoDB conectado:", uri);
  } catch (err) {
    console.error("❌ Error al conectar con MongoDB:", err.message);
    process.exit(1);
  }
}

export default connectDB;
