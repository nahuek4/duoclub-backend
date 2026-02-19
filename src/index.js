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

// jobs base
import { startAppointmentReminderScheduler } from "./jobs/startReminders.js";

// ✅ NUEVO: links de aprobar/rechazar del mail (vive en /auth)
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
   ✅ REMINDERS 24HS (AUTO)
========================= */
startAppointmentReminderScheduler({
  everyMinutes: Number(process.env.REMINDER_EVERY_MINUTES || 10),
  aheadHours: Number(process.env.REMINDER_AHEAD_HOURS || 24),
  windowMinutes: Number(process.env.REMINDER_WINDOW_MINUTES || 10),
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
   ✅ CORS (estable + preflight ok)
========================= */
const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://duoclub.ar",
  "https://www.duoclub.ar",
  "https://app.duoclub.ar",
  "https://www.app.duoclub.ar",
];

const corsOptions = {
  origin(origin, cb) {
    // Permite Postman/curl (sin Origin)
    if (!origin) return cb(null, true);

    // Normalizamos por si viene con espacios
    const o = String(origin).trim();

    if (allowedOrigins.includes(o)) return cb(null, true);

    // Importante: devolvemos error controlado (va al handler de abajo)
    return cb(new Error("Not allowed by CORS: " + o));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Origin", "Accept"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// ✅ responder preflight con CORS correctamente (antes de rate-limit)
app.options("*", cors(corsOptions));

/* =========================
   RATE LIMIT
========================= */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,

  // ✅ CLAVE: NO rate-limitear preflight
  skip: (req) => req.method === "OPTIONS",
});

app.use("/auth", apiLimiter);
app.use("/appointments", apiLimiter);

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

/* =========================
   ✅ WAITLIST (opcional, no rompe deploy si falta)
========================= */
try {
  const modRouter = await import("./routes/waitlist.js");
  const waitlistRouter = modRouter?.default;
  if (waitlistRouter) {
    app.use("/waitlist", waitlistRouter);
    console.log("✅ /waitlist route mounted");
  } else {
    console.log("⚠️ ./routes/waitlist.js no exporta default router");
  }
} catch (e) {
  console.log("⚠️ waitlist router not mounted:", e?.message || e);
}

try {
  const modJob = await import("./jobs/startWaitlist.js");
  const startWaitlistScheduler = modJob?.startWaitlistScheduler;
  if (typeof startWaitlistScheduler === "function") {
    startWaitlistScheduler({
      everyMinutes: Number(process.env.WAITLIST_EVERY_MINUTES || 2),
    });
    console.log("✅ waitlist scheduler started");
  }
} catch (e) {
  console.log("⚠️ waitlist scheduler not started:", e?.message || e);
}

/* =========================
   RUTA BASE
========================= */
app.get("/", (req, res) => {
  res.json({ ok: true, message: "API DUO funcionando" });
});

/* =========================
   ERROR HANDLER CORS (para ver el motivo real)
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
  console.log("✅ Allowed origins:", allowedOrigins);
});
