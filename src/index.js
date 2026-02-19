// backend/src/index.js
import express from "express";
import dotenv from "dotenv";
import path from "path";
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

// ✅ jobs
import { startAppointmentReminderScheduler } from "./jobs/startReminders.js";
import { startWaitlistScheduler } from "./jobs/startWaitlist.js";

// ✅ NUEVO: links de aprobar/rechazar del mail (vive en /auth)
import adminApprovalLinksRoutes from "./routes/adminApprovalLinks.js";

// ✅ ROUTE waitlist (asegurate de tener este archivo)
import waitlistRouter from "./routes/waitlist.js";

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
   ✅ REMINDERS 24HS (AUTO)
========================= */
startAppointmentReminderScheduler({
  everyMinutes: Number(process.env.REMINDER_EVERY_MINUTES || 10),
  aheadHours: Number(process.env.REMINDER_AHEAD_HOURS || 24),
  windowMinutes: Number(process.env.REMINDER_WINDOW_MINUTES || 10),
});

/* =========================
   ✅ WAITLIST (AUTO)
========================= */
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

app.use(express.json());

/* =========================
   ✅ CORS (ESTABLE + PRE-FLIGHT PERFECTO)
   - IMPORTANTÍSIMO: NO tirar error en origin()
   - IMPORTANTÍSIMO: app.options usa el MISMO corsOptions
========================= */
const allowedOrigins = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://duoclub.ar",
  "https://www.duoclub.ar",
  "https://app.duoclub.ar",
  "https://www.app.duoclub.ar",
]);

const corsOptions = {
  origin(origin, cb) {
    // Permite Postman/curl (sin Origin)
    if (!origin) return cb(null, true);

    if (allowedOrigins.has(origin)) return cb(null, true);

    // ❗ NO devolver Error acá: si no, el browser ve “sin ACAO”
    return cb(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Origin", "Accept"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
// ✅ preflight global usando las mismas opciones
app.options("*", cors(corsOptions));

/* =========================
   RATE LIMIT
========================= */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/auth", apiLimiter);
app.use("/appointments", apiLimiter);
app.use("/waitlist", apiLimiter);

/* =========================
   STATIC
========================= */
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

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
========================= */
app.use("/auth", authRoutes);
app.use("/auth", adminApprovalLinksRoutes);

app.use("/users", userRoutes);
app.use("/appointments", appointmentRoutes);
app.use("/services", servicesRoutes);
app.use("/pricing", pricingRoutes);
app.use("/orders", ordersRoutes);
app.use("/payments", mpWebhookRoutes);
app.use("/admission", admissionRoutes);
app.use("/admin/evaluations", adminEvaluationsRoutes);
app.use("/evaluations", evaluationsRoutes);
app.use("/api/test-mail", testMailRouter);

app.use("/waitlist", waitlistRouter);

/* =========================
   RUTA BASE
========================= */
app.get("/", (req, res) => {
  res.json({ ok: true, message: "API DUO funcionando" });
});

/* =========================
   ✅ ERROR HANDLER CORS
   - si origin no permitido => 403 prolijo (pero CON headers si el origin era válido)
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
