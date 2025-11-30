// backend/src/index.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import connectDB from "./config/db.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import appointmentRoutes from "./routes/appointments.js";
import servicesRoutes from "./routes/services.js"; // si no lo tenés todavía, comentá esta línea

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// Necesario para path.join en ESModules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================
   DB
   ========================= */
await connectDB();

/* =========================
   MIDDLEWARES
   ========================= */

// JSON
app.use(express.json());

// CORS para tu front en Vite
app.use(
  cors({
    origin: "http://localhost:5173",
    credentials: true,
  })
);

// Servir archivos estáticos de uploads (apto PDFs)
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

/* =========================
   RUTAS
   ========================= */

// Auth (login, me, change-password, etc.)
app.use("/auth", authRoutes);

// Usuarios (admin)
app.use("/users", userRoutes);

// Turnos (agenda)
app.use("/appointments", appointmentRoutes);

// Servicios (si tu front hace GET /services)
app.use("/services", servicesRoutes); // si no existe el router, comentá esta línea

/* =========================
   RUTA BASE
   ========================= */
app.get("/", (req, res) => {
  res.json({ ok: true, message: "API DUO funcionando" });
});

/* =========================
   404 GENÉRICO
   ========================= */
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

/* =========================
   START SERVER
   ========================= */
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
