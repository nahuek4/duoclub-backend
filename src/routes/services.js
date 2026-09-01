// backend/src/routes/services.js
import express from "express";

import ServiceDefinition, {
  CORE_SERVICE_DEFINITIONS,
} from "../models/ServiceDefinition.js";
import { protect, adminOnly } from "../middleware/auth.js";
import { logActivity } from "../lib/activityLogger.js";

const router = express.Router();

// Hasta completar el PASO 3, un servicio nuevo puede existir, tener horarios y
// planes, pero no se publica en el runtime de usuarios.
const RUNTIME_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeServiceKey(value) {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
}

function parseBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "si", "sí"].includes(clean(value).toLowerCase());
}

function parseNumber(value, fallback, { min = null, max = null } = {}) {
  const n = Number(value);
  let out = Number.isFinite(n) ? n : fallback;
  if (min !== null) out = Math.max(min, out);
  if (max !== null) out = Math.min(max, out);
  return out;
}

function cleanTime(value) {
  const out = clean(value).slice(0, 5);
  return /^\d{2}:\d{2}$/.test(out) ? out : "";
}

function normalizeWeeklyHours(value = []) {
  const result = [];
  const seen = new Set();

  for (const rawDay of Array.isArray(value) ? value : []) {
    const weekday = Number(rawDay?.weekday || 0);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) continue;
    if (seen.has(weekday)) continue;
    seen.add(weekday);

    const ranges = (Array.isArray(rawDay?.ranges) ? rawDay.ranges : [])
      .map((range) => ({
        from: cleanTime(range?.from),
        to: cleanTime(range?.to),
      }))
      .filter((range) => range.from && range.to);

    result.push({
      weekday,
      enabled: rawDay?.enabled !== false,
      ranges,
    });
  }

  return result.sort((a, b) => a.weekday - b.weekday);
}

function serializeService(service = {}) {
  const serviceKey = String(service?.serviceKey || "").toUpperCase().trim();

  return {
    id: String(service?._id || serviceKey || ""),
    serviceKey,
    name: String(service?.name || "").trim(),
    label: String(service?.name || "").trim(),
    description: String(service?.description || "").trim(),
    duration: Number(service?.duration || 60),
    slotMinutes: Number(service?.slotMinutes || 60),
    active: service?.active !== false,
    catalogVisible: service?.catalogVisible !== false,
    purchasable: service?.purchasable !== false,
    reservable: service?.reservable !== false,
    recurringPlanEnabled: service?.recurringPlanEnabled !== false,
    fixedScheduleEnabled: service?.fixedScheduleEnabled !== false,
    waitlistEnabled: service?.waitlistEnabled === true,
    capacityGroup: String(service?.capacityGroup || "NONE").toUpperCase(),
    category: String(service?.category || "other").toLowerCase(),
    minBookingMinutes: Math.max(0, Number(service?.minBookingMinutes || 0)),
    maxAdvanceDays: Math.max(0, Number(service?.maxAdvanceDays || 0)),
    cancellationCutoffHours: Math.max(
      0,
      Number(service?.cancellationCutoffHours || 0)
    ),
    sortOrder: Number(service?.sortOrder || 100),
    weeklyHours: Array.isArray(service?.weeklyHours)
      ? service.weeklyHours.map((day) => ({
          weekday: Number(day?.weekday || 0),
          enabled: day?.enabled !== false,
          ranges: (Array.isArray(day?.ranges) ? day.ranges : []).map((range) => ({
            from: String(range?.from || "").slice(0, 5),
            to: String(range?.to || "").slice(0, 5),
          })),
        }))
      : [],
    legacy: service?.legacy === true,
    runtimeIntegrated: RUNTIME_SERVICE_KEYS.has(serviceKey),
  };
}

function fallbackOperationalServices() {
  return CORE_SERVICE_DEFINITIONS
    .filter((service) => RUNTIME_SERVICE_KEYS.has(service.serviceKey))
    .filter(
      (service) =>
        service.active !== false &&
        service.catalogVisible !== false &&
        service.reservable !== false
    )
    .sort((a, b) => Number(a.sortOrder || 100) - Number(b.sortOrder || 100))
    .map(serializeService);
}

function actorId(req) {
  return req.user?._id || req.user?.id || null;
}

function buildEditablePayload(body = {}, { creating = false } = {}) {
  const payload = {
    name: clean(body?.name),
    description: clean(body?.description),
    category: clean(body?.category || "other").toLowerCase() || "other",
    active: parseBool(body?.active, true),
    catalogVisible: parseBool(body?.catalogVisible, true),
    purchasable: parseBool(body?.purchasable, true),
    reservable: parseBool(body?.reservable, creating ? false : true),
    recurringPlanEnabled: parseBool(body?.recurringPlanEnabled, true),
    fixedScheduleEnabled: parseBool(body?.fixedScheduleEnabled, true),
    waitlistEnabled: parseBool(body?.waitlistEnabled, false),
    capacityGroup: clean(body?.capacityGroup || "NONE").toUpperCase() || "NONE",
    duration: Math.trunc(parseNumber(body?.duration, 60, { min: 5, max: 360 })),
    slotMinutes: Math.trunc(parseNumber(body?.slotMinutes, 60, { min: 5, max: 240 })),
    minBookingMinutes: Math.trunc(
      parseNumber(body?.minBookingMinutes, 60, { min: 0, max: 60 * 24 * 30 })
    ),
    maxAdvanceDays: Math.trunc(
      parseNumber(body?.maxAdvanceDays, 30, { min: 0, max: 365 })
    ),
    cancellationCutoffHours: parseNumber(body?.cancellationCutoffHours, 1, {
      min: 0,
      max: 24 * 30,
    }),
    sortOrder: Number.isFinite(Number(body?.sortOrder)) ? Number(body.sortOrder) : 100,
    weeklyHours: normalizeWeeklyHours(body?.weeklyHours),
  };

  return payload;
}

// GET /services
//
// PASO 2: esta ruta pública mantiene EXACTAMENTE el runtime actual.
// El catálogo se administra en paralelo y recién gobierna Comprar/Reservar
// cuando completemos la migración operativa del Paso 3.
router.get("/", async (req, res) => {
  return res.json(fallbackOperationalServices());
});

router.get("/admin/catalog", protect, adminOnly, async (req, res) => {
  try {
    const services = await ServiceDefinition.find({})
      .sort({ sortOrder: 1, name: 1, serviceKey: 1 })
      .lean();

    return res.json({
      ok: true,
      initialized: services.length > 0,
      count: services.length,
      items: services.length
        ? services.map(serializeService)
        : CORE_SERVICE_DEFINITIONS.map(serializeService),
      source: services.length ? "database" : "fallback",
      runtimeKeys: [...RUNTIME_SERVICE_KEYS],
    });
  } catch (error) {
    console.error("[SERVICES] GET /admin/catalog:", error);
    return res.status(500).json({
      error: "No se pudo cargar el catálogo de servicios.",
    });
  }
});

// POST /services/admin/catalog
// Crea un servicio de catálogo. NO lo expone todavía en el runtime de usuarios.
router.post("/admin/catalog", protect, adminOnly, async (req, res) => {
  try {
    const serviceKey = normalizeServiceKey(req.body?.serviceKey);
    const payload = buildEditablePayload(req.body, { creating: true });

    if (!serviceKey || !/^[A-Z][A-Z0-9_]{1,23}$/.test(serviceKey)) {
      return res.status(400).json({
        error:
          "La clave del servicio debe tener entre 2 y 24 caracteres, comenzar con una letra y usar solo A-Z, 0-9 o _.",
      });
    }

    if (!payload.name) {
      return res.status(400).json({ error: "Ingresá el nombre del servicio." });
    }

    const exists = await ServiceDefinition.findOne({ serviceKey }).lean();
    if (exists) {
      return res.status(409).json({
        error: `Ya existe un servicio con la clave ${serviceKey}.`,
      });
    }

    const doc = await ServiceDefinition.create({
      serviceKey,
      ...payload,
      legacy: false,
      createdBy: actorId(req),
      updatedBy: actorId(req),
    });

    await logActivity({
      req,
      category: "services",
      action: "service_created",
      entity: "service_definition",
      entityId: doc._id,
      title: "Servicio creado",
      description: `Se creó ${doc.name} (${doc.serviceKey}) en el catálogo de servicios.`,
      meta: {
        serviceKey: doc.serviceKey,
        name: doc.name,
        capacityGroup: doc.capacityGroup,
        runtimeIntegrated: RUNTIME_SERVICE_KEYS.has(doc.serviceKey),
      },
      diff: { before: null, after: doc.toObject() },
    });

    return res.status(201).json({ ok: true, item: serializeService(doc) });
  } catch (error) {
    console.error("[SERVICES] POST /admin/catalog:", error);
    return res.status(500).json({
      error: error?.message || "No se pudo crear el servicio.",
    });
  }
});

// PUT /services/admin/catalog/:serviceKey
router.put("/admin/catalog/:serviceKey", protect, adminOnly, async (req, res) => {
  try {
    const serviceKey = normalizeServiceKey(req.params?.serviceKey);
    const existing = await ServiceDefinition.findOne({ serviceKey });

    if (!existing) {
      return res.status(404).json({ error: "Servicio no encontrado." });
    }

    if (existing.legacy === true) {
      return res.status(409).json({
        error:
          "Los servicios históricos quedan protegidos en esta etapa. No se pueden editar todavía.",
      });
    }

    const before = existing.toObject();
    const payload = buildEditablePayload(req.body, { creating: false });

    if (!payload.name) {
      return res.status(400).json({ error: "Ingresá el nombre del servicio." });
    }

    Object.assign(existing, payload, { updatedBy: actorId(req) });
    await existing.save();

    await logActivity({
      req,
      category: "services",
      action: "service_updated",
      entity: "service_definition",
      entityId: existing._id,
      title: "Servicio actualizado",
      description: `Se actualizó ${existing.name} (${existing.serviceKey}).`,
      meta: {
        serviceKey: existing.serviceKey,
        name: existing.name,
        capacityGroup: existing.capacityGroup,
        runtimeIntegrated: RUNTIME_SERVICE_KEYS.has(existing.serviceKey),
      },
      diff: { before, after: existing.toObject() },
    });

    return res.json({ ok: true, item: serializeService(existing) });
  } catch (error) {
    console.error("[SERVICES] PUT /admin/catalog/:serviceKey:", error);
    return res.status(500).json({
      error: error?.message || "No se pudo actualizar el servicio.",
    });
  }
});

export default router;
