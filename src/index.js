// backend/src/index.js
import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import connectDB from "./config/db.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import appointmentRoutes from "./routes/appointments.js";
import servicesRoutes from "./routes/services.js"; // si no lo tenés todavía, comentá esta línea

dotenv.config();

const app = express();

// 🔹 En DEV por defecto 4000, en PROD seteás PORT=3000 en el .env del VPS
const PORT =
  process.env.PORT ||
  (process.env.NODE_ENV === "production" ? 3000 : 4000);

// Necesario para path.join en ESModules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================
   DB
   ========================= */
await connectDB();

/* =========================
   MIDDLEWARES BASE
   ========================= */

// Seguridad básica (headers)
app.use(
  helmet({
    // Para no romper carga de imágenes/pdf desde otros dominios
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// Body JSON
app.use(express.json());

// CORS (local + producción)
const allowedOrigins = [
  "http://localhost:5173",    // front en Vite (dev)
  "http://127.0.0.1:5173",
  "https://duoclub.ar",       // dominio principal
  "https://www.duoclub.ar",
  "https://app.duoclub.ar",   // por si tenés subdominio para la app
  "https://www.app.duoclub.ar",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Permitir herramientas tipo Postman/curl sin Origin
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn("Origen bloqueado por CORS:", origin);
      return callback(new Error("Origen no permitido por CORS"), false);
    },
    credentials: true,
  })
);

// Rate limit básico para evitar abuso (login / reservas)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,                 // máx 100 requests por IP en ese tiempo
  standardHeaders: true,
  legacyHeaders: false,
});

// Aplicamos limitador en rutas más sensibles
app.use("/auth", apiLimiter);
app.use("/appointments", apiLimiter);

// Servir archivos estáticos de uploads (apto PDFs, etc.)
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

/* =========================
   RUTA HEALTH
   ========================= */
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    message: "API DUO funcionando",
    env: process.env.NODE_ENV || "development",
    timestamp: new Date().toISOString(),
  });
});

/* =========================
   RUTAS
   ========================= */

// Auth (login, me, change-password, etc.)
app.use("/auth", authRoutes);

// Usuarios (admin / perfil)
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
  console.log(`✅ Servidor escuchando en http://localhost:${PORT}`);
});
