// backend/src/index.js
import express from "express";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";

import connectDB from "./config/db.js";
import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import appointmentRoutes from "./routes/appointments.js";
import servicesRoutes from "./routes/services.js";
import pricingRoutes from "./routes/pricing.js";
import ordersRoutes from "./routes/orders.js";
import mpWebhookRoutes from "./routes/mpWebhook.js";
import admissionRoutes from "./routes/admission.js";
import adminEvaluationsRoutes from "./routes/adminEvaluations.js";
import evaluationsRoutes from "./routes/evaluations.js";
import testMailRouter from "./routes/testMail.js";
import waitlistRouter from "./routes/waitlist.js";

import { startAppointmentReminderScheduler } from "./jobs/startReminders.js";
import { startWaitlistScheduler } from "./jobs/startWaitlist.js";

// ✅ NUEVO
import adminApprovalLinksRoutes from "./routes/adminApprovalLinks.js";

dotenv.config();

const app = express();

const PORT =
  process.env.PORT ||
  (process.env.NODE_ENV === "production" ? 3000 : 4000);

app.set("trust proxy", 1);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* =========================
   DB
========================= */
await connectDB();

/* =========================
   ✅ JOBS (AUTO)
========================= */
startAppointmentReminderScheduler({
  everyMinutes: Number(process.env.REMINDER_EVERY_MINUTES || 10),
  aheadHours: Number(process.env.REMINDER_AHEAD_HOURS || 24),
  windowMinutes: Number(process.env.REMINDER_WINDOW_MINUTES || 10),
});

startWaitlistScheduler({
  everyMinutes: Number(process.env.WAITLIST_EVERY_MINUTES || 2),
});

/* =========================
   MIDDLEWARES BASE
========================= */
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(express.json({ limit: "2mb" }));

/* =========================
   ✅ CORS
========================= */
const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://duoclub.ar",
  "https://www.duoclub.ar",
  "https://app.duoclub.ar",
  "https://www.app.duoclub.ar",
];

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // Postman/curl
      const o = String(origin).trim();

      if (allowedOrigins.includes(o)) return cb(null, true);
      if (/^https:\/\/([a-z0-9-]+\.)*duoclub\.ar$/i.test(o)) return cb(null, true);

      return cb(new Error("Not allowed by CORS: " + o));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Origin", "Accept"],
  })
);

app.options("*", cors());

/* =========================
   RATE LIMIT
========================= */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

// limit en ambas rutas (con /api y sin /api)
app.use(["/auth", "/appointments", "/waitlist", "/api/auth", "/api/appointments", "/api/waitlist"], apiLimiter);

/* =========================
   STATIC (UPLOADS)
   ✅ backend/uploads (al lado de /src)
========================= */
const uploadsDir = path.join(__dirname, "..", "uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

// ✅ Servimos ambos paths para compatibilidad
app.use("/uploads", express.static(uploadsDir));
app.use("/api/uploads", express.static(uploadsDir));

/* =========================
   HEALTH
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
   ✅ Montamos 2 veces: con / y con /api
   Así tu front puede usar baseURL "/api" sin rewrite.
========================= */
function mountRoutes(prefix = "") {
  app.use(`${prefix}/auth`, authRoutes);
  app.use(`${prefix}/auth`, adminApprovalLinksRoutes);

  app.use(`${prefix}/users`, userRoutes);
  app.use(`${prefix}/appointments`, appointmentRoutes);
  app.use(`${prefix}/services`, servicesRoutes);
  app.use(`${prefix}/pricing`, pricingRoutes);
  app.use(`${prefix}/orders`, ordersRoutes);
  app.use(`${prefix}/payments`, mpWebhookRoutes);
  app.use(`${prefix}/admission`, admissionRoutes);
  app.use(`${prefix}/admin/evaluations`, adminEvaluationsRoutes);
  app.use(`${prefix}/evaluations`, evaluationsRoutes);
  app.use(`${prefix}/api/test-mail`, testMailRouter);
  app.use(`${prefix}/waitlist`, waitlistRouter);
}

mountRoutes("");     // /users, /appointments, etc.
mountRoutes("/api"); // /api/users, /api/appointments, etc.

/* =========================
   RUTA BASE
========================= */
app.get("/", (req, res) => {
  res.json({ ok: true, message: "API DUO funcionando" });
});

/* =========================
   ERROR HANDLER CORS
========================= */
app.use((err, req, res, next) => {
  if (String(err?.message || "").startsWith("Not allowed by CORS")) {
    return res.status(403).json({ error: err.message });
  }
  return next(err);
});

/* =========================
   404
========================= */
app.use((req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`✅ Servidor escuchando en http://localhost:${PORT}`);
});