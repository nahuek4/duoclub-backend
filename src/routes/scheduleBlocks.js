import express from "express";
import mongoose from "mongoose";
import ScheduleBlock, { SERVICE_KEYS } from "../models/ScheduleBlock.js";
import { protect } from "../middleware/auth.js";

const router = express.Router();

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
  NUT: "Nutrición",
};

const AR_TIME_ZONE = "America/Argentina/Buenos_Aires";

function ensureStaff(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase().trim();
  if (!["admin", "profesor", "staff"].includes(role)) {
    return res.status(403).json({ error: "No autorizado." });
  }
  return next();
}

function cleanString(value) {
  return String(value || "").trim();
}

function cleanYmd(value) {
  const s = cleanString(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function cleanTime(value) {
  const s = cleanString(value).slice(0, 5);
  return /^\d{2}:\d{2}$/.test(s) ? s : "";
}

function normalizeServiceKey(value) {
  const up = cleanString(value).toUpperCase();
  if (up === "ALL" || up === "TODOS") return "ALL";
  if (up === "AR") return "RA";
  if (up === "KINEDEPO" || up === "KINE-DEPO") return "KD";
  return SERVICE_KEYS.includes(up) ? up : "";
}

function normalizeServiceKeys(payload = {}) {
  const raw = [];

  if (payload.allServices === true) raw.push("ALL");
  if (payload.serviceKey) raw.push(payload.serviceKey);
  if (Array.isArray(payload.serviceKeys)) raw.push(...payload.serviceKeys);

  const normalized = raw.map(normalizeServiceKey).filter(Boolean);
  if (normalized.includes("ALL")) return SERVICE_KEYS;

  return Array.from(new Set(normalized.filter((x) => x !== "ALL")));
}

function normalizeWeekdays(value) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
    )
  ).sort((a, b) => a - b);
}

function getArgentinaNowParts(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: AR_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      hourCycle: "h23",
    }).formatToParts(date);

    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    const year = get("year");
    const month = get("month");
    const day = get("day");
    const hour = get("hour").padStart(2, "0").slice(-2);
    const minute = get("minute").padStart(2, "0").slice(-2);

    if (year && month && day && hour && minute) {
      return {
        today: `${year}-${month}-${day}`,
        time: `${hour}:${minute}`,
      };
    }
  } catch {
    // fallback abajo
  }

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");

  return {
    today: `${y}-${m}-${d}`,
    time: `${hh}:${mm}`,
  };
}

function ymdToDate(value) {
  const [y, m, d] = cleanYmd(value).split("-").map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1);
}

function dateToYmd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function weekdayMondayFirst(day) {
  const [y, m, d] = cleanYmd(day).split("-").map(Number);
  const js = new Date(y || 1970, (m || 1) - 1, d || 1).getDay();
  return js === 0 ? 7 : js;
}

function blockWeekdayMatches(block, day) {
  const weekdays = Array.isArray(block?.weekdays) ? block.weekdays.map(Number) : [];
  if (!weekdays.length) return true;
  return weekdays.includes(weekdayMondayFirst(day));
}

function hasRemainingOccurrence(block, nowParts = getArgentinaNowParts()) {
  const dateFrom = cleanYmd(block?.dateFrom);
  const dateTo = cleanYmd(block?.dateTo || block?.dateFrom);
  if (!dateFrom || !dateTo) return true;

  if (dateTo < nowParts.today) return false;

  const cursor = ymdToDate(dateFrom > nowParts.today ? dateFrom : nowParts.today);
  const end = ymdToDate(dateTo);
  let guard = 0;

  while (cursor <= end && guard < 900) {
    const day = dateToYmd(cursor);

    if (blockWeekdayMatches(block, day)) {
      if (day > nowParts.today) return true;
      if (block?.allDay !== false) return true;

      const timeTo = cleanTime(block?.timeTo);
      if (!timeTo || timeTo > nowParts.time) return true;
    }

    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }

  return false;
}

function isScheduleBlockExpired(block, nowParts = getArgentinaNowParts()) {
  if (!block || block.active === false) return false;
  if (block.indefinite) return false;

  const dateFrom = cleanYmd(block.dateFrom);
  const dateTo = cleanYmd(block.dateTo || block.dateFrom);
  if (!dateFrom || !dateTo) return false;

  return !hasRemainingOccurrence(block, nowParts);
}

async function deactivateExpiredBlocks() {
  const nowParts = getArgentinaNowParts();
  const candidates = await ScheduleBlock.find({
    active: true,
    indefinite: { $ne: true },
  })
    .select("_id active dateFrom dateTo indefinite allDay timeFrom timeTo weekdays")
    .lean();

  const expiredIds = candidates
    .filter((block) => isScheduleBlockExpired(block, nowParts))
    .map((block) => block._id)
    .filter(Boolean);

  if (expiredIds.length) {
    await ScheduleBlock.updateMany(
      { _id: { $in: expiredIds } },
      { $set: { active: false } }
    );
  }

  return expiredIds.length;
}

function buildPayload(req) {
  const body = req.body || {};
  const serviceKeys = normalizeServiceKeys(body);
  const allDay = body.allDay !== false;
  const indefinite = Boolean(body.indefinite);
  const dateFrom = cleanYmd(body.dateFrom || body.date || "");
  const dateTo = indefinite ? "" : cleanYmd(body.dateTo || body.date || dateFrom);

  const payload = {
    title: cleanString(body.title) || cleanString(body.reason) || "Bloqueo de agenda",
    reason: cleanString(body.reason),
    serviceKeys,
    allServices: serviceKeys.length === SERVICE_KEYS.length,
    dateFrom,
    dateTo: indefinite ? "" : (dateTo || dateFrom),
    indefinite,
    allDay,
    timeFrom: allDay ? "" : cleanTime(body.timeFrom),
    timeTo: allDay ? "" : cleanTime(body.timeTo),
    weekdays: normalizeWeekdays(body.weekdays),
    active: body.active !== false,
  };

  if (payload.active && isScheduleBlockExpired(payload)) {
    payload.active = false;
  }

  return payload;
}

function serviceNamesFor(keys = [], allServices = false) {
  const list = Array.isArray(keys) ? keys : [];
  if (allServices || list.length === SERVICE_KEYS.length) return "Todos los servicios";
  return list.map((k) => SERVICE_KEY_TO_NAME[k] || k).join(", ");
}

function serializeBlock(block) {
  const raw = typeof block?.toObject === "function" ? block.toObject() : block;
  return {
    ...raw,
    id: String(raw?._id || raw?.id || ""),
    expired: isScheduleBlockExpired(raw),
    serviceNames: serviceNamesFor(raw?.serviceKeys || [], raw?.allServices === true),
  };
}

router.use(protect);
router.use(ensureStaff);

router.get("/", async (req, res) => {
  try {
    const includeInactive = String(req.query?.active || "1") === "0";
    const autoDeactivatedCount = await deactivateExpiredBlocks();
    const q = includeInactive ? {} : { active: true };

    const items = await ScheduleBlock.find(q)
      .sort({ active: -1, createdAt: -1 })
      .limit(300)
      .lean();

    return res.json({
      ok: true,
      autoDeactivatedCount,
      items: items.map(serializeBlock),
    });
  } catch (err) {
    console.error("GET /schedule-blocks error:", err);
    return res.status(500).json({ error: "No se pudieron cargar los bloqueos." });
  }
});

router.post("/", async (req, res) => {
  try {
    const payload = buildPayload(req);

    if (!payload.serviceKeys.length) {
      return res.status(400).json({ error: "Seleccioná al menos un servicio." });
    }
    if (!payload.dateFrom) {
      return res.status(400).json({ error: "Indicá fecha desde." });
    }

    const created = await ScheduleBlock.create({
      ...payload,
      createdBy: req.user?._id || null,
      updatedBy: req.user?._id || null,
    });

    return res.status(201).json({ ok: true, item: serializeBlock(created) });
  } catch (err) {
    console.error("POST /schedule-blocks error:", err);
    return res.status(500).json({ error: err?.message || "No se pudo crear el bloqueo." });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id || ""))) {
      return res.status(400).json({ error: "ID inválido." });
    }

    const current = await ScheduleBlock.findById(id);
    if (!current) return res.status(404).json({ error: "Bloqueo no encontrado." });

    const body = req.body || {};
    const next = {};

    if (Object.prototype.hasOwnProperty.call(body, "active")) {
      next.active = Boolean(body.active);
    }

    const hasEditableFields = [
      "title",
      "reason",
      "serviceKey",
      "serviceKeys",
      "allServices",
      "date",
      "dateFrom",
      "dateTo",
      "indefinite",
      "allDay",
      "timeFrom",
      "timeTo",
      "weekdays",
    ].some((key) => Object.prototype.hasOwnProperty.call(body, key));

    if (hasEditableFields) {
      Object.assign(next, buildPayload(req));
    }

    if (next.active !== false && isScheduleBlockExpired({ ...current.toObject(), ...next })) {
      next.active = false;
    }

    next.updatedBy = req.user?._id || null;

    const updated = await ScheduleBlock.findByIdAndUpdate(
      id,
      { $set: next },
      {
        new: true,
        runValidators: true,
      }
    );

    return res.json({ ok: true, item: serializeBlock(updated) });
  } catch (err) {
    console.error("PATCH /schedule-blocks/:id error:", err);
    return res.status(500).json({ error: err?.message || "No se pudo actualizar el bloqueo." });
  }
});

router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(String(id || ""))) {
      return res.status(400).json({ error: "ID inválido." });
    }

    const updated = await ScheduleBlock.findByIdAndUpdate(
      id,
      { $set: { active: false, updatedBy: req.user?._id || null } },
      { new: true }
    );

    if (!updated) return res.status(404).json({ error: "Bloqueo no encontrado." });

    return res.json({ ok: true, item: serializeBlock(updated) });
  } catch (err) {
    console.error("DELETE /schedule-blocks/:id error:", err);
    return res.status(500).json({ error: "No se pudo desactivar el bloqueo." });
  }
});

export default router;
