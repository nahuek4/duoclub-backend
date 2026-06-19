import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

import bcrypt from "bcryptjs";
import mongoose from "mongoose";

import User from "../models/User.js";
import Appointment from "../models/Appointment.js";
import { protect, adminOnly, adminOrProfessor } from "../middleware/auth.js";

import multer from "multer";

// MAIL
import {
  fireAndForget,
  sendUserApprovedEmail,
  sendUserApprovalResultEmail,
  sendAdminCreditsAssignedEmail,
  sendUserCreditsAssignedEmail,
  sendMedicalClearanceStatusEmail,
} from "../mail.js";
import { BRAND_URL, sendMail } from "../mail/core.js";
import { sendVerifyEmail } from "../mail/authEmails.js";
import {
  logActivity,
  buildUserSubject,
  buildDiff,
} from "../lib/activityLogger.js";

const router = express.Router();

/* ============================================
   CONFIG GLOBAL: VENCIMIENTO CRÉDITOS
============================================ */
const CREDITS_EXPIRE_DAYS = 30;

/* ============================================
   PATHS
============================================ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const uploadRoot = path.join(__dirname, "..", "..", "uploads");
const aptosDir = path.join(uploadRoot, "aptos");

if (!fs.existsSync(uploadRoot)) fs.mkdirSync(uploadRoot, { recursive: true });
if (!fs.existsSync(aptosDir)) fs.mkdirSync(aptosDir, { recursive: true });

function safeUnlink(absPath) {
  try {
    if (absPath && fs.existsSync(absPath)) fs.unlinkSync(absPath);
  } catch {
    // no-op
  }
}

function absFromPublicUploadsPath(publicPath) {
  const raw = String(publicPath || "").trim();
  if (!raw) return "";

  const clean = raw.split("?")[0].split("#")[0];
  const parts = clean.split("/").filter(Boolean);

  const uploadsIdx = parts.findIndex((p) => p === "uploads");
  if (uploadsIdx === -1) {
    const filename = path.basename(clean);
    return filename ? path.join(uploadRoot, filename) : "";
  }

  const relParts = parts.slice(uploadsIdx + 1);
  if (!relParts.length) return "";

  const safeParts = relParts.map((p) => path.basename(p)).filter(Boolean);
  if (!safeParts.length) return "";

  return path.join(uploadRoot, ...safeParts);
}

/* ============================================
   VALIDACIÓN ID
============================================ */
function validateObjectIdParam(req, res, next) {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(String(id || ""))) {
    return res.status(400).json({ error: "ID inválido." });
  }
  next();
}

const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RF", "RA", "KD", "SYN", "NUT"]);

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RF: "Reeducación Funcional",
  RA: "Rehabilitación Activa",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
  NUT: "Nutrición",
};

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function canonicalServiceKeyFromValue(value) {
  const up = String(value || "").toUpperCase().trim();
  if (ALLOWED_SERVICE_KEYS.has(up)) return up;

  const s = stripAccents(value).toLowerCase().trim();

  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("kinefilaxia") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("synergy")) return "SYN";
  if (s.includes("nutric")) return "NUT";

  return "";
}

function prettyServiceName(value) {
  const key = canonicalServiceKeyFromValue(value);
  if (key) return SERVICE_KEY_TO_NAME[key];
  return String(value || "Sesión").trim() || "Sesión";
}

function formatHistoryHumanDate(dateStr) {
  try {
    const [y, m, d] = String(dateStr || "").split("-").map(Number);
    if (!y || !m || !d) return "";
    const dt = new Date(y, m - 1, d);

    const weekday = dt.toLocaleDateString("es-AR", { weekday: "long" });
    const cap = weekday.charAt(0).toUpperCase() + weekday.slice(1).toLowerCase();

    const dd = String(d).padStart(2, "0");
    const mm = String(m).padStart(2, "0");
    const yy = String(y).slice(-2);

    return `${cap} ${dd}/${mm}/${yy}`;
  } catch {
    return "";
  }
}

function humanProfileFieldLabel(field) {
  const f = String(field || "").trim().toLowerCase();
  if (f === "name") return "el Nombre";
  if (f === "lastname" || f === "lastName".toLowerCase()) return "el Apellido";
  if (f === "phone") return "el Teléfono";
  if (f === "dni") return "el DNI";
  return "su información personal";
}

function pushUserHistory(user, item = {}) {
  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    action: String(item.action || "").trim() || "activity",
    title: String(item.title || "").trim(),
    message: String(item.message || "").trim(),
    field: String(item.field || "").trim(),
    date: String(item.date || "").trim(),
    time: String(item.time || "").trim(),
    service: String(item.service || "").trim(),
    serviceName: String(item.serviceName || item.service || "").trim(),
    serviceKey: String(item.serviceKey || "").trim(),
    qty: Number(item.qty || 0) || 0,
    createdAt: item.createdAt || new Date(),
  });
}

function buildLegacyAppointmentHistoryTitle(ap) {
  const svc = prettyServiceName(ap?.serviceKey || ap?.service || ap?.serviceName || "");
  const when = formatHistoryHumanDate(ap?.date);

  if (String(ap?.status || "").toLowerCase() === "cancelled") {
    return `Canceló el turno de ${svc} el ${when}.`;
  }

  return `Reservó turno para ${svc} el ${when}.`;
}

/* ============================================
   MULTER APTOS
============================================ */
const aptoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, aptosDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".pdf";
    const base = "apto-" + req.params.id + "-" + Date.now();
    cb(null, base + ext);
  },
});

const uploadApto = multer({
  storage: aptoStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const nameOk = String(file.originalname || "")
      .toLowerCase()
      .endsWith(".pdf");
    const mimeOk =
      file.mimetype === "application/pdf" ||
      file.mimetype === "application/octet-stream";
    if (!nameOk && !mimeOk) return cb(new Error("Solo se permite PDF."));
    cb(null, true);
  },
});

function uploadAptoSingle(req, res, next) {
  const handler = uploadApto.single("apto");
  handler(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "El PDF supera el límite de 10MB." });
    }
    return res
      .status(400)
      .json({ error: err.message || "Error al subir el archivo." });
  });
}

/* ============================================
   MULTER AVATAR
============================================ */
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadRoot),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    const base = "avatar-" + req.params.id + "-" + Date.now();
    cb(null, base + ext);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const mt = String(file.mimetype || "");
    if (!mt.startsWith("image/"))
      return cb(new Error("Solo se permiten imágenes."));
    cb(null, true);
  },
});

function avatarUploadSingle(req, res, next) {
  const handler = avatarUpload.single("photo");
  handler(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res
        .status(400)
        .json({ error: "La imagen supera el límite de 5MB." });
    }
    return res
      .status(400)
      .json({ error: err.message || "Error al subir la imagen." });
  });
}

/* ============================================
   HELPERS: CREDIT LOTS
============================================ */
function nowDate() {
  return new Date();
}

function isPlusActive(user) {
  const m = user?.membership || {};
  const tier = String(m.tier || "").toLowerCase().trim();
  if (tier !== "plus") return false;
  if (!m.activeUntil) return false;
  return new Date(m.activeUntil) > new Date();
}

function getMonthlyCancelLimit(user) {
  return isPlusActive(user) ? 3 : 2;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(Math.max(x, min), max);
}

function normalizeMembershipForUI(user) {
  const m = user?.membership || {};
  const plus = isPlusActive(user);
  const limit = getMonthlyCancelLimit(user);

  const cancelHoursDefault = plus ? 12 : 24;
  const expireDaysDefault = CREDITS_EXPIRE_DAYS;

  const tierNorm = String(m.tier || (plus ? "plus" : "basic"))
    .toLowerCase()
    .trim();

  return {
    tier: tierNorm || "basic",
    activeUntil: m.activeUntil || null,
    cancelHours: clamp(m.cancelHours ?? cancelHoursDefault, 1, 999),
    cancelsLeft: clamp(m.cancelsLeft ?? limit, 0, limit),
    creditsExpireDays: clamp(m.creditsExpireDays ?? expireDaysDefault, 1, 999),
  };
}


function recalcUserCredits(user) {
  const now = nowDate();
  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
  const sum = lots.reduce((acc, lot) => {
    const exp = lot.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return acc;
    return acc + Number(lot.remaining || 0);
  }, 0);
  user.credits = sum;
}

function lastDayOfCurrentMonth() {
  const now = nowDate();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
}


function normalizeLotServiceKey(lot) {
  return (
    canonicalServiceKeyFromValue(lot?.serviceKey) ||
    canonicalServiceKeyFromValue(lot?.service) ||
    canonicalServiceKeyFromValue(lot?.serviceName) ||
    ""
  );
}

function fixedScheduleDebtByServiceKey(u) {
  const raw = u?.fixedScheduleDebt || {};
  return {
    PE: 0,
    EP: Math.max(0, Number(raw?.EP || 0)),
    RF: Math.max(0, Number(raw?.RF || 0)),
    RA: Math.max(0, Number(raw?.RA || 0)),
    KD: Math.max(0, Number(raw?.KD || 0)),
    SYN: Math.max(0, Number(raw?.SYN || 0)),
    NUT: 0,
  };
}

function computeServiceAccessFromLots(u) {
  const now = new Date();
  const lots = Array.isArray(u?.creditLots) ? u.creditLots : [];
  const byKey = { PE: 0, EP: 0, RF: 0, RA: 0, KD: 0, SYN: 0, NUT: 0 };

  for (const lot of lots) {
    const remaining = Number(lot?.remaining || 0);
    if (remaining <= 0) continue;

    const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) continue;

    const sk = normalizeLotServiceKey(lot);
    if (byKey[sk] !== undefined) byKey[sk] += remaining;
  }

  const debtByServiceKey = fixedScheduleDebtByServiceKey(u);
  const creditsByServiceKey = { PE: 0, EP: 0, RF: 0, RA: 0, KD: 0, SYN: 0, NUT: 0 };
  const availableCreditsByServiceKey = { PE: 0, EP: 0, RF: 0, RA: 0, KD: 0, SYN: 0, NUT: 0 };

  for (const k of Object.keys(availableCreditsByServiceKey)) {
    availableCreditsByServiceKey[k] = Number(byKey[k] || 0);
    creditsByServiceKey[k] = Number(byKey[k] || 0) - Number(debtByServiceKey[k] || 0);
  }

  const allowedServices = [];
  const serviceCredits = {};

  for (const k of ["EP", "RF", "RA", "KD", "SYN", "NUT"]) {
    const available = Number(availableCreditsByServiceKey[k] || 0);
    const debt = Number(debtByServiceKey[k] || 0);
    const net = Number(creditsByServiceKey[k] || 0);

    // Mostrar como servicio activo si tiene créditos, deuda o saldo neto distinto de cero.
    if (available > 0 || debt > 0 || net !== 0) {
      const label = SERVICE_KEY_TO_NAME[k] || k;
      allowedServices.push(label);
      serviceCredits[label] = net;
    }
  }

  if (!u?.firstEvaluationCompleted) {
    const peCredits = Number(byKey.PE || 0);
    if (peCredits > 0) {
      allowedServices.unshift("Primera evaluación presencial");
      serviceCredits["Primera evaluación presencial"] = peCredits;
    }
    creditsByServiceKey.PE = peCredits;
  }

  return {
    allowedServices,
    serviceCredits,
    creditsByServiceKey,
    availableCreditsByServiceKey,
    fixedScheduleDebt: debtByServiceKey,
  };
}

function sumCreditsForService(user, serviceKey) {
  const now = nowDate();
  const want = canonicalServiceKeyFromValue(serviceKey);
  if (!want) return 0;

  const lots = Array.isArray(user?.creditLots) ? user.creditLots : [];

  return lots.reduce((acc, lot) => {
    const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return acc;

    const lk = normalizeLotServiceKey(lot);
    const rem = Number(lot?.remaining || 0);
    if (rem <= 0) return acc;

    if (lk === want) return acc + rem;
    return acc;
  }, 0);
}

function consumeCreditsForService(user, toRemove, serviceKey) {
  const now = nowDate();
  let left = Math.max(0, Number(toRemove || 0));

  const want = canonicalServiceKeyFromValue(serviceKey);
  if (!want) {
    const err = new Error("serviceKey inválido.");
    err.status = 400;
    throw err;
  }

  const lots = Array.isArray(user?.creditLots) ? user.creditLots : [];

  const sorted = lots
    .filter((l) => Number(l?.remaining || 0) > 0)
    .filter((l) => !l?.expiresAt || new Date(l.expiresAt) > now)
    .filter((l) => normalizeLotServiceKey(l) === want)
    .sort((a, b) => {
      const ae = a?.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
      const be = b?.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
      if (ae !== be) return ae - be;

      const ac = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bc = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return ac - bc;
    });

  for (const lot of sorted) {
    if (left <= 0) break;
    const take = Math.min(Number(lot?.remaining || 0), left);
    lot.remaining = Number(lot?.remaining || 0) - take;
    left -= take;
  }

  if (left > 0) {
    const err = new Error("No hay créditos suficientes para ese servicio.");
    err.status = 400;
    throw err;
  }

  recalcUserCredits(user);
}


function ensureFixedScheduleDebt(user) {
  user.fixedScheduleDebt = user.fixedScheduleDebt || {};
  for (const k of ["EP", "RA", "RF", "KD", "SYN"]) {
    const n = Number(user.fixedScheduleDebt?.[k] || 0);
    user.fixedScheduleDebt[k] = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  }
}

async function settleFixedScheduleDebt(user, { amount, serviceKey, source = "credits" } = {}) {
  const sk = canonicalServiceKeyFromValue(serviceKey);
  if (!sk) return { settled: 0, remaining: Math.max(0, Math.trunc(Number(amount || 0))), settledAppointmentIds: [] };

  const qty = Math.max(0, Math.trunc(Number(amount || 0)));
  if (!qty) return { settled: 0, remaining: 0, settledAppointmentIds: [] };

  ensureFixedScheduleDebt(user);

  const currentDebt = Math.max(0, Number(user.fixedScheduleDebt?.[sk] || 0));
  if (!currentDebt) return { settled: 0, remaining: qty, settledAppointmentIds: [] };

  const settled = Math.min(currentDebt, qty);
  const remaining = qty - settled;
  const now = nowDate();

  user.fixedScheduleDebt[sk] = currentDebt - settled;
  user.markModified?.("fixedScheduleDebt");

  // IMPORTANTE:
  // Cuando el admin agrega créditos y esos créditos se usan para saldar deuda
  // de turnos fijos, también marcamos los turnos futuros en deuda como
  // "mensualmente reservados". Si no hacemos esto, después el usuario cancela
  // esos turnos y el sistema no sabe que esa deuda ya fue pagada con créditos,
  // por eso no podía devolver las últimas cancelaciones.
  const settledAppointments = await Appointment.find({
    user: user._id,
    serviceKey: sk,
    status: "reserved",
    fixedScheduleId: { $ne: null },
    creditLotId: null,
    $or: [
      { creditDebitStatus: "debt" },
      { fixedDebtAmount: { $gt: 0 } },
    ],
  })
    .sort({ date: 1, time: 1, createdAt: 1 })
    .limit(settled);

  const settledAppointmentIds = settledAppointments.map((ap) => ap._id);

  if (settledAppointmentIds.length) {
    await Appointment.updateMany(
      { _id: { $in: settledAppointmentIds } },
      {
        $set: {
          creditDebitStatus: "monthly_reserved",
          fixedDebtAmount: 0,
          creditDebitedAt: now,
          fixedDebitProcessedAt: now,
          refundReason: "FIXED_DEBT_SETTLED_BY_ADMIN_CREDITS",
        },
      }
    );
  }

  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    action: "fixed_schedule_debt_settled",
    title: `Deuda de turnos fijos saldada ${sk}`,
    message: `Se usaron ${settled} crédito(s) acreditados para saldar deuda pendiente de turnos fijos.${settledAppointmentIds.length ? " Los turnos asociados quedaron marcados como pagados para permitir reintegro si se cancelan dentro de política." : ""}`,
    serviceKey: sk,
    serviceName: SERVICE_KEY_TO_NAME[sk] || sk,
    service: SERVICE_KEY_TO_NAME[sk] || sk,
    qty: settled,
    createdAt: now,
  });

  return { settled, remaining, settledAppointmentIds };
}

async function addCreditLot(
  user,
  { amount, serviceKey, source = "admin-adjust" }
) {
  const sk = canonicalServiceKeyFromValue(serviceKey);
  if (!sk) {
    const err = new Error("serviceKey inválido.");
    err.status = 400;
    throw err;
  }

  const qty = Math.max(0, Number(amount || 0));
  if (!qty) return;

  const now = nowDate();
  const debtSettlement = await settleFixedScheduleDebt(user, { amount: qty, serviceKey: sk, source });
  const remainingQty = Math.max(0, Number(debtSettlement.remaining || 0));
  if (!remainingQty) {
    recalcUserCredits(user);
    return;
  }

  const exp = lastDayOfCurrentMonth();

  user.creditLots = user.creditLots || [];
  user.creditLots.push({
    serviceKey: sk,
    amount: remainingQty,
    remaining: remainingQty,
    expiresAt: exp,
    source,
    orderId: null,
    createdAt: now,
  });

  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    action: "credits_added_monthly",
    title: `Créditos acreditados ${sk}`,
    message: `Se acreditaron ${remainingQty} crédito(s), con vencimiento el último día del mes.${debtSettlement.settled ? ` Antes se saldaron ${debtSettlement.settled} crédito(s) adeudados.` : ""}`,
    serviceKey: sk,
    serviceName: SERVICE_KEY_TO_NAME[sk] || sk,
    service: SERVICE_KEY_TO_NAME[sk] || sk,
    qty: remainingQty,
    createdAt: now,
  });

  recalcUserCredits(user);
}

function buildCreditsByService(user) {
  const firstEvaluationCompleted = !!user?.firstEvaluationCompleted;
  const debt = fixedScheduleDebtByServiceKey(user);

  const result = {
    EP: sumCreditsForService(user, "EP") - Number(debt.EP || 0),
    RF: sumCreditsForService(user, "RF") - Number(debt.RF || 0),
    RA: sumCreditsForService(user, "RA") - Number(debt.RA || 0),
    KD: sumCreditsForService(user, "KD") - Number(debt.KD || 0),
    SYN: sumCreditsForService(user, "SYN") - Number(debt.SYN || 0),
    NUT: sumCreditsForService(user, "NUT"),
  };

  if (!firstEvaluationCompleted) {
    result.PE = sumCreditsForService(user, "PE");
  }

  return result;
}

function stripSensitive(u) {
  if (!u || typeof u !== "object") return u;
  const {
    password,
    emailVerificationToken,
    emailVerificationExpires,
    __v,
    ...rest
  } = u;
  return rest;
}

function decorateUserForResponse(rawUser, { includeClinicalNotes = true } = {}) {
  if (!rawUser) return rawUser;

  const u = { ...rawUser };
  recalcUserCredits(u);

  const svc = computeServiceAccessFromLots(u);
  const membership = normalizeMembershipForUI(u);
  const creditsByService = buildCreditsByService(u);

  const safe = stripSensitive(u);

  if (!includeClinicalNotes) {
    const { clinicalNotes, ...withoutClinical } = safe;
    return {
      ...withoutClinical,
      ...svc,
      membership,
      creditsByService,
      creditsByServiceKey: svc.creditsByServiceKey,
      availableCreditsByServiceKey: svc.availableCreditsByServiceKey,
      fixedScheduleDebt: svc.fixedScheduleDebt,
      firstEvaluationCompleted: !!u.firstEvaluationCompleted,
      firstEvaluationCompletedAt: u.firstEvaluationCompletedAt || null,
    };
  }

  return {
    ...safe,
    ...svc,
    membership,
    creditsByService,
    creditsByServiceKey: svc.creditsByServiceKey,
    availableCreditsByServiceKey: svc.availableCreditsByServiceKey,
    fixedScheduleDebt: svc.fixedScheduleDebt,
    firstEvaluationCompleted: !!u.firstEvaluationCompleted,
    firstEvaluationCompletedAt: u.firstEvaluationCompletedAt || null,
  };
}


/* ============================================
   HELPERS: APTO FÍSICO / SUSPENSIÓN MÉDICA
============================================ */
function ensureMedicalClearance(user) {
  if (!user.medicalClearance || typeof user.medicalClearance !== "object") {
    const startedAt = user.createdAt || new Date();
    const dueAt = new Date(startedAt);
    dueAt.setDate(dueAt.getDate() + 30);
    user.medicalClearance = {
      status: "not_submitted",
      startedAt,
      dueAt,
      approvedAt: null,
      rejectedAt: null,
      suspendedAt: null,
      lastReminder10At: null,
      lastReminder20At: null,
      lastReminder30At: null,
      lastCheckedAt: null,
      notes: "",
    };
  }

  if (!user.medicalClearance.startedAt) {
    user.medicalClearance.startedAt = user.createdAt || new Date();
  }

  if (!user.medicalClearance.dueAt) {
    const dueAt = new Date(user.medicalClearance.startedAt || user.createdAt || Date.now());
    dueAt.setDate(dueAt.getDate() + 30);
    user.medicalClearance.dueAt = dueAt;
  }

  return user.medicalClearance;
}

function setMedicalClearanceStatus(user, status, { notes = "", actor = "admin" } = {}) {
  const now = new Date();
  const st = String(status || "").toLowerCase().trim();
  const mc = ensureMedicalClearance(user);
  const prev = mc.status || "not_submitted";

  if (!["not_submitted", "pending_review", "approved", "rejected", "suspended"].includes(st)) {
    const err = new Error("Estado de apto inválido.");
    err.status = 400;
    throw err;
  }

  mc.status = st;
  if (notes) mc.notes = String(notes || "").trim();
  mc.lastCheckedAt = now;

  if (st === "approved") {
    mc.approvedAt = now;
    mc.rejectedAt = null;
    mc.suspendedAt = null;
    user.aptoStatus = "approved";
    user.aptoCompletedAt = now;

    if (user.suspended && String(user.suspendedReason || "") === "medical_clearance") {
      user.suspended = false;
      user.suspendedReason = "";
      user.suspendedAt = null;
    }
  }

  if (st === "pending_review") {
    user.aptoStatus = "pending_review";
  }

  if (st === "not_submitted") {
    user.aptoStatus = "not_submitted";
    user.aptoCompletedAt = null;
  }

  if (st === "rejected") {
    mc.rejectedAt = now;
    user.aptoStatus = "rejected";
  }

  if (st === "suspended") {
    mc.suspendedAt = mc.suspendedAt || now;
    user.suspended = true;
    user.suspendedReason = "medical_clearance";
    user.suspendedAt = user.suspendedAt || now;
  }

  pushUserHistory(user, {
    action: "medical_clearance_status_updated",
    title: "Estado de apto físico actualizado",
    message: `Estado anterior: ${prev}. Estado nuevo: ${st}.`,
    field: "medicalClearance.status",
    createdAt: now,
  });

  return mc;
}

async function sendAptoStatusEmail(user, status, opts = {}) {
  return sendMedicalClearanceStatusEmail(user, status, {
    note: opts?.note || opts?.notes || user?.medicalClearance?.notes || "",
  });
}

/* ============================================
   HELPERS: MAIL CRÉDITOS
============================================ */
function adminActorNameFromReq(req) {
  const me = req?.user || {};
  const full =
    `${String(me?.name || "").trim()} ${String(me?.lastName || "").trim()}`.trim() ||
    String(me?.email || "").trim() ||
    "Admin";
  return full;
}

function normalizeCreditMailItems(items) {
  const list = Array.isArray(items) ? items : [];

  return list
    .map((it) => {
      const serviceKey = String(it?.serviceKey || "")
        .trim()
        .toUpperCase();

      const hasDelta = it?.delta !== undefined && it?.delta !== null;
      const raw = hasDelta ? Number(it.delta) : Number(it.credits);

      if (!serviceKey || !Number.isFinite(raw) || raw === 0) return null;

      return {
        serviceKey,
        ...(hasDelta
          ? { delta: Math.trunc(raw) }
          : { credits: Math.trunc(raw) }),
      };
    })
    .filter(Boolean);
}

function queueCreditsEmails({ req, updatedUser, items }) {
  const safeItems = normalizeCreditMailItems(items);
  if (!updatedUser || !safeItems.length) return;

  const actorName = adminActorNameFromReq(req);

  fireAndForget(async () => {
    try {
      await sendAdminCreditsAssignedEmail({
        user: updatedUser,
        items: safeItems,
        actorName,
      });

      await sendUserCreditsAssignedEmail({
        user: updatedUser,
        items: safeItems,
        actorName,
      });

      console.log("[MAIL][CREDITS] mails SENT ok", {
        userId: String(updatedUser?._id || updatedUser?.id || ""),
        email: updatedUser?.email,
        items: safeItems,
      });
    } catch (e) {
      console.log("[MAIL][CREDITS] mails FAILED", {
        userId: String(updatedUser?._id || updatedUser?.id || ""),
        email: updatedUser?.email,
        error: e?.message || e,
      });
    }
  }, "USER_CREDITS_MAIL");
}

/* ============================================
   HELPERS: PLAN MENSUAL
============================================ */
function createDefaultMonthlyPlan() {
  const makeWeek = (weekNumber) => ({
    weekNumber,
    series: "",
    reps: "",
    rir: "",
  });

  const makeRow = () => ({
    exercise: "",
    weekCells: {
      1: ["", "", "", ""],
      2: ["", "", "", ""],
      3: ["", "", "", ""],
      4: ["", "", "", ""],
    },
  });

  const makeSection = (key) => ({
    key,
    rows: [makeRow(), makeRow(), makeRow()],
  });

  const makeDay = (dayNumber) => ({
    dayNumber,
    sections: [makeSection("B2"), makeSection("B3")],
  });

  return {
    meta: {
      fullName: "",
      age: "",
      weight: "",
      height: "",
      healthConditions: "",
      trainingPeriod: "",
      objective: "",
      weeklyFrequency: "",
      startDate: "",
      mesocycleNumber: "",
      observations: "",
    },
    weeks: [makeWeek(1), makeWeek(2), makeWeek(3), makeWeek(4)],
    days: [makeDay(1), makeDay(2), makeDay(3)],
    footer: {
      activation: "Plan del día.",
      finisher: "A criterio de cada entrenador (metabólico, accesorios).",
      cooldown: "Plan del día o estiramiento comunitario.",
    },
    updatedAt: null,
    updatedBy: "",
  };
}

function safePlanStr(v, max = 1000) {
  return String(v ?? "").slice(0, max).trim();
}

function normalizeWeekCells(input) {
  const out = {
    1: ["", "", "", ""],
    2: ["", "", "", ""],
    3: ["", "", "", ""],
    4: ["", "", "", ""],
  };

  for (const wk of [1, 2, 3, 4]) {
    const arr = Array.isArray(input?.[wk]) ? input[wk] : [];
    out[wk] = [0, 1, 2, 3].map((i) => safePlanStr(arr[i] || "", 40));
  }

  return out;
}

function sanitizeMonthlyPlanPayload(payload = {}, targetUser = null, actor = null) {
  const base = createDefaultMonthlyPlan();

  const fullNameFromUser = targetUser
    ? `${String(targetUser.name || "").trim()} ${String(targetUser.lastName || "").trim()}`.trim()
    : "";

  const meta = payload?.meta || {};
  const weeks = Array.isArray(payload?.weeks) ? payload.weeks : [];
  const days = Array.isArray(payload?.days) ? payload.days : [];
  const footer = payload?.footer || {};

  const actorName =
    `${String(actor?.name || "").trim()} ${String(actor?.lastName || "").trim()}`.trim() ||
    String(actor?.email || "").trim() ||
    "Staff";

  return {
    meta: {
      fullName: safePlanStr(meta.fullName || fullNameFromUser, 120),
      age: safePlanStr(meta.age, 20),
      weight: safePlanStr(meta.weight, 20),
      height: safePlanStr(meta.height, 20),
      healthConditions: safePlanStr(meta.healthConditions, 800),
      trainingPeriod: safePlanStr(meta.trainingPeriod, 120),
      objective: safePlanStr(meta.objective, 300),
      weeklyFrequency: safePlanStr(meta.weeklyFrequency, 60),
      startDate: safePlanStr(meta.startDate, 40),
      mesocycleNumber: safePlanStr(meta.mesocycleNumber, 40),
      observations: safePlanStr(meta.observations, 1200),
    },

    weeks: [1, 2, 3, 4].map((n, idx) => ({
      weekNumber: n,
      series: safePlanStr(weeks[idx]?.series, 40),
      reps: safePlanStr(weeks[idx]?.reps, 40),
      rir: safePlanStr(weeks[idx]?.rir, 40),
    })),

    days: [1, 2, 3].map((dayNumber, dayIdx) => {
      const srcDay = days[dayIdx] || {};
      const srcSections = Array.isArray(srcDay.sections) ? srcDay.sections : [];

      return {
        dayNumber,
        sections: ["B2", "B3"].map((sectionKey, secIdx) => {
          const srcSection = srcSections[secIdx] || {};
          const srcRows = Array.isArray(srcSection.rows) ? srcSection.rows : [];

          return {
            key: sectionKey,
            rows: [0, 1, 2].map((rowIdx) => ({
              exercise: safePlanStr(srcRows[rowIdx]?.exercise, 120),
              weekCells: normalizeWeekCells(srcRows[rowIdx]?.weekCells),
            })),
          };
        }),
      };
    }),

    footer: {
      activation: safePlanStr(footer.activation || base.footer.activation, 300),
      finisher: safePlanStr(footer.finisher || base.footer.finisher, 300),
      cooldown: safePlanStr(footer.cooldown || base.footer.cooldown, 300),
    },

    updatedAt: new Date(),
    updatedBy: actorName,
  };
}

function ensureMonthlyPlan(user) {
  if (!user.monthlyPlan) {
    user.monthlyPlan = createDefaultMonthlyPlan();
  }

  const normalized = sanitizeMonthlyPlanPayload(user.monthlyPlan, user, {
    name: user.monthlyPlan?.updatedBy || "",
    lastName: "",
    email: "",
  });

  if (!normalized.meta.fullName) {
    normalized.meta.fullName =
      `${String(user.name || "").trim()} ${String(user.lastName || "").trim()}`.trim();
  }

  user.monthlyPlan = normalized;
  return user.monthlyPlan;
}

/* ============================================
   TODAS LAS RUTAS REQUIEREN LOGIN
============================================ */
router.use(protect);

/* ============================================
   TEST SMTP
============================================ */
router.post("/test-mail", adminOnly, async (req, res) => {
  try {
    const to =
      String(req.body?.to || "").trim() ||
      String(req.user?.email || "").trim() ||
      String(process.env.ADMIN_EMAIL || "").trim();

    if (!to) {
      return res.status(400).json({
        error: "Falta destinatario. Enviá { to } o configurá ADMIN_EMAIL.",
      });
    }

    const now = new Date();
    const subject = `🧪 Test SMTP - DUO - ${now.toLocaleString("es-AR")}`;

    const text = [
      "Este es un mail de prueba del sistema DUO.",
      "",
      `Fecha: ${now.toLocaleString("es-AR")}`,
      `Destino: ${to}`,
      `Ejecutado por: ${String(req.user?.email || "admin")}`,
      "",
      "Si recibiste este correo, el SMTP está funcionando correctamente.",
    ].join("\n");

    const html = `
      <div style="font-family:Arial,sans-serif; color:#111; line-height:1.5;">
        <h2 style="margin:0 0 12px;">Test SMTP - DUO</h2>
        <p>Este es un mail de prueba del sistema.</p>
        <p><b>Fecha:</b> ${now.toLocaleString("es-AR")}</p>
        <p><b>Destino:</b> ${to}</p>
        <p><b>Ejecutado por:</b> ${String(req.user?.email || "admin")}</p>
        <p style="margin-top:16px;">
          Si recibiste este correo, el SMTP está funcionando correctamente.
        </p>
      </div>
    `;

    const info = await sendMail(to, subject, text, html);

    return res.json({
      ok: true,
      message: "Mail de prueba enviado.",
      to,
      messageId: info?.messageId || null,
      accepted: info?.accepted || [],
      rejected: info?.rejected || [],
      response: info?.response || null,
    });
  } catch (err) {
    console.error("Error en POST /users/test-mail:", err);

    return res.status(500).json({
      ok: false,
      error: "No se pudo enviar el mail de prueba.",
      detail: err?.message || String(err),
      code: err?.code || null,
      command: err?.command || null,
      response: err?.response || null,
      responseCode: err?.responseCode || null,
    });
  }
});

/* ============================================
   ADMIN - REGISTRACIONES
============================================ */
router.get("/registrations/list", adminOnly, async (req, res) => {
  try {
    const status = String(req.query.status || "pending");
    const query = {};
    if (status === "pending") query.approvalStatus = "pending";
    if (status === "approved") query.approvalStatus = "approved";
    if (status === "rejected") query.approvalStatus = "rejected";

    const users = await User.find(query).sort({ createdAt: -1 }).lean();

    return res.json(users.map((u) => decorateUserForResponse(u)));
  } catch (err) {
    console.error("Error en GET /users/registrations/list:", err);
    return res.status(500).json({ error: "Error al obtener registraciones." });
  }
});

router.post("/", adminOnly, async (req, res) => {
  try {
    const {
      name,
      lastName,
      email,
      phone,
      dni,
      age,
      weight,
      notes,
      credits,
      initialServiceKey,
      role,
      password,
    } = req.body || {};

    const n = String(name || "").trim();
    const ln = String(lastName || "").trim();
    const em = String(email || "").trim().toLowerCase();
    const ph = String(phone || "").trim();

    if (!n || !ln || !em || !ph) {
      return res.status(400).json({
        error: "Nombre, apellido, teléfono y email son obligatorios.",
      });
    }

    const plainPassword =
      password && String(password).trim().length >= 4
        ? String(password).trim()
        : Math.random().toString(36).slice(2, 10);

    const hashed = await bcrypt.hash(plainPassword, 10);

    const user = await User.create({
      name: n,
      lastName: ln,
      email: em,
      phone: ph,
      dni: dni || "",
      age: age ?? null,
      weight: weight ?? null,
      notes: notes || "",
      credits: 0,
      creditLots: [],
      role: role || "client",
      password: hashed,
      mustChangePassword: true,
      suspended: false,
      suspendedReason: "",
      suspendedAt: null,
      emailVerified: true,
      approvalStatus: "approved",
      aptoPath: "",
      aptoStatus: "not_submitted",
      medicalClearance: undefined,
      welcomeApprovedEmailSentAt: new Date(),
      firstEvaluationCompleted: false,
      firstEvaluationCompletedAt: null,
    });

    const initialCredits = Number(credits ?? 0);
    if (initialCredits > 0) {
      await addCreditLot(user, {
        amount: initialCredits,
        serviceKey: initialServiceKey,
        source: "admin-create",
      });
      await user.save();
    }

    fireAndForget(
      async () => {
        await sendUserApprovedEmail({
          to: em,
          user: { name: n, lastName: ln, email: em },
          password: plainPassword,
        });
      },
      "MAIL_APPROVED_CREATE"
    );

    const uLean =
      (await User.findById(user._id).lean()) || user.toObject?.() || user;

    await logActivity({
      req,
      category: "users",
      action: "user_created",
      entity: "user",
      entityId: user._id,
      title: "Usuario creado",
      description: (`Se creó el usuario ${n} ${ln}`).trim(),
      subject: buildUserSubject(user),
      meta: { initialCredits, createdBy: "admin" },
    });

    return res.status(201).json({
      ok: true,
      user: decorateUserForResponse(uLean),
      tempPassword: password ? undefined : plainPassword,
    });
  } catch (err) {
    console.error("Error en POST /users:", err);
    if (err.code === 11000 && err.keyPattern?.email) {
      return res
        .status(400)
        .json({ error: "Ya existe un usuario con ese email." });
    }
    return res.status(500).json({ error: "Error al crear usuario." });
  }
});

router.get("/", adminOrProfessor, async (req, res) => {
  try {
    const role = String(req.user?.role || "").toLowerCase();
    const isAdmin = role === "admin";

    const list = await User.find().lean();

    return res.json(
      list.map((u) =>
        decorateUserForResponse(u, {
          includeClinicalNotes: isAdmin,
        })
      )
    );
  } catch (err) {
    console.error("Error en GET /users:", err);
    return res.status(500).json({ error: "Error al obtener usuarios." });
  }
});

router.get("/pending", adminOnly, async (req, res) => {
  try {
    const pending = await User.find({ approvalStatus: "pending" })
      .sort({ createdAt: -1 })
      .lean();

    return res.json(pending.map((u) => decorateUserForResponse(u)));
  } catch (err) {
    console.error("Error en GET /users/pending:", err);
    return res.status(500).json({ error: "Error al obtener pendientes." });
  }
});

router.post("/:id/resend-verification", adminOnly, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    const email = String(user.email || "").trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: "El usuario no tiene email cargado." });
    }

    if (user.emailVerified) {
      return res.status(400).json({
        error: "Este usuario ya tiene el email verificado.",
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);

    user.emailVerificationToken = token;
    user.emailVerificationExpires = expiresAt;

    pushUserHistory(user, {
      action: "email_verification_resent",
      title: "Se reenvió el mail de verificación.",
      message: "Un admin reenvió el link de verificación de email.",
      createdAt: new Date(),
    });

    await user.save();

    const baseUrl = String(
      process.env.BRAND_URL ||
        process.env.FRONTEND_URL ||
        BRAND_URL ||
        "https://duoclub.ar"
    )
      .trim()
      .replace(/\/+$/, "");

    const verifyUrl = `${baseUrl}/agenda/verificar-email?token=${encodeURIComponent(token)}`;

    await sendVerifyEmail(user, verifyUrl);

    await logActivity({
      req,
      category: "users",
      action: "email_verification_resent",
      entity: "user",
      entityId: user._id,
      title: "Verificación reenviada",
      description: "Un admin reenvió el mail de verificación de email.",
      subject: buildUserSubject(user),
      meta: { email, expiresAt },
    });

    return res.json({
      ok: true,
      message: "Mail de verificación reenviado correctamente.",
      emailVerified: !!user.emailVerified,
      emailVerificationExpires: user.emailVerificationExpires || null,
    });
  } catch (err) {
    console.error("Error en POST /users/:id/resend-verification:", err);
    return res.status(500).json({
      error: "No se pudo reenviar el mail de verificación.",
      detail: err?.message || String(err),
    });
  }
});

router.patch("/:id/approval", adminOnly, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;
    const status = String(req.body?.status || "").toLowerCase().trim();

    if (!["approved", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Estado inválido." });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (status === "approved" && !user.emailVerified) {
      return res
        .status(400)
        .json({ error: "No se puede aprobar: el email no está verificado." });
    }

    const prevStatus = String(user.approvalStatus || "pending");

    if (status === "rejected") {
      const to = String(user.email || "").trim();
      const shouldSendRejectionMail = !!to && prevStatus !== "rejected";

      if (shouldSendRejectionMail) {
        fireAndForget(
          () => sendUserApprovalResultEmail(user, "rejected"),
          "MAIL_REJECT_AND_DELETE"
        );
      }

      await Appointment.deleteMany({ user: user._id });

      await logActivity({
        req,
        category: "users",
        action: "user_rejected_deleted",
        entity: "user",
        entityId: user._id,
        title: "Usuario rechazado y eliminado",
        description: "Un admin rechazó el alta y eliminó al usuario.",
        subject: buildUserSubject(user),
        deletedSnapshot: user.toObject(),
      });

      await user.deleteOne();

      return res.json({
        ok: true,
        deleted: true,
        message: "Usuario rechazado y eliminado. Puede registrarse nuevamente.",
      });
    }

    user.approvalStatus = "approved";
    user.suspended = false;
    user.suspendedReason = "";
    user.suspendedAt = null;
    ensureMedicalClearance(user);

    const changed = prevStatus !== "approved";
    const shouldSendApprovalMail =
      changed &&
      !!String(user.email || "").trim() &&
      !user.welcomeApprovedEmailSentAt;

    if (shouldSendApprovalMail) user.welcomeApprovedEmailSentAt = new Date();

    await user.save();

    await logActivity({
      req,
      category: "users",
      action: "user_approval_updated",
      entity: "user",
      entityId: user._id,
      title: "Aprobación actualizada",
      description: `Estado de aprobación cambiado de ${prevStatus} a ${user.approvalStatus}.`,
      subject: buildUserSubject(user),
      diff: buildDiff(
        { approvalStatus: prevStatus },
        { approvalStatus: user.approvalStatus }
      ),
    });

    if (shouldSendApprovalMail) {
      fireAndForget(
        () => sendUserApprovalResultEmail(user, "approved"),
        "MAIL_APPROVED_WEB"
      );
    }

    return res.json({
      ok: true,
      approvalStatus: user.approvalStatus,
      suspended: user.suspended,
      emailVerified: user.emailVerified,
    });
  } catch (err) {
    console.error("Error en PATCH /users/:id/approval:", err);
    return res.status(500).json({ error: "Error al actualizar aprobación." });
  }
});

router.put("/:id", validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;

    const role = String(req.user?.role || "").toLowerCase();
    const isAdmin = role === "admin";
    const isProfessor = role === "profesor";
    const isStaff = isAdmin || isProfessor;
    const isSelf = req.user._id.toString() === id;

    if (!isStaff && !isSelf) {
      return res
        .status(403)
        .json({ error: "No tenés permiso para editar este usuario." });
    }

    const nextName =
      typeof req.body?.name === "string" ? req.body.name.trim() : undefined;
    const nextLastName =
      typeof req.body?.lastName === "string"
        ? req.body.lastName.trim()
        : undefined;
    const nextPhone =
      typeof req.body?.phone === "string" ? req.body.phone.trim() : undefined;
    const nextDni =
      typeof req.body?.dni === "string" ? req.body.dni.trim() : undefined;

    if (nextDni !== undefined && nextDni !== "" && !/^\d{6,10}$/.test(nextDni)) {
      return res.status(400).json({ error: "DNI inválido." });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    const changedFields = [];

    if (nextName !== undefined && nextName !== user.name) {
      user.name = nextName;
      changedFields.push("name");
    }

    if (nextLastName !== undefined && nextLastName !== user.lastName) {
      user.lastName = nextLastName;
      changedFields.push("lastName");
    }

    if (nextPhone !== undefined && nextPhone !== user.phone) {
      user.phone = nextPhone;
      changedFields.push("phone");
    }

    if (nextDni !== undefined && String(nextDni) !== String(user.dni || "")) {
      user.dni = nextDni;
      changedFields.push("dni");
    }

    if (!changedFields.length) {
      return res.status(400).json({ error: "No hay cambios para guardar." });
    }

    for (const field of changedFields) {
      pushUserHistory(user, {
        action: "profile_field_updated",
        field,
        title: `Modificó ${humanProfileFieldLabel(field)} de su información personal.`,
        createdAt: new Date(),
      });
    }

    await user.save();

    const saved = user.toObject();

    await logActivity({
      req,
      category: "users",
      action: "user_profile_updated",
      entity: "user",
      entityId: user._id,
      title: "Perfil actualizado",
      description: "Se actualizó información personal del usuario.",
      subject: buildUserSubject(user),
      meta: { changedFields },
    });

    return res.json(
      decorateUserForResponse(saved, {
        includeClinicalNotes: isAdmin,
      })
    );
  } catch (err) {
    console.error("Error en PUT /users/:id:", err);
    return res.status(500).json({ error: "Error interno." });
  }
});

router.get("/:id", validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;

    const role = String(req.user?.role || "").toLowerCase();
    const isAdmin = role === "admin";
    const isProfessor = role === "profesor";
    const isStaff = isAdmin || isProfessor;
    const isSelf = req.user._id.toString() === id;

    if (!isStaff && !isSelf) {
      return res
        .status(403)
        .json({ error: "No tenés permiso para ver este usuario." });
    }

    const u = await User.findById(id).lean();
    if (!u) return res.status(404).json({ error: "Usuario no encontrado." });

    return res.json(
      decorateUserForResponse(u, {
        includeClinicalNotes: isAdmin,
      })
    );
  } catch (err) {
    console.error("Error en GET /users/:id:", err);
    return res.status(500).json({ error: "Error interno." });
  }
});

router.patch("/:id/role", adminOnly, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;
    const rawRole = String(req.body?.role || "").toLowerCase().trim();

    const nextRole = rawRole === "usuario" ? "client" : rawRole;

    if (!["admin", "profesor", "client"].includes(nextRole)) {
      return res.status(400).json({ error: "Rol inválido." });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    user.role = nextRole;
    await user.save();

    return res.json({
      ok: true,
      user: decorateUserForResponse(user.toObject()),
    });
  } catch (err) {
    console.error("Error en PATCH /users/:id/role:", err);
    return res.status(500).json({ error: "Error al actualizar rol." });
  }
});

router.patch("/:id", adminOnly, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body || {};
    const u = await User.findByIdAndUpdate(id, updates, { new: true }).lean();
    if (!u) return res.status(404).json({ error: "Usuario no encontrado." });

    return res.json(decorateUserForResponse(u));
  } catch (err) {
    console.error("Error en PATCH /users/:id:", err);
    return res.status(500).json({ error: "Error interno." });
  }
});

router.delete("/:id", adminOnly, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    await Appointment.deleteMany({ user: id });

    await logActivity({
      req,
      category: "users",
      action: "user_deleted",
      entity: "user",
      entityId: user._id,
      title: "Usuario eliminado",
      description: "Un admin eliminó un usuario.",
      subject: buildUserSubject(user),
      deletedSnapshot: user.toObject(),
    });

    await user.deleteOne();

    return res.json({
      ok: true,
      message: "Usuario y turnos asociados eliminados correctamente.",
    });
  } catch (err) {
    console.error("Error en DELETE /users/:id:", err);
    return res
      .status(500)
      .json({ error: "Error al eliminar usuario y sus turnos." });
  }
});

router.get("/:id/history", validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;

    const role = String(req.user?.role || "").toLowerCase();
    const isAdmin = role === "admin";
    const isSelf = req.user._id.toString() === id;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        error: "No tenés permisos para ver el historial de este usuario.",
      });
    }

    const user = await User.findById(id).select("history").lean();
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    let history = Array.isArray(user.history) ? [...user.history] : [];

    if (!history.length) {
      const appointments = await Appointment.find({ user: id })
        .sort({ createdAt: -1 })
        .lean();

      history = appointments.map((ap) => ({
        action: String(ap?.status || "reserved").toLowerCase(),
        date: ap.date,
        time: ap.time,
        service: ap.service,
        serviceName: ap.service,
        status: ap.status,
        createdAt: ap.createdAt,
        title: buildLegacyAppointmentHistoryTitle(ap),
      }));
    }

    history.sort((a, b) => {
      const ad = a?.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bd = b?.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bd - ad;
    });

    return res.json(history);
  } catch (err) {
    console.error("Error en GET /users/:id/history:", err);
    return res.status(500).json({ error: "Error al obtener historial." });
  }
});

router.get(
  "/:id/clinical-notes",
  adminOrProfessor,
  validateObjectIdParam,
  async (req, res) => {
    try {
      const { id } = req.params;
      const user = await User.findById(id).lean();
      if (!user) return res.status(404).json({ error: "Paciente no encontrado." });
      return res.json(user.clinicalNotes || []);
    } catch (err) {
      console.error("Error en GET /users/:id/clinical-notes:", err);
      return res
        .status(500)
        .json({ error: "Error al obtener historia clínica." });
    }
  }
);

router.post(
  "/:id/clinical-notes",
  adminOrProfessor,
  validateObjectIdParam,
  async (req, res) => {
    try {
      const { id } = req.params;
      const { text } = req.body || {};

      if (!text || !String(text).trim()) {
        return res.status(400).json({
          error: "El texto de la nota clínica es obligatorio.",
        });
      }

      const user = await User.findById(id);
      if (!user) return res.status(404).json({ error: "Paciente no encontrado." });

      user.clinicalNotes = user.clinicalNotes || [];
      user.clinicalNotes.push({
        date: new Date(),
        author: req.user.name || req.user.email || "Admin",
        text: String(text).trim(),
      });

      await user.save();
      return res.json({ ok: true, clinicalNotes: user.clinicalNotes });
    } catch (err) {
      console.error("Error en POST /users/:id/clinical-notes:", err);
      return res
        .status(500)
        .json({ error: "Error al guardar historia clínica." });
    }
  }
);

/* ============================================
   CRÉDITOS
============================================ */
async function updateCredits(req, res) {
  try {
    const { id } = req.params;
    const { credits, delta, serviceKey, items, source } = req.body || {};

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    recalcUserCredits(user);
    const beforeCredits = buildCreditsByService(user);
    const beforeTotal = Object.values(beforeCredits || {}).reduce(
      (a, b) => a + Number(b || 0),
      0
    );

    const applyOne = async (rawItem = {}) => {
      const {
        credits: c,
        delta: d,
        amount,
        value,
        sessions,
        qty,
        serviceKey: skRaw,
        source: src,
      } = rawItem || {};

      const sk = canonicalServiceKeyFromValue(skRaw);
      if (!sk || !ALLOWED_SERVICE_KEYS.has(sk)) {
        const err = new Error("serviceKey inválido.");
        err.status = 400;
        throw err;
      }

      const parseOptionalNumber = (input) => {
        if (input === undefined || input === null || input === "") return null;

        const cleaned =
          typeof input === "string"
            ? input.trim().replace(",", ".")
            : input;

        const num = Number(cleaned);
        if (!Number.isFinite(num)) return NaN;

        return num;
      };

      const setValue = c ?? amount ?? value ?? sessions ?? qty;
      const cNum = parseOptionalNumber(setValue);
      const dNum = parseOptionalNumber(d);

      recalcUserCredits(user);
      const currentForService = sumCreditsForService(user, sk);

      if (cNum !== null) {
        if (!Number.isFinite(cNum)) {
          const err = new Error("Valor inválido.");
          err.status = 400;
          throw err;
        }

        const target = Math.max(0, Math.round(cNum));
        const diff = target - currentForService;

        if (diff > 0) {
          await addCreditLot(user, {
            amount: diff,
            serviceKey: sk,
            source: src || "admin-set",
          });
        } else if (diff < 0) {
          consumeCreditsForService(user, Math.abs(diff), sk);
        }

        return;
      }

      if (dNum !== null) {
        if (!Number.isFinite(dNum)) {
          const err = new Error("Valor inválido.");
          err.status = 400;
          throw err;
        }

        const dd = Math.round(dNum);

        if (dd > 0) {
          await addCreditLot(user, {
            amount: dd,
            serviceKey: sk,
            source: src || "admin-delta",
          });
        } else if (dd < 0) {
          consumeCreditsForService(user, Math.abs(dd), sk);
        }

        return;
      }

      console.warn("[CREDITS][INVALID_PAYLOAD]", rawItem);

      const err = new Error("Valor inválido.");
      err.status = 400;
      throw err;
    };

    if (Array.isArray(items) && items.length > 0) {
      for (const it of items) {
        await applyOne({
          ...it,
          source: it?.source || source || "admin-batch",
        });
      }
    } else {
      await applyOne({
        credits,
        delta,
        serviceKey,
        source: source || "admin-single",
      });
    }

    recalcUserCredits(user);
    await user.save();

    const creditsByService = buildCreditsByService(user);

    await logActivity({
      req,
      category: "users",
      action: "credits_updated",
      entity: "user",
      entityId: user._id,
      title: "Créditos modificados",
      description: "Se modificaron los créditos/sesiones del usuario.",
      subject: buildUserSubject(user),
      diff: buildDiff(
        { total: beforeTotal, byService: beforeCredits },
        { total: Number(user.credits || 0), byService: creditsByService }
      ),
      meta: {
        source: source || (Array.isArray(items) ? "admin-batch" : "admin-single"),
      },
    });

    queueCreditsEmails({
      req,
      updatedUser: user.toObject ? user.toObject() : user,
      items:
        Array.isArray(items) && items.length > 0
          ? items
          : [{ credits, delta, serviceKey }],
    });

    const decorated = decorateUserForResponse(user.toObject());

    return res.json({
      ok: true,
      credits: Number(user.credits || 0),
      creditsByService,
      creditLots: user.creditLots || [],
      ...decorated,
    });
  } catch (err) {
    console.error("Error en créditos:", err);
    const status = err?.status || 500;
    return res.status(status).json({ error: err?.message || "Error interno." });
  }
}
router.patch("/:id/credits", adminOnly, validateObjectIdParam, updateCredits);
router.post("/:id/credits", adminOnly, validateObjectIdParam, updateCredits);

router.post(
  "/:id/reset-password",
  adminOnly,
  validateObjectIdParam,
  async (req, res) => {
    try {
      const { id } = req.params;
      const user = await User.findById(id);
      if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

      const tempPassword = Math.random().toString(36).slice(2, 10);
      const hash = await bcrypt.hash(tempPassword, 10);

      user.password = hash;
      user.mustChangePassword = true;
      await user.save();

      await logActivity({
        req,
        category: "users",
        action: "user_password_reset",
        entity: "user",
        entityId: user._id,
        title: "Password reseteada",
        description: "Un admin reseteó la contraseña del usuario.",
        subject: buildUserSubject(user),
      });

      return res.json({ ok: true, tempPassword });
    } catch (err) {
      console.error("Error en reset password:", err);
      return res.status(500).json({ error: "Error interno." });
    }
  }
);

router.patch("/:id/suspend", adminOnly, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;
    const { suspended } = req.body || {};

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    const prevSuspended = !!user.suspended;
    user.suspended = !!suspended;
    user.suspendedReason = user.suspended ? String(req.body?.reason || user.suspendedReason || "manual").trim() : "";
    user.suspendedAt = user.suspended ? user.suspendedAt || new Date() : null;
    await user.save();

    await logActivity({
      req,
      category: "users",
      action: "user_suspend_updated",
      entity: "user",
      entityId: user._id,
      title: "Estado de suspensión actualizado",
      description: user.suspended ? "Usuario suspendido." : "Usuario reactivado.",
      subject: buildUserSubject(user),
      diff: buildDiff(
        { suspended: prevSuspended },
        { suspended: !!user.suspended }
      ),
    });

    return res.json({ ok: true, suspended: user.suspended });
  } catch (err) {
    console.error("Error en PATCH /users/:id/suspend:", err);
    return res
      .status(500)
      .json({ error: "Error al cambiar estado de suspensión." });
  }
});

/* ============================================
   APTO
============================================ */
router.post("/:id/apto", validateObjectIdParam, uploadAptoSingle, async (req, res) => {
  try {
    const { id } = req.params;

    const isAdmin = req.user.role === "admin";
    const isSelf = req.user._id.toString() === id;

    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        error: "No tenés permisos para subir el apto de este usuario.",
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ningún archivo." });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (user.aptoPath) {
      safeUnlink(absFromPublicUploadsPath(user.aptoPath));
    }

    const newPath = "/api/uploads/aptos/" + req.file.filename;

    user.aptoPath = newPath;
    user.aptoStatus = "pending_review";
    setMedicalClearanceStatus(user, "pending_review", { actor: isAdmin ? "admin" : "user" });
    pushUserHistory(user, {
      action: "apto_uploaded",
      title: "Cargó el Apto Físico.",
      message: "El apto físico quedó pendiente de revisión.",
      createdAt: new Date(),
    });
    await user.save();

    fireAndForget(
      () => sendAptoStatusEmail(user, "pending_review"),
      "MAIL_APTO_PENDING_REVIEW"
    );

    return res.json({
      ok: true,
      message: "Apto subido correctamente y pendiente de revisión.",
      aptoPath: newPath,
      aptoStatus: user.aptoStatus,
      medicalClearance: user.medicalClearance,
    });
  } catch (err) {
    console.error("Error en POST /users/:id/apto:", err);
    return res.status(500).json({
      error: "Error al subir el apto.",
      detail: err?.message || String(err),
    });
  }
});

router.get("/:id/apto", validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;

    const role = String(req.user?.role || "").toLowerCase();
    const isStaff = role === "admin" || role === "profesor";
    const isSelf = req.user._id.toString() === id;
    if (!isStaff && !isSelf) return res.status(403).json({ error: "No autorizado." });

    const user = await User.findById(id).lean();
    if (!user || !user.aptoPath) return res.status(404).json({ error: "Apto no encontrado." });

    const abs = absFromPublicUploadsPath(user.aptoPath);
    if (!abs || !fs.existsSync(abs)) {
      return res.status(404).json({ error: "El archivo no existe en el servidor." });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'inline; filename="apto.pdf"');
    return res.sendFile(abs);
  } catch (err) {
    console.error("Error en GET /users/:id/apto:", err);
    return res.status(500).json({ error: "Error al obtener apto." });
  }
});

router.delete("/:id/apto", validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;

    const isAdmin = req.user.role === "admin";
    const isSelf = req.user._id.toString() === id;
    if (!isAdmin && !isSelf) return res.status(403).json({ error: "No autorizado." });

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    if (user.aptoPath) {
      safeUnlink(absFromPublicUploadsPath(user.aptoPath));
    }

    user.aptoPath = "";
    setMedicalClearanceStatus(user, "not_submitted", { actor: isAdmin ? "admin" : "user" });
    pushUserHistory(user, {
      action: "apto_deleted",
      title: "Borró el Apto Físico.",
      createdAt: new Date(),
    });
    await user.save();

    return res.json({
      ok: true,
      message: "Apto eliminado correctamente.",
      aptoStatus: user.aptoStatus,
      medicalClearance: user.medicalClearance,
    });
  } catch (err) {
    console.error("Error en DELETE /users/:id/apto:", err);
    return res.status(500).json({
      error: "Error al borrar apto.",
      detail: err?.message || String(err),
    });
  }
});


router.patch("/:id/apto/status", adminOnly, validateObjectIdParam, async (req, res) => {
  try {
    const { id } = req.params;
    const status = String(req.body?.status || "").toLowerCase().trim();
    const notes = String(req.body?.notes || "").trim();

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: "Usuario no encontrado." });

    const prev = {
      aptoStatus: user.aptoStatus || "",
      suspended: !!user.suspended,
      suspendedReason: user.suspendedReason || "",
      medicalClearance: user.medicalClearance?.toObject?.() || user.medicalClearance || null,
    };

    setMedicalClearanceStatus(user, status, { notes, actor: "admin" });
    await user.save();

    await logActivity({
      req,
      category: "users",
      action: "apto_status_updated",
      entity: "user",
      entityId: user._id,
      title: "Estado de apto físico actualizado",
      description: `El apto físico cambió a ${status}.`,
      subject: buildUserSubject(user),
      diff: buildDiff(prev, {
        aptoStatus: user.aptoStatus || "",
        suspended: !!user.suspended,
        suspendedReason: user.suspendedReason || "",
        medicalClearance: user.medicalClearance?.toObject?.() || user.medicalClearance || null,
      }),
    });

    fireAndForget(
      () => sendAptoStatusEmail(user, status, { notes }),
      "MAIL_APTO_STATUS_UPDATED"
    );

    return res.json({
      ok: true,
      aptoStatus: user.aptoStatus,
      suspended: user.suspended,
      suspendedReason: user.suspendedReason || "",
      medicalClearance: user.medicalClearance,
    });
  } catch (err) {
    console.error("Error en PATCH /users/:id/apto/status:", err);
    return res.status(err?.status || 500).json({
      error: err?.message || "Error al actualizar estado del apto.",
    });
  }
});

/* ============================================
   FOTO (AVATAR)
============================================ */
router.post("/:id/photo", validateObjectIdParam, avatarUploadSingle, async (req, res) => {
  try {
    const { id } = req.params;

    const isAdmin = req.user.role === "admin";
    const isSelf = req.user._id.toString() === id;
    if (!isAdmin && !isSelf) {
      return res.status(403).json({
        error: "Solo el paciente o un admin pueden subir la foto.",
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ninguna imagen." });
    }

    const prevUser = await User.findById(id).lean();
    if (!prevUser) return res.status(404).json({ error: "Usuario no encontrado." });

    if (prevUser.photoPath) {
      safeUnlink(absFromPublicUploadsPath(prevUser.photoPath));
    }

    const newPath = "/api/uploads/" + req.file.filename;

    await User.updateOne({ _id: id }, { $set: { photoPath: newPath } });

    return res.json({ ok: true, photoPath: newPath });
  } catch (err) {
    console.error("Error en POST /users/:id/photo:", err);
    return res.status(500).json({
      error: "Error al subir foto del paciente.",
      detail: err?.message || String(err),
    });
  }
});

/* ============================================
   PLAN MENSUAL
============================================ */
router.get(
  "/:id/monthly-plan",
  adminOrProfessor,
  validateObjectIdParam,
  async (req, res) => {
    try {
      const { id } = req.params;

      const user = await User.findById(id);
      if (!user) {
        return res.status(404).json({ error: "Usuario no encontrado." });
      }

      const plan = ensureMonthlyPlan(user);

      if (!user.monthlyPlan || !user.monthlyPlan.updatedAt) {
        await user.save();
      }

      return res.json({
        ok: true,
        monthlyPlan: plan,
      });
    } catch (err) {
      console.error("Error en GET /users/:id/monthly-plan:", err);
      return res.status(500).json({ error: "Error al obtener el plan mensual." });
    }
  }
);

router.put(
  "/:id/monthly-plan",
  adminOrProfessor,
  validateObjectIdParam,
  async (req, res) => {
    try {
      const { id } = req.params;

      const user = await User.findById(id);
      if (!user) {
        return res.status(404).json({ error: "Usuario no encontrado." });
      }

      const prevPlan = user.monthlyPlan || createDefaultMonthlyPlan();
      const nextPlan = sanitizeMonthlyPlanPayload(req.body || {}, user, req.user);

      user.monthlyPlan = nextPlan;

      pushUserHistory(user, {
        action: "monthly_plan_updated",
        title: "Se actualizó el plan mensual.",
        createdAt: new Date(),
      });

      await user.save();

      await logActivity({
        req,
        category: "users",
        action: "monthly_plan_updated",
        entity: "user",
        entityId: user._id,
        title: "Plan mensual actualizado",
        description: "Un miembro del staff actualizó el plan mensual del usuario.",
        subject: buildUserSubject(user),
        diff: buildDiff(
          { monthlyPlan: prevPlan },
          { monthlyPlan: nextPlan }
        ),
      });

      return res.json({
        ok: true,
        monthlyPlan: user.monthlyPlan,
      });
    } catch (err) {
      console.error("Error en PUT /users/:id/monthly-plan:", err);
      return res.status(500).json({ error: "Error al guardar el plan mensual." });
    }
  }
);

router.post(
  "/:id/monthly-plan/reset",
  adminOrProfessor,
  validateObjectIdParam,
  async (req, res) => {
    try {
      const { id } = req.params;

      const user = await User.findById(id);
      if (!user) {
        return res.status(404).json({ error: "Usuario no encontrado." });
      }

      const fullName =
        `${String(user.name || "").trim()} ${String(user.lastName || "").trim()}`.trim();

      const actorName =
        `${String(req.user?.name || "").trim()} ${String(req.user?.lastName || "").trim()}`.trim() ||
        String(req.user?.email || "").trim() ||
        "Staff";

      user.monthlyPlan = {
        ...createDefaultMonthlyPlan(),
        meta: {
          ...createDefaultMonthlyPlan().meta,
          fullName,
          age: user.age != null ? String(user.age) : "",
          weight: user.weight != null ? String(user.weight) : "",
        },
        updatedAt: new Date(),
        updatedBy: actorName,
      };

      pushUserHistory(user, {
        action: "monthly_plan_reset",
        title: "Se reinició el plan mensual.",
        createdAt: new Date(),
      });

      await user.save();

      await logActivity({
        req,
        category: "users",
        action: "monthly_plan_reset",
        entity: "user",
        entityId: user._id,
        title: "Plan mensual reiniciado",
        description: "Se reinició el plan mensual del usuario.",
        subject: buildUserSubject(user),
      });

      return res.json({
        ok: true,
        monthlyPlan: user.monthlyPlan,
      });
    } catch (err) {
      console.error("Error en POST /users/:id/monthly-plan/reset:", err);
      return res.status(500).json({ error: "Error al reiniciar el plan mensual." });
    }
  }
);

export default router;