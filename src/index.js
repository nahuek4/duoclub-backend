// src/index.js
import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import connectDB from "./config/db.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import appointmentRoutes from "./routes/appointments.js";
import servicesRoutes from "./routes/services.js";
import pricingRoutes from "./routes/pricing.js";
import ordersRoutes from "./routes/orders.js";
import mpWebhookRoutes from "./routes/mpWebhook.js";
import admissionRoutes from "./routes/admission.js";



dotenv.config();

const app = express();

// ��� En DEV por defecto 4000, en PROD seteás PORT=3000 en el .env del VPS
const PORT =
  process.env.PORT ||
  (process.env.NODE_ENV === "production" ? 3000 : 4000);

app.set("trust proxy", 1);


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

/* =========================
   CORS FORZADO (local + producción)
   ========================= */

// Lista de orígenes permitidos
const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://duoclub.ar",
  "https://www.duoclub.ar",
  "https://app.duoclub.ar",
  "https://www.app.duoclub.ar",
];

// Middleware global CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Access-Control-Allow-Credentials", "true");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization"
    );
    res.header(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
  }

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});


// 👇 PRE-FLIGHT GLOBAL (ANTES DE TODO)
app.options("*", (req, res) => {
  const origin = req.headers.origin;

  const allowedOrigins = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://duoclub.ar",
    "https://www.duoclub.ar",
    "https://app.duoclub.ar",
    "https://www.app.duoclub.ar",
  ];

  if (!origin || allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin || "*");
    res.header("Access-Control-Allow-Credentials", "true");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization"
    );
    res.header(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    );
  }

  return res.sendStatus(204);
});


/* =========================
   RATE LIMIT
   ========================= */

const apiLimiter = rateLimit({
  windowMs: 15 *60 * 1000, // 15 minutos
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/auth", (req, res, next) => {
  if (req.method === "OPTIONS") return res.sendStatus(204);
  return apiLimiter(req, res, next);
});
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

// Servicios
app.use("/services", servicesRoutes);

app.use("/pricing", pricingRoutes);

app.use("/orders", ordersRoutes);

// webhook MP (NO protect)
app.use("/payments", mpWebhookRoutes);

app.use("/admission", admissionRoutes);


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
