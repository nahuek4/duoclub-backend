// backend/src/routes/services.js
import express from "express";

import ServiceDefinition, {
  CORE_SERVICE_DEFINITIONS,
} from "../models/ServiceDefinition.js";
import { protect, adminOnly } from "../middleware/auth.js";

const router = express.Router();

function serializeService(service = {}) {
  return {
    id: String(service?._id || service?.serviceKey || ""),
    serviceKey: String(service?.serviceKey || "").toUpperCase().trim(),
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
  };
}

function fallbackOperationalServices() {
  return CORE_SERVICE_DEFINITIONS
    .filter(
      (service) =>
        service.active !== false &&
        service.catalogVisible !== false &&
        service.reservable !== false
    )
    .sort((a, b) => Number(a.sortOrder || 100) - Number(b.sortOrder || 100))
    .map(serializeService);
}

// GET /services
//
// IMPORTANTE PASO 1:
// - Si el catálogo ya fue inicializado, lee Mongo.
// - Si todavía no existe ningún registro, devuelve EXACTAMENTE el fallback
//   de los cuatro servicios operativos actuales.
// Así el primer deploy no depende de haber corrido el bootstrap.
router.get("/", async (req, res) => {
  try {
    const count = await ServiceDefinition.estimatedDocumentCount();

    if (!count) {
      return res.json(fallbackOperationalServices());
    }

    const services = await ServiceDefinition.find({
      active: true,
      catalogVisible: true,
      reservable: true,
    })
      .sort({ sortOrder: 1, name: 1, serviceKey: 1 })
      .lean();

    return res.json(services.map(serializeService));
  } catch (error) {
    console.error("[SERVICES] GET / fallback por error:", error);

    // Seguridad operativa: un problema aislado en el catálogo nuevo no deja
    // a producción sin la lista de servicios durante el Paso 1.
    return res.json(fallbackOperationalServices());
  }
});

// GET /services/admin/catalog
//
// Solo lectura en Paso 1. Sirve para verificar que el seed quedó bien antes
// de conectar creación/edición desde AdminPrecios.
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
    });
  } catch (error) {
    console.error("[SERVICES] GET /admin/catalog:", error);
    return res.status(500).json({
      error: "No se pudo cargar el catálogo de servicios.",
    });
  }
});

export default router;
