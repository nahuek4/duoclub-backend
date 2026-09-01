// backend/src/services/serviceCatalogRuntime.js
import ServiceDefinition, {
  CORE_SERVICE_DEFINITIONS,
} from "../models/ServiceDefinition.js";

const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;
const CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.SERVICE_CATALOG_CACHE_MS || 5000)
);

const LEGACY_NAME_TO_KEY = [
  [["primera", "evaluacion"], "PE"],
  [["entrenamiento", "personal"], "EP"],
  [["rehabilitacion", "activa"], "RA"],
  [["reeducacion", "funcional"], "RF"],
  [["kinefilaxia"], "KD"],
  [["synergy"], "SYN"],
  [["sinergia"], "SYN"],
  [["nutric"], "NUT"],
];

const LEGACY_NAMES = Object.freeze({
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
  NUT: "Nutrición",
});

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function cleanKey(value) {
  return String(value || "").toUpperCase().trim();
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function mondayFirstWeekday(dateStr) {
  const [y, m, d] = String(dateStr || "").slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return 0;
  const js = new Date(y, m - 1, d).getDay();
  return js === 0 ? 7 : js;
}

function hhmmToMinutes(value) {
  const [h, m] = String(value || "").slice(0, 5).split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return NaN;
  return h * 60 + m;
}

function minutesToHhmm(value) {
  const n = Math.max(0, Number(value || 0));
  const h = Math.floor(n / 60);
  const m = n % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function normalizeDefinition(raw = {}) {
  const serviceKey = cleanKey(raw?.serviceKey);
  if (!SERVICE_KEY_RE.test(serviceKey)) return null;

  return {
    _id: raw?._id || null,
    serviceKey,
    name: String(raw?.name || LEGACY_NAMES[serviceKey] || serviceKey).trim(),
    description: String(raw?.description || "").trim(),
    category: String(raw?.category || "other").toLowerCase().trim(),
    active: raw?.active !== false,
    catalogVisible: raw?.catalogVisible !== false,
    purchasable: raw?.purchasable !== false,
    reservable: raw?.reservable !== false,
    recurringPlanEnabled: raw?.recurringPlanEnabled !== false,
    fixedScheduleEnabled: raw?.fixedScheduleEnabled !== false,
    waitlistEnabled: raw?.waitlistEnabled === true,
    capacityGroup: String(raw?.capacityGroup || "NONE").toUpperCase().trim() || "NONE",
    duration: Math.max(5, Number(raw?.duration || 60)),
    slotMinutes: Math.max(5, Number(raw?.slotMinutes || 60)),
    minBookingMinutes: Math.max(0, Number(raw?.minBookingMinutes || 0)),
    maxAdvanceDays: Math.max(0, Number(raw?.maxAdvanceDays || 30)),
    cancellationCutoffHours: Math.max(
      0,
      Number(raw?.cancellationCutoffHours || 0)
    ),
    sortOrder: Number(raw?.sortOrder || 100),
    weeklyHours: Array.isArray(raw?.weeklyHours)
      ? raw.weeklyHours.map((day) => ({
          weekday: Number(day?.weekday || 0),
          enabled: day?.enabled !== false,
          ranges: (Array.isArray(day?.ranges) ? day.ranges : []).map((range) => ({
            from: String(range?.from || "").slice(0, 5),
            to: String(range?.to || "").slice(0, 5),
          })),
        }))
      : [],
    legacy: raw?.legacy === true,
  };
}

const fallbackDefinitions = CORE_SERVICE_DEFINITIONS
  .map(normalizeDefinition)
  .filter(Boolean);

let cache = new Map(
  fallbackDefinitions.map((item) => [item.serviceKey, item])
);
let nameIndex = new Map();
let loadedAt = 0;
let refreshPromise = null;

function rebuildNameIndex() {
  const next = new Map();

  for (const item of cache.values()) {
    const name = stripAccents(item?.name).toLowerCase().trim();
    if (name) next.set(name, item.serviceKey);
  }

  nameIndex = next;
}

rebuildNameIndex();

export function normalizeCatalogServiceKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const up = cleanKey(raw);

  if (up === "AR") return "RA";
  if (up === "KINEDEPO" || up === "KINE-DEPO") return "KD";
  if (up === "SYNERGY" || up === "SINERGIA") return "SYN";

  if (SERVICE_KEY_RE.test(up)) return up;

  const normalizedName = stripAccents(raw).toLowerCase().trim();
  if (nameIndex.has(normalizedName)) return nameIndex.get(normalizedName) || "";

  for (const [parts, key] of LEGACY_NAME_TO_KEY) {
    if (parts.every((part) => normalizedName.includes(part))) return key;
  }

  return "";
}

export function serviceDefinitionCached(value) {
  const key = normalizeCatalogServiceKey(value);
  return key ? cache.get(key) || null : null;
}

export function serviceNameForKey(value) {
  const key = normalizeCatalogServiceKey(value);
  if (!key) return "";
  return (
    serviceDefinitionCached(key)?.name ||
    LEGACY_NAMES[key] ||
    key
  );
}

export function isKnownCatalogService(value) {
  const key = normalizeCatalogServiceKey(value);
  return Boolean(key && cache.has(key));
}

export function isServiceEnabledFor(value, flag = "active") {
  const item = serviceDefinitionCached(value);
  if (!item || item.active === false) return false;

  if (!flag || flag === "active") return true;
  return item?.[flag] === true;
}

export function capacityGroupForService(value) {
  const item = serviceDefinitionCached(value);
  if (!item) return "NONE";
  const group = String(item.capacityGroup || "NONE").toUpperCase().trim();
  return ["TRAINING", "PERFORMANCE"].includes(group) ? group : "NONE";
}

export function serviceMinBookingMinutes(value, fallback = 60) {
  const item = serviceDefinitionCached(value);
  return item ? Math.max(0, Number(item.minBookingMinutes || 0)) : fallback;
}

export function serviceMaxAdvanceDays(value, fallback = 30) {
  const item = serviceDefinitionCached(value);
  return item ? Math.max(0, Number(item.maxAdvanceDays || 0)) : fallback;
}

export function serviceCancellationCutoffHours(value, fallback = 1) {
  const item = serviceDefinitionCached(value);
  return item
    ? Math.max(0, Number(item.cancellationCutoffHours || 0))
    : fallback;
}

export function isWeekdayTimeAllowedForService(value, weekday, time) {
  const item = serviceDefinitionCached(value);
  if (!item || item.active === false || item.reservable !== true) return false;

  const wantedWeekday = Number(weekday || 0);
  const wantedTime = String(time || "").slice(0, 5);

  const day = (item.weeklyHours || []).find(
    (entry) =>
      Number(entry?.weekday || 0) === wantedWeekday &&
      entry?.enabled !== false
  );

  if (!day || !wantedTime) return false;

  return (day.ranges || []).some((range) => {
    const from = String(range?.from || "").slice(0, 5);
    const to = String(range?.to || "").slice(0, 5);
    return from && to && wantedTime >= from && wantedTime < to;
  });
}

export function allowedTimesForService(value, dateStr) {
  const item = serviceDefinitionCached(value);
  if (!item || item.active === false || item.reservable !== true) return [];

  const weekday = mondayFirstWeekday(dateStr);
  if (!weekday) return [];

  const day = (item.weeklyHours || []).find(
    (entry) =>
      Number(entry?.weekday || 0) === weekday &&
      entry?.enabled !== false
  );

  if (!day) return [];

  const step = Math.max(5, Number(item.slotMinutes || 60));
  const result = [];

  for (const range of day.ranges || []) {
    const from = hhmmToMinutes(range?.from);
    const to = hhmmToMinutes(range?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;

    for (let cursor = from; cursor < to; cursor += step) {
      result.push(minutesToHhmm(cursor));
      if (result.length > 200) break;
    }
  }

  return [...new Set(result)].sort();
}

export function activeServiceKeysCached({ flag = "active", includeLegacy = false } = {}) {
  return [...cache.values()]
    .filter((item) => item.active !== false)
    .filter((item) => includeLegacy || item.legacy !== true)
    .filter((item) => !flag || flag === "active" || item?.[flag] === true)
    .sort((a, b) => {
      const ao = Number(a.sortOrder || 100);
      const bo = Number(b.sortOrder || 100);
      if (ao !== bo) return ao - bo;
      return String(a.name || "").localeCompare(String(b.name || ""), "es");
    })
    .map((item) => item.serviceKey);
}

export function serviceKeysForCapacityGroup(group, { flag = "reservable" } = {}) {
  const wanted = String(group || "").toUpperCase().trim();

  return [...cache.values()]
    .filter((item) => item.active !== false)
    .filter((item) => capacityGroupForService(item.serviceKey) === wanted)
    .filter((item) => !flag || item?.[flag] === true)
    .sort((a, b) => Number(a.sortOrder || 100) - Number(b.sortOrder || 100))
    .map((item) => item.serviceKey);
}

export function capacityZonesForAdmin() {
  const groups = ["TRAINING", "PERFORMANCE", "NONE"];

  return groups
    .map((group) => {
      const keys = serviceKeysForCapacityGroup(group, { flag: "reservable" });
      return {
        key: group,
        label: group === "NONE" ? "INDEPENDIENTES" : group,
        services: keys.map((key) => ({
          key,
          label: serviceNameForKey(key),
        })),
      };
    })
    .filter((group) => group.services.length > 0);
}

export function catalogRuntimeSnapshot() {
  return [...cache.values()]
    .sort((a, b) => Number(a.sortOrder || 100) - Number(b.sortOrder || 100))
    .map(clone);
}

export async function ensureServiceCatalogLoaded({ force = false } = {}) {
  const now = Date.now();

  if (
    !force &&
    loadedAt > 0 &&
    now - loadedAt < CACHE_TTL_MS
  ) {
    return catalogRuntimeSnapshot();
  }

  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const rows = await ServiceDefinition.find({})
        .sort({ sortOrder: 1, name: 1, serviceKey: 1 })
        .lean();

      if (rows.length) {
        const next = new Map();

        for (const raw of rows) {
          const normalized = normalizeDefinition(raw);
          if (normalized) next.set(normalized.serviceKey, normalized);
        }

        if (next.size) cache = next;
      }

      rebuildNameIndex();
      loadedAt = Date.now();
      return catalogRuntimeSnapshot();
    } catch (error) {
      // El fallback/caché previo mantiene EP/RA/RF/SYN operativos.
      console.error(
        "[SERVICE CATALOG RUNTIME] refresh failed:",
        error?.message || error
      );
      loadedAt = Date.now();
      return catalogRuntimeSnapshot();
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export function invalidateServiceCatalogCache() {
  loadedAt = 0;
}
