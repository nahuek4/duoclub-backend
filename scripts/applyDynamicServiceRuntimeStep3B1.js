// backend/scripts/applyDynamicServiceRuntimeStep3B1.js
//
// Uso:
//   node scripts/applyDynamicServiceRuntimeStep3B1.js --dry-run
//   node scripts/applyDynamicServiceRuntimeStep3B1.js --apply
//
// Requiere que ya estén subidos:
//   src/services/serviceCatalogRuntime.js
//   src/routes/waitlist.js
//   src/jobs/startWaitlist.js
//
// El dry-run no escribe.
// El apply hace backup y modifica:
//   src/routes/appointments.js
//   src/routes/users.js
//   src/routes/scheduleBlocks.js
//   src/routes/subscriptions.js
//   src/models/CapacityRule.js
//
// waitlist.js y startWaitlist.js son archivos completos que se suben
// junto con este paquete.

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();
const APPLY = process.argv.includes("--apply");

function fail(message) {
  throw new Error(message);
}

function abs(rel) {
  return path.join(ROOT, rel);
}

function read(rel) {
  const p = abs(rel);
  if (!fs.existsSync(p)) fail(`No existe ${rel}`);
  return fs.readFileSync(p, "utf8");
}

function sha(text) {
  return crypto
    .createHash("sha256")
    .update(text)
    .digest("hex")
    .slice(0, 16);
}

function rep(label, from, to, count = 1) {
  return { label, from, to, count };
}

const patches = [
  {
    file: "src/routes/appointments.js",
    replacements: [
      rep(
        "import runtime catálogo",
        `import { creditExpiryForDate } from "../utils/creditExpiry.js";`,
        `import { creditExpiryForDate } from "../utils/creditExpiry.js";
import {
  activeServiceKeysCached,
  allowedTimesForService as catalogAllowedTimesForService,
  capacityGroupForService as catalogCapacityGroupForService,
  capacityZonesForAdmin,
  ensureServiceCatalogLoaded,
  isServiceEnabledFor,
  isWeekdayTimeAllowedForService,
  normalizeCatalogServiceKey,
  serviceCancellationCutoffHours,
  serviceKeysForCapacityGroup,
  serviceMaxAdvanceDays,
  serviceMinBookingMinutes,
  serviceNameForKey,
} from "../services/serviceCatalogRuntime.js";`
      ),
      rep(
        "middleware cache catálogo",
        `const router = express.Router();`,
        `const router = express.Router();

router.use(async (req, res, next) => {
  await ensureServiceCatalogLoaded();
  next();
});`
      ),
      rep(
        "waitlist dinámica",
        `function waitlistQueueServiceKeys(serviceKeyOrName) {
  const sk = serviceToKey(serviceKeyOrName);
  if (!sk) return [];
  if (isTherapyService(sk)) return ["RA", "RF", "SYN"];
  return [sk];
}

function buildWaitlistQueueMatch(serviceKeyOrName) {
  const keys = waitlistQueueServiceKeys(serviceKeyOrName);
  if (!keys.length) return { serviceKey: "__NO_SERVICE__" };
  return { serviceKey: { $in: keys } };
}

function isWaitlistableService(serviceKeyOrName) {
  const sk = serviceToKey(serviceKeyOrName);
  return sk === "EP" || isTherapyService(sk);
}`,
        `function waitlistQueueServiceKeys(serviceKeyOrName) {
  const sk = serviceToKey(serviceKeyOrName);
  if (!sk) return [];

  if (capacityZoneForService(sk) === "PERFORMANCE") {
    const groupKeys = serviceKeysForCapacityGroup("PERFORMANCE", {
      flag: "waitlistEnabled",
    });
    return groupKeys.length ? groupKeys : [sk];
  }

  return [sk];
}

function buildWaitlistQueueMatch(serviceKeyOrName) {
  const keys = waitlistQueueServiceKeys(serviceKeyOrName);
  if (!keys.length) return { serviceKey: "__NO_SERVICE__" };
  return { serviceKey: { $in: keys } };
}

function isWaitlistableService(serviceKeyOrName) {
  return isServiceEnabledFor(serviceToKey(serviceKeyOrName), "waitlistEnabled");
}`
      ),
      rep(
        "ventana de reserva dinámica",
        `function validateBookingWindow(slotDate) {
  const now = new Date();
  const max = addDays(now, MAX_ADVANCE_DAYS);

  if (slotDate.getTime() < now.getTime()) {
    return { ok: false, error: "No se puede reservar un turno pasado." };
  }
  if (slotDate.getTime() > max.getTime()) {
    return {
      ok: false,
      error: \`Solo se puede reservar hasta \${MAX_ADVANCE_DAYS} días de anticipación.\`,
    };
  }
  return { ok: true };
}

function getMinBookingMinutesForService(serviceName) {
  const sk = serviceToKey(serviceName);
  return (
    MIN_BOOKING_MINUTES_BY_SERVICE[sk] ??
    MIN_BOOKING_MINUTES_BY_SERVICE.OTHER
  );
}`,
        `function validateBookingWindow(slotDate, serviceName = "") {
  const now = new Date();
  const maxDays = serviceMaxAdvanceDays(
    serviceToKey(serviceName),
    MAX_ADVANCE_DAYS
  );
  const max = addDays(now, maxDays);

  if (slotDate.getTime() < now.getTime()) {
    return { ok: false, error: "No se puede reservar un turno pasado." };
  }
  if (slotDate.getTime() > max.getTime()) {
    return {
      ok: false,
      error: \`Solo se puede reservar hasta \${maxDays} días de anticipación.\`,
    };
  }
  return { ok: true };
}

function getMinBookingMinutesForService(serviceName) {
  const sk = serviceToKey(serviceName);
  return serviceMinBookingMinutes(
    sk,
    MIN_BOOKING_MINUTES_BY_SERVICE[sk] ??
      MIN_BOOKING_MINUTES_BY_SERVICE.OTHER
  );
}`
      ),
      rep(
        "waitlist cierre por grupo",
        `function getWaitlistCloseMinutesForService(serviceName) {
  const sk = serviceToKey(serviceName);

  if (sk === "EP") return 30;
  if (["RA", "RF", "SYN"].includes(sk)) return 12 * 60;

  return null;
}`,
        `function getWaitlistCloseMinutesForService(serviceName) {
  const sk = serviceToKey(serviceName);
  const zone = capacityZoneForService(sk);

  if (zone === "TRAINING") return 30;
  if (zone === "PERFORMANCE") return 12 * 60;

  return null;
}`
      ),
      rep(
        "operational catálogo",
        `const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RA", "RF", "KD", "SYN", "NUT"]);

// Servicios habilitados para NUEVA operatoria.
// PE / KD / NUT se siguen reconociendo únicamente por compatibilidad histórica.
const OPERATIONAL_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);

function isOperationalServiceKey(value) {
  const sk = normalizeServiceKey(value) || serviceToKey(value);
  return OPERATIONAL_SERVICE_KEYS.has(sk);
}`,
        `function isOperationalServiceKey(value) {
  const sk = normalizeServiceKey(value) || serviceToKey(value);
  return isServiceEnabledFor(sk, "reservable");
}`
      ),
      rep(
        "normalize service key catálogo",
        `function normalizeServiceKey(value) {
  const up = String(value || "").toUpperCase().trim();
  return ALLOWED_SERVICE_KEYS.has(up) ? up : "";
}`,
        `function normalizeServiceKey(value) {
  return normalizeCatalogServiceKey(value);
}`
      ),
      rep(
        "serviceToKey catálogo",
        `function serviceToKey(serviceNameOrKey) {
  const explicit = normalizeServiceKey(serviceNameOrKey);
  if (explicit) return explicit;

  const s = stripAccents(serviceNameOrKey).toLowerCase().trim();

  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("kinefilaxia") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("synergy") || s.includes("sinergia")) return "SYN";
  if (s.includes("nutricion")) return "NUT";

  return "";
}`,
        `function serviceToKey(serviceNameOrKey) {
  return normalizeCatalogServiceKey(serviceNameOrKey);
}`
      ),
      rep(
        "nombre servicio catálogo",
        `function serviceKeyToName(serviceKey) {
  return SERVICE_KEY_TO_NAME[normalizeServiceKey(serviceKey)] || "";
}`,
        `function serviceKeyToName(serviceKey) {
  return serviceNameForKey(serviceKey);
}`
      ),
      rep(
        "capacidad independiente",
        `const DEFAULT_ZONE_CAPS = Object.freeze({
  TRAINING: 11,
  PERFORMANCE: 6,
});`,
        `const DEFAULT_ZONE_CAPS = Object.freeze({
  TRAINING: 11,
  PERFORMANCE: 6,
  NONE: 1,
});`
      ),
      rep(
        "grupo terapia dinámico",
        `function isTherapyService(serviceNameOrKey) {
  const sk = serviceToKey(serviceNameOrKey);
  return ["RA", "RF", "SYN"].includes(sk);
}

function capacityZoneForService(serviceNameOrKey) {
  const sk = serviceToKey(serviceNameOrKey);
  if (sk === "EP") return "TRAINING";
  if (["RA", "RF", "SYN"].includes(sk)) return "PERFORMANCE";
  return "";
}`,
        `function isTherapyService(serviceNameOrKey) {
  return capacityZoneForService(serviceNameOrKey) === "PERFORMANCE";
}

function capacityZoneForService(serviceNameOrKey) {
  return catalogCapacityGroupForService(serviceToKey(serviceNameOrKey));
}`
      ),
      rep(
        "horarios catálogo",
        `function getAllowedTimesForService(serviceNameOrKey, dateStr = "") {
  if (!dateStr || isSunday(dateStr)) return [];

  const sk = serviceToKey(serviceNameOrKey);

  if (isSaturday(dateStr)) return [];

  if (sk === "EP") return TIMES_EP_WEEKDAY;
  if (["RA", "RF", "SYN"].includes(sk)) return getPerformanceTimesForDate(dateStr);

  return [];
}`,
        `function getAllowedTimesForService(serviceNameOrKey, dateStr = "") {
  return catalogAllowedTimesForService(
    serviceToKey(serviceNameOrKey),
    dateStr
  );
}`
      ),
      rep(
        "área performance dinámica",
        `function isTherapyAreaActiveAt(dateStr, time) {
  const t = String(time || "").slice(0, 5);
  return getTherapySharedTimesForDate(dateStr).includes(t);
}`,
        `function isTherapyAreaActiveAt(dateStr, time) {
  const t = String(time || "").slice(0, 5);
  return serviceKeysForCapacityGroup("PERFORMANCE", {
    flag: "reservable",
  }).some((key) =>
    catalogAllowedTimesForService(key, dateStr).includes(t)
  );
}`
      ),
      rep(
        "reserved fallback dinámico",
        `  if (sk === "NUT") return counts.nutReserved;
  return 0;
}`,
        `  if (sk === "NUT") return counts.nutReserved;
  return Number(counts?.byService?.[sk] || 0);
}`
      ),
      rep(
        "mapas genéricos capacidad",
        `function getSlotReservationStats(existing, dateStr, time, requestedServiceKey = "", capacityRules = []) {
  const list = Array.isArray(existing) ? existing : [];

  const peReserved`,
        `function getSlotReservationStats(existing, dateStr, time, requestedServiceKey = "", capacityRules = []) {
  const list = Array.isArray(existing) ? existing : [];
  const byService = {};
  const byZone = {};

  for (const appointment of list) {
    const key = appointmentServiceKey(appointment);
    if (!key) continue;

    byService[key] = Number(byService[key] || 0) + 1;

    const zone = capacityZoneForService(key);
    if (zone && zone !== "NONE") {
      byZone[zone] = Number(byZone[zone] || 0) + 1;
    }
  }

  const peReserved`
      ),
      rep(
        "counts genéricos",
        `    synReserved,
    therapyReserved,
  };`,
        `    synReserved,
    therapyReserved,
    byService,
    byZone,
  };`
      ),
      rep(
        "zoneReserved genérico",
        `  const zoneReserved =
    capacity.zone === "TRAINING"
      ? epReserved
      : capacity.zone === "PERFORMANCE"
        ? therapyReserved
        : 0;

  const serviceReserved = reservedForServiceKey(counts, requestedSk);`,
        `  const serviceReserved = reservedForServiceKey(counts, requestedSk);
  const zoneReserved =
    capacity.zone === "NONE"
      ? serviceReserved
      : Number(byZone[capacity.zone] || 0);`
      ),
      rep(
        "capacidad response genérica",
        `function isSlotCapacityReached(stats, serviceKey) {
  const sk = serviceToKey(serviceKey);
  if (sk === "PE") return Number(stats?.peReserved || 0) >= Number(stats?.peCap || 0);
  if (sk === "NUT") return Number(stats?.nutReserved || 0) >= Number(stats?.nutCap || 0);
  if (sk === "EP" || isTherapyService(sk)) {
    return Number(stats?.effectiveAvailable || 0) <= 0;
  }
  return true;
}

function capacityResponseFields(stats, serviceKey) {
  const sk = serviceToKey(serviceKey);

  if (sk === "PE") {
    const available = Math.max(0, Number(stats?.peCap || 0) - Number(stats?.peReserved || 0));
    return {
      capacity: Number(stats?.peCap || 0),
      reserved: Number(stats?.peReserved || 0),
      available,
      availableVacancies: available,
      slotGroup: "PE",
    };
  }

  if (sk === "NUT") {
    const available = Math.max(0, Number(stats?.nutCap || 0) - Number(stats?.nutReserved || 0));
    return {
      capacity: Number(stats?.nutCap || 0),
      reserved: Number(stats?.nutReserved || 0),
      available,
      availableVacancies: available,
      slotGroup: "NUT",
    };
  }

  if (sk === "EP" || isTherapyService(sk)) {
    const usingServiceLimit = stats?.serviceCap != null;
    return {
      capacity: Number(stats?.effectiveCap || 0),
      reserved: Number(usingServiceLimit ? stats?.serviceReserved || 0 : stats?.zoneReserved || 0),
      available: Math.max(0, Number(stats?.effectiveAvailable || 0)),
      availableVacancies: Math.max(0, Number(stats?.effectiveAvailable || 0)),
      slotGroup: sk === "EP" ? "EP" : "THERAPY_SHARED",
    };
  }

  return {
    capacity: 0,
    reserved: 0,
    available: 0,
    availableVacancies: 0,
    slotGroup: "OTHER",
  };
}`,
        `function isSlotCapacityReached(stats, serviceKey) {
  const sk = serviceToKey(serviceKey);

  if (sk === "PE") {
    return Number(stats?.peReserved || 0) >= Number(stats?.peCap || 0);
  }

  if (sk === "NUT") {
    return Number(stats?.nutReserved || 0) >= Number(stats?.nutCap || 0);
  }

  if (isOperationalServiceKey(sk)) {
    return Number(stats?.effectiveAvailable || 0) <= 0;
  }

  return true;
}

function capacityResponseFields(stats, serviceKey) {
  const sk = serviceToKey(serviceKey);

  if (sk === "PE") {
    const available = Math.max(
      0,
      Number(stats?.peCap || 0) - Number(stats?.peReserved || 0)
    );
    return {
      capacity: Number(stats?.peCap || 0),
      reserved: Number(stats?.peReserved || 0),
      available,
      availableVacancies: available,
      slotGroup: "PE",
    };
  }

  if (sk === "NUT") {
    const available = Math.max(
      0,
      Number(stats?.nutCap || 0) - Number(stats?.nutReserved || 0)
    );
    return {
      capacity: Number(stats?.nutCap || 0),
      reserved: Number(stats?.nutReserved || 0),
      available,
      availableVacancies: available,
      slotGroup: "NUT",
    };
  }

  if (isOperationalServiceKey(sk)) {
    const usingServiceLimit = stats?.serviceCap != null;
    const zone = capacityZoneForService(sk);

    return {
      capacity: Number(stats?.effectiveCap || 0),
      reserved: Number(
        usingServiceLimit || zone === "NONE"
          ? stats?.serviceReserved || 0
          : stats?.zoneReserved || 0
      ),
      available: Math.max(0, Number(stats?.effectiveAvailable || 0)),
      availableVacancies: Math.max(
        0,
        Number(stats?.effectiveAvailable || 0)
      ),
      slotGroup:
        zone === "NONE"
          ? sk
          : zone === "PERFORMANCE"
            ? "THERAPY_SHARED"
            : zone,
    };
  }

  return {
    capacity: 0,
    reserved: 0,
    available: 0,
    availableVacancies: 0,
    slotGroup: "OTHER",
  };
}`
      ),
      rep(
        "cancelación cutoff catálogo",
        `function getCancellationPolicyForService(serviceName) {
  const sk = serviceToKey(serviceName);
  return CANCELLATION_POLICY_BY_SERVICE[sk] || CANCELLATION_POLICY_BY_SERVICE.OTHER;
}`,
        `function getCancellationPolicyForService(serviceName) {
  const sk = serviceToKey(serviceName);
  const base =
    CANCELLATION_POLICY_BY_SERVICE[sk] ||
    CANCELLATION_POLICY_BY_SERVICE.OTHER;

  return {
    ...base,
    refundCutoffHours: serviceCancellationCutoffHours(
      sk,
      Number(base?.refundCutoffHours || 1)
    ),
  };
}`
      ),
      rep(
        "remove weekend hardcode",
        `  if (isSaturday(date)) {
    return { ok: false, error: "Los sábados no hay turnos disponibles para este servicio." };
  }

  if (isSunday(date)) {
    return { ok: false, error: "Los domingos no hay turnos disponibles." };
  }

`,
        ``,
        2
      ),
      rep(
        "window con servicio",
        `const w = validateBookingWindow(slotDate);`,
        `const w = validateBookingWindow(slotDate, normalizedServiceKey);`,
        2
      ),
      rep(
        "availability sin cierre weekend",
        `    if (isSunday(date) || isSaturday(date)) {
      return res.json({
        date,
        service: normalizedServiceName,
        serviceKey: normalizedServiceKey,
        slots: times.map((t) => ({
          time: t,
          state: "closed",
          reason: isSunday(date)
            ? "Domingos no disponibles"
            : "Sábados no disponibles para este servicio",
        })),
      });
    }

`,
        ``
      ),
      rep(
        "capacity service dinámica",
        `  if (!["TRAINING", "PERFORMANCE"].includes(zone)) {
    return { ok: false, error: "Zona inválida." };
  }

  if (targetType === "service" && !["EP", "RA", "RF", "SYN"].includes(serviceKey)) {
    return { ok: false, error: "Servicio inválido para configurar vacantes." };
  }`,
        `  if (!["TRAINING", "PERFORMANCE", "NONE"].includes(zone)) {
    return { ok: false, error: "Zona inválida." };
  }

  if (
    targetType === "service" &&
    !isServiceEnabledFor(serviceKey, "active")
  ) {
    return {
      ok: false,
      error: "Servicio inválido para configurar vacantes.",
    };
  }`
      ),
      rep(
        "capacity zones dinámica",
        `      zones: [
        {
          key: "TRAINING",
          label: "TRAINING",
          services: [{ key: "EP", label: EP_NAME }],
        },
        {
          key: "PERFORMANCE",
          label: "PERFORMANCE",
          services: [
            { key: "RA", label: "Rehabilitación Activa" },
            { key: "RF", label: "Reeducación Funcional" },
            { key: "SYN", label: SYN_NAME },
          ],
        },
      ],`,
        `      zones: capacityZonesForAdmin(),`
      ),
      rep(
        "fixed service flag",
        `    if (!isOperationalServiceKey(serviceIdentity.serviceKey)) {
      return res.status(400).json({
        error: "Este servicio ya no está habilitado para nuevos turnos fijos.",
      });
    }`,
        `    if (
      !isServiceEnabledFor(
        serviceIdentity.serviceKey,
        "fixedScheduleEnabled"
      )
    ) {
      return res.status(400).json({
        error:
          "Este servicio no está habilitado para nuevos turnos fijos.",
      });
    }`
      ),
      rep(
        "fixed domingo",
        `it.weekday >= 1 && it.weekday <= 6`,
        `it.weekday >= 1 && it.weekday <= 7`,
        2
      ),
      rep(
        "legacy derive domingo",
        `if (weekday < 1 || weekday > 6) continue;`,
        `if (weekday < 1 || weekday > 7) continue;`
      ),
      rep(
        "fixed horarios catálogo",
        `    if (!cleanItems.length) {
      return res.status(400).json({ error: "No hay items válidos para guardar." });
    }

    const seenWeekdays = new Set();`,
        `    if (!cleanItems.length) {
      return res.status(400).json({ error: "No hay items válidos para guardar." });
    }

    const invalidScheduleItem = cleanItems.find(
      (item) =>
        !isWeekdayTimeAllowedForService(
          serviceIdentity.serviceKey,
          item.weekday,
          item.time
        )
    );

    if (invalidScheduleItem) {
      return res.status(400).json({
        error:
          "Uno de los días/horarios no está habilitado en la configuración del servicio.",
      });
    }

    const seenWeekdays = new Set();`
      ),
    ],
  },

  {
    file: "src/routes/users.js",
    replacements: [
      rep(
        "import runtime",
        `import { creditExpiryForDate } from "../utils/creditExpiry.js";`,
        `import { creditExpiryForDate } from "../utils/creditExpiry.js";
import {
  activeServiceKeysCached,
  ensureServiceCatalogLoaded,
  isServiceEnabledFor,
  normalizeCatalogServiceKey,
  serviceNameForKey,
} from "../services/serviceCatalogRuntime.js";`
      ),
      rep(
        "middleware runtime",
        `const router = express.Router();
const APTO_DEBUG_VERSION`,
        `const router = express.Router();

router.use(async (req, res, next) => {
  await ensureServiceCatalogLoaded();
  next();
});

const APTO_DEBUG_VERSION`
      ),
      rep(
        "canonical dinámica",
        `function canonicalServiceKeyFromValue(value) {
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
}`,
        `function canonicalServiceKeyFromValue(value) {
  return normalizeCatalogServiceKey(value);
}

function prettyServiceName(value) {
  const key = canonicalServiceKeyFromValue(value);
  if (key) return serviceNameForKey(key);
  return String(value || "Sesión").trim() || "Sesión";
}`
      ),
      rep(
        "byKey dinámico",
        `  const byKey = { PE: 0, EP: 0, RF: 0, RA: 0, KD: 0, SYN: 0, NUT: 0 };`,
        `  const byKey = {};`
      ),
      rep(
        "sum byKey dinámico",
        `    if (byKey[sk] !== undefined) byKey[sk] += remaining;`,
        `    if (!sk) continue;
    byKey[sk] = Number(byKey[sk] || 0) + remaining;`
      ),
      rep(
        "credit maps dinámicos",
        `  const creditsByServiceKey = { PE: 0, EP: 0, RF: 0, RA: 0, KD: 0, SYN: 0, NUT: 0 };
  const availableCreditsByServiceKey = { PE: 0, EP: 0, RF: 0, RA: 0, KD: 0, SYN: 0, NUT: 0 };

  for (const k of Object.keys(availableCreditsByServiceKey)) {
    availableCreditsByServiceKey[k] = Number(byKey[k] || 0);
    creditsByServiceKey[k] = Number(byKey[k] || 0);
  }`,
        `  const creditsByServiceKey = {};
  const availableCreditsByServiceKey = {};

  for (const k of Object.keys(byKey)) {
    availableCreditsByServiceKey[k] = Number(byKey[k] || 0);
    creditsByServiceKey[k] = Number(byKey[k] || 0);
  }`
      ),
      rep(
        "allowed services dinámicos",
        `  for (const k of ["EP", "RF", "RA", "SYN"]) {
    const available = Number(availableCreditsByServiceKey[k] || 0);

    if (available > 0) {
      const label = SERVICE_KEY_TO_NAME[k] || k;
      allowedServices.push(label);
      serviceCredits[label] = available;
    }
  }`,
        `  for (const k of activeServiceKeysCached({ flag: "reservable" })) {
    const available = Number(availableCreditsByServiceKey[k] || 0);

    if (available > 0) {
      const label = serviceNameForKey(k);
      allowedServices.push(label);
      serviceCredits[label] = available;
    }
  }`
      ),
      rep(
        "history nombre dinámico",
        `    serviceName: SERVICE_KEY_TO_NAME[sk] || sk,
    service: SERVICE_KEY_TO_NAME[sk] || sk,`,
        `    serviceName: serviceNameForKey(sk),
    service: serviceNameForKey(sk),`
      ),
      rep(
        "buildCreditsByService dinámico",
        `function buildCreditsByService(user) {
  const firstEvaluationCompleted = !!user?.firstEvaluationCompleted;

  const result = {
    EP: sumCreditsForService(user, "EP"),
    RF: sumCreditsForService(user, "RF"),
    RA: sumCreditsForService(user, "RA"),
    KD: sumCreditsForService(user, "KD"),
    SYN: sumCreditsForService(user, "SYN"),
    NUT: sumCreditsForService(user, "NUT"),
  };

  if (!firstEvaluationCompleted) {
    result.PE = sumCreditsForService(user, "PE");
  }

  return result;
}`,
        `function buildCreditsByService(user) {
  const firstEvaluationCompleted = !!user?.firstEvaluationCompleted;
  const result = {};

  const keys = new Set([
    ...activeServiceKeysCached({ flag: "active", includeLegacy: true }),
    ...(Array.isArray(user?.creditLots)
      ? user.creditLots
          .map((lot) => normalizeLotServiceKey(lot))
          .filter(Boolean)
      : []),
  ]);

  for (const key of keys) {
    if (key === "PE" && firstEvaluationCompleted) continue;
    result[key] = sumCreditsForService(user, key);
  }

  return result;
}`
      ),
      rep(
        "validación créditos dinámica",
        `      const sk = canonicalServiceKeyFromValue(skRaw);
      if (!sk || !ALLOWED_SERVICE_KEYS.has(sk)) {
        const err = new Error("serviceKey inválido.");
        err.status = 400;
        throw err;
      }

      if (!OPERATIONAL_SERVICE_KEYS.has(sk)) {
        const err = new Error("Este servicio ya no admite nuevas cargas de sesiones.");
        err.status = 400;
        throw err;
      }`,
        `      const sk = canonicalServiceKeyFromValue(skRaw);
      if (!sk || !isServiceEnabledFor(sk, "active")) {
        const err = new Error("serviceKey inválido o servicio inactivo.");
        err.status = 400;
        throw err;
      }`
      ),
    ],
  },

  {
    file: "src/routes/scheduleBlocks.js",
    replacements: [
      rep(
        "import runtime",
        `import { protect } from "../middleware/auth.js";`,
        `import { protect } from "../middleware/auth.js";
import {
  activeServiceKeysCached,
  ensureServiceCatalogLoaded,
  normalizeCatalogServiceKey,
  serviceNameForKey,
} from "../services/serviceCatalogRuntime.js";`
      ),
      rep(
        "normalize key dinámica",
        `function normalizeServiceKey(value) {
  const up = cleanString(value).toUpperCase();
  if (up === "ALL" || up === "TODOS") return "ALL";
  if (up === "AR") return "RA";
  if (up === "KINEDEPO" || up === "KINE-DEPO") return "KD";
  return SERVICE_KEYS.includes(up) ? up : "";
}`,
        `function normalizeServiceKey(value) {
  const up = cleanString(value).toUpperCase();
  if (up === "ALL" || up === "TODOS") return "ALL";
  return normalizeCatalogServiceKey(value);
}`
      ),
      rep(
        "ALL dinámico",
        `  const normalized = raw.map(normalizeServiceKey).filter(Boolean);
  if (normalized.includes("ALL")) return SERVICE_KEYS;

  return Array.from(new Set(normalized.filter((x) => x !== "ALL")));`,
        `  const normalized = raw.map(normalizeServiceKey).filter(Boolean);
  if (normalized.includes("ALL")) {
    return activeServiceKeysCached({ flag: "active" });
  }

  return Array.from(new Set(normalized.filter((x) => x !== "ALL")));`
      ),
      rep(
        "allServices semántica",
        `    allServices: serviceKeys.length === SERVICE_KEYS.length,`,
        `    allServices:
      body.allServices === true ||
      normalizeServiceKey(body.serviceKey) === "ALL" ||
      (Array.isArray(body.serviceKeys) &&
        body.serviceKeys.some(
          (key) => normalizeServiceKey(key) === "ALL"
        )),`
      ),
      rep(
        "service names catálogo",
        `function serviceNamesFor(keys = [], allServices = false) {
  const list = Array.isArray(keys) ? keys : [];
  if (allServices || list.length === SERVICE_KEYS.length) return "Todos los servicios";
  return list.map((k) => SERVICE_KEY_TO_NAME[k] || k).join(", ");
}`,
        `function serviceNamesFor(keys = [], allServices = false) {
  const list = Array.isArray(keys) ? keys : [];
  if (allServices) return "Todos los servicios";
  return list.map((key) => serviceNameForKey(key)).join(", ");
}`
      ),
      rep(
        "middleware cache",
        `router.use(protect);
router.use(ensureStaff);`,
        `router.use(protect);
router.use(async (req, res, next) => {
  await ensureServiceCatalogLoaded();
  next();
});
router.use(ensureStaff);`
      ),
    ],
  },

  {
    file: "src/routes/subscriptions.js",
    replacements: [
      rep(
        "import runtime",
        `} from "../services/subscriptions/subscriptionExtraSessions.js";`,
        `} from "../services/subscriptions/subscriptionExtraSessions.js";
import {
  ensureServiceCatalogLoaded,
  isServiceEnabledFor,
  normalizeCatalogServiceKey,
  serviceNameForKey,
} from "../services/serviceCatalogRuntime.js";`
      ),
      rep(
        "middleware cache",
        `const router = express.Router();
router.use(protect);`,
        `const router = express.Router();
router.use(protect);
router.use(async (req, res, next) => {
  await ensureServiceCatalogLoaded();
  next();
});`
      ),
      rep(
        "admin plan keys dinámicas",
        `const ADMIN_MONTHLY_PLAN_SERVICE_KEYS = new Set(["EP", "RF", "RA", "SYN"]);

const ADMIN_MONTHLY_PLAN_SERVICE_NAMES = {
  EP: "Entrenamiento Personal",
  RF: "Reeducación Funcional",
  RA: "Rehabilitación Activa",
  SYN: "Synergy",
};`,
        ``
      ),
      rep(
        "normalize monthly plan dinámica",
        `function normalizeMonthlyPlanServiceKey(value) {
  const key = String(value || "").toUpperCase().trim();
  return ADMIN_MONTHLY_PLAN_SERVICE_KEYS.has(key) ? key : "";
}`,
        `function normalizeMonthlyPlanServiceKey(value) {
  const key = normalizeCatalogServiceKey(value);
  return isServiceEnabledFor(key, "recurringPlanEnabled") ? key : "";
}`
      ),
      rep(
        "admin list subscriptions dinámico",
        `      const subscriptions = await ServiceSubscription.find({
        user: targetUserId,
        serviceKey: { $in: [...ADMIN_MONTHLY_PLAN_SERVICE_KEYS] },
      })`,
        `      const subscriptions = await ServiceSubscription.find({
        user: targetUserId,
      })`
      ),
      rep(
        "subscription service name catálogo",
        `        serviceName: ADMIN_MONTHLY_PLAN_SERVICE_NAMES[serviceKey] || serviceKey,`,
        `        serviceName: serviceNameForKey(serviceKey),`
      ),
    ],
  },

  {
    file: "src/models/CapacityRule.js",
    replacements: [
      rep(
        "zone NONE",
        `      enum: ["TRAINING", "PERFORMANCE"],`,
        `      enum: ["TRAINING", "PERFORMANCE", "NONE"],`
      ),
    ],
  },
];

function inspectPatch(patch) {
  const original = read(patch.file);
  let current = original;
  const details = [];

  for (const item of patch.replacements) {
    const fromCount = current.split(item.from).length - 1;
    const toCount = current.split(item.to).length - 1;

    if (fromCount === item.count) {
      for (let i = 0; i < item.count; i += 1) {
        current = current.replace(item.from, item.to);
      }
      details.push({
        label: item.label,
        status: "READY",
        occurrences: item.count,
      });
      continue;
    }

    if (fromCount === 0 && toCount >= item.count) {
      details.push({
        label: item.label,
        status: "ALREADY_APPLIED",
        occurrences: item.count,
      });
      continue;
    }

    fail(
      `${patch.file}: "${item.label}" encontró ${fromCount} coincidencias; ` +
        `esperaba ${item.count}. No se escribió ningún archivo.`
    );
  }

  return {
    file: patch.file,
    original,
    patched: current,
    changed: current !== original,
    beforeHash: sha(original),
    afterHash: sha(current),
    details,
  };
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");

  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function atomicWrite(rel, content) {
  const target = abs(rel);
  const tmp = `${target}.step3b1.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, target);
}

try {
  for (const required of [
    "src/services/serviceCatalogRuntime.js",
    "src/routes/waitlist.js",
    "src/jobs/startWaitlist.js",
  ]) {
    if (!fs.existsSync(abs(required))) {
      fail(
        `Falta ${required}. Subilo desde el paquete Paso 3B1 antes de ejecutar.`
      );
    }
  }

  const inspected = patches.map(inspectPatch);

  const result = {
    ok: true,
    mode: APPLY ? "APPLY" : "DRY_RUN",
    root: ROOT,
    files: inspected.map((row) => ({
      file: row.file,
      changed: row.changed,
      beforeHash: row.beforeHash,
      afterHash: row.afterHash,
      replacements: row.details,
    })),
    filesWritten: 0,
  };

  if (APPLY) {
    const changing = inspected.filter((row) => row.changed);

    if (changing.length) {
      const backupDir = path.join(
        ROOT,
        "backups",
        `services-step3b1-${timestamp()}`
      );

      fs.mkdirSync(backupDir, { recursive: true });

      for (const row of changing) {
        const target = path.join(backupDir, row.file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, row.original, "utf8");
      }

      for (const row of changing) {
        atomicWrite(row.file, row.patched);
      }

      result.backupDir = path.relative(ROOT, backupDir);
      result.filesWritten = changing.length;
    }
  }

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        mode: APPLY ? "APPLY" : "DRY_RUN",
        error: error?.message || String(error),
      },
      null,
      2
    )
  );
  process.exitCode = 1;
}
