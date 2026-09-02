// frontend/scripts/applyDynamicFrontendStep3C1.mjs
//
// PASO 3C1 — Comprar + MiPlan + Home + Perfil
//
// Ejecutar desde la raíz del FRONTEND:
//
//   node scripts/applyDynamicFrontendStep3C1.mjs --dry-run
//   node scripts/applyDynamicFrontendStep3C1.mjs --apply
//
// DRY-RUN no escribe.
// APPLY crea backup antes de modificar.
// No toca Reservar/Admin todavía.

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();
const APPLY = process.argv.includes("--apply");

const HELPER_REL = "src/lib/serviceCatalogClient.js";
const HELPER_MARKER = "// STEP3C1_DYNAMIC_SERVICE_CATALOG_HELPER";

const HELPER_CONTENT = String.raw`// src/lib/serviceCatalogClient.js
// STEP3C1_DYNAMIC_SERVICE_CATALOG_HELPER

const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;

const LEGACY_LABELS = Object.freeze({
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
  NUT: "Nutrición",
});

const FALLBACK_PUBLIC_SERVICES = Object.freeze([
  {
    serviceKey: "EP",
    name: "Entrenamiento Personal",
    description:
      "DUO TRAINING · Entrenamiento personalizado con seguimiento profesional.",
    active: true,
    catalogVisible: true,
    purchasable: true,
    reservable: true,
    recurringPlanEnabled: true,
    fixedScheduleEnabled: true,
    waitlistEnabled: true,
    capacityGroup: "TRAINING",
    cancellationCutoffHours: 1,
    sortOrder: 10,
  },
  {
    serviceKey: "RA",
    name: "Rehabilitación Activa",
    description:
      "DUO PERFORMANCE · Rehabilitación activa con trabajo progresivo según objetivos terapéuticos.",
    active: true,
    catalogVisible: true,
    purchasable: true,
    reservable: true,
    recurringPlanEnabled: true,
    fixedScheduleEnabled: true,
    waitlistEnabled: true,
    capacityGroup: "PERFORMANCE",
    cancellationCutoffHours: 4,
    sortOrder: 20,
  },
  {
    serviceKey: "RF",
    name: "Reeducación Funcional",
    description:
      "DUO PERFORMANCE · Reeducación funcional orientada a recuperar función, control y movimiento.",
    active: true,
    catalogVisible: true,
    purchasable: true,
    reservable: true,
    recurringPlanEnabled: true,
    fixedScheduleEnabled: true,
    waitlistEnabled: true,
    capacityGroup: "PERFORMANCE",
    cancellationCutoffHours: 4,
    sortOrder: 30,
  },
  {
    serviceKey: "SYN",
    name: "Synergy",
    description: "DUO PERFORMANCE · Trabajo integral dentro del salón Performance.",
    active: true,
    catalogVisible: true,
    purchasable: true,
    reservable: true,
    recurringPlanEnabled: true,
    fixedScheduleEnabled: true,
    waitlistEnabled: true,
    capacityGroup: "PERFORMANCE",
    cancellationCutoffHours: 4,
    sortOrder: 40,
  },
]);

let cachedCatalog = FALLBACK_PUBLIC_SERVICES.map((item) => ({ ...item }));
let cachedByKey = new Map(
  cachedCatalog.map((item) => [item.serviceKey, item])
);

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function normalizeDynamicServiceKey(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  const up = stripAccents(raw).toUpperCase().trim();

  if (up === "AR") return "RA";
  if (up === "KINEDEPO" || up === "KINE-DEPO") return "KD";
  if (up === "SYNERGY" || up === "SINERGIA") return "SYN";

  if (SERVICE_KEY_RE.test(up)) return up;

  const text = stripAccents(raw).toLowerCase().trim();

  if (text.includes("primera") && text.includes("evaluacion")) return "PE";
  if (text.includes("entrenamiento") && text.includes("personal")) return "EP";
  if (text.includes("rehabilitacion") && text.includes("activa")) return "RA";
  if (text.includes("reeducacion") && text.includes("funcional")) return "RF";
  if (
    text.includes("kinefilaxia") ||
    (text.includes("kine") && text.includes("deport"))
  ) {
    return "KD";
  }
  if (text.includes("synergy") || text.includes("sinergia")) return "SYN";
  if (text.includes("nutric")) return "NUT";

  return "";
}

function normalizeCatalogItem(raw = {}) {
  const serviceKey = normalizeDynamicServiceKey(
    raw?.serviceKey || raw?.id || raw?.key
  );

  if (!serviceKey) return null;

  return {
    ...raw,
    serviceKey,
    id: String(raw?.id || raw?._id || serviceKey),
    name: String(
      raw?.name ||
        raw?.label ||
        LEGACY_LABELS[serviceKey] ||
        serviceKey
    ).trim(),
    description: String(raw?.description || "").trim(),
    active: raw?.active !== false,
    catalogVisible: raw?.catalogVisible !== false,
    purchasable: raw?.purchasable === true,
    reservable: raw?.reservable === true,
    recurringPlanEnabled: raw?.recurringPlanEnabled === true,
    fixedScheduleEnabled: raw?.fixedScheduleEnabled === true,
    waitlistEnabled: raw?.waitlistEnabled === true,
    capacityGroup: String(raw?.capacityGroup || "NONE")
      .toUpperCase()
      .trim(),
    cancellationCutoffHours: Math.max(
      0,
      Number(raw?.cancellationCutoffHours ?? 1)
    ),
    sortOrder: Number(raw?.sortOrder ?? 100),
  };
}

export function normalizeServiceCatalog(data) {
  const raw = Array.isArray(data)
    ? data
    : data?.items || data?.services || data?.list || [];

  return raw
    .map(normalizeCatalogItem)
    .filter(Boolean)
    .sort((a, b) => {
      const ao = Number(a?.sortOrder ?? 100);
      const bo = Number(b?.sortOrder ?? 100);
      if (ao !== bo) return ao - bo;

      return String(a?.name || "").localeCompare(
        String(b?.name || ""),
        "es"
      );
    });
}

export function primeServiceCatalog(data) {
  const normalized = normalizeServiceCatalog(data);

  // Si /services falla o devuelve algo vacío durante un despliegue,
  // conservamos el catálogo operativo actual como fallback seguro.
  if (!normalized.length) return cachedCatalog.slice();

  cachedCatalog = normalized.map((item) => ({ ...item }));
  cachedByKey = new Map(
    cachedCatalog.map((item) => [item.serviceKey, item])
  );

  return cachedCatalog.slice();
}

export function serviceCatalogRecord(value) {
  const key = normalizeDynamicServiceKey(value);
  return key ? cachedByKey.get(key) || null : null;
}

export function serviceCatalogName(value, fallback = "") {
  const key = normalizeDynamicServiceKey(value);

  return (
    serviceCatalogRecord(key)?.name ||
    LEGACY_LABELS[key] ||
    String(fallback || "").trim() ||
    key ||
    "Servicio"
  );
}

export function serviceCatalogDescription(value, fallback = "") {
  const key = normalizeDynamicServiceKey(value);

  return (
    String(serviceCatalogRecord(key)?.description || "").trim() ||
    String(fallback || "").trim()
  );
}

export function isCatalogServiceEnabled(value, flag = "active") {
  const item = serviceCatalogRecord(value);
  if (!item || item.active === false) return false;

  if (!flag || flag === "active") return true;
  return item?.[flag] === true;
}

export function serviceCatalogKeys(data = null, flag = "active") {
  const source =
    data == null
      ? cachedCatalog
      : normalizeServiceCatalog(data);

  return source
    .filter((item) => item.active !== false)
    .filter(
      (item) =>
        !flag ||
        flag === "active" ||
        item?.[flag] === true
    )
    .sort((a, b) => Number(a.sortOrder ?? 100) - Number(b.sortOrder ?? 100))
    .map((item) => item.serviceKey);
}

export function publicFallbackServiceKeys() {
  return FALLBACK_PUBLIC_SERVICES.map((item) => item.serviceKey);
}
`;

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
    file: "src/pages/Comprar.jsx",
    marker: "// STEP3C1_COMPRAR_DYNAMIC_SERVICES",
    replacements: [
      rep(
        "import catálogo",
        `import api from "../lib/api";`,
        `import api from "../lib/api";
import {
  normalizeDynamicServiceKey,
  normalizeServiceCatalog,
  primeServiceCatalog,
  serviceCatalogDescription,
  serviceCatalogKeys,
  serviceCatalogName,
  serviceCatalogRecord,
} from "../lib/serviceCatalogClient";

// STEP3C1_COMPRAR_DYNAMIC_SERVICES`
      ),
      rep(
        "normalización dinámica",
        `function normalizeServiceKey(v) {
  const raw = String(v || "").toUpperCase().trim();
  if (raw === "AR") return "RA";
  if (SERVICE_KEY_SET.has(raw)) return raw;

  const s = String(v || "")
    .normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase()
    .trim();

  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("kinefilaxia") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("synergy") || s.includes("sinergia") || s.includes("syn")) return "SYN";
  if (s.includes("nutric")) return "NUT";

  return "";
}`,
        `function normalizeServiceKey(v) {
  return normalizeDynamicServiceKey(v);
}`
      ),
      rep(
        "label catálogo",
        `function serviceLabel(serviceKey) {
  const k = normalizeServiceKey(serviceKey);
  return SERVICE_KEY_TO_LABEL[k] || "Servicio";
}`,
        `function serviceLabel(serviceKey) {
  const k = normalizeServiceKey(serviceKey);
  return serviceCatalogName(
    k,
    SERVICE_KEY_TO_LABEL[k] || k || "Servicio"
  );
}`
      ),
      rep(
        "descripción catálogo",
        `function serviceDescription(serviceKey) {
  const k = normalizeServiceKey(serviceKey);

  if (k === "PE") {`,
        `function serviceDescription(serviceKey) {
  const k = normalizeServiceKey(serviceKey);
  const fromCatalog = serviceCatalogDescription(k);
  if (fromCatalog) return fromCatalog;

  if (k === "PE") {`
      ),
      rep(
        "buyable dinámico",
        `function getBuyableServiceKeys() {
  return ["EP", "RF", "RA", "SYN"];
}`,
        `function getBuyableServiceKeys(catalog = []) {
  const dynamic = serviceCatalogKeys(catalog, "purchasable");
  return dynamic.length ? dynamic : ["EP", "RF", "RA", "SYN"];
}`
      ),
      rep(
        "state catálogo",
        `  const [plans, setPlans] = useState([]);
  const [extraNotices, setExtraNotices] = useState([]);`,
        `  const [plans, setPlans] = useState([]);
  const [serviceCatalog, setServiceCatalog] = useState([]);
  const [extraNotices, setExtraNotices] = useState([]);`
      ),
      rep(
        "load catálogo",
        `    const [pricingResult, statusResult, extrasResult] = await Promise.allSettled([
      api.get("/pricing?active=1"),
      api.get("/appointments/me/status"),
      api.get("/subscription-extras/me", { params: { _ts: Date.now() } }),
    ]);

    let nextPlans = [];
    let nextExtraNotices = [];`,
        `    const [pricingResult, servicesResult, statusResult, extrasResult] =
      await Promise.allSettled([
        api.get("/pricing?active=1"),
        api.get("/services", { params: { _ts: Date.now() } }),
        api.get("/appointments/me/status"),
        api.get("/subscription-extras/me", { params: { _ts: Date.now() } }),
      ]);

    let nextPlans = [];
    let nextCatalog = [];
    let nextExtraNotices = [];`
      ),
      rep(
        "procesa catálogo",
        `    if (statusResult.status === "fulfilled") {`,
        `    if (servicesResult.status === "fulfilled") {
      nextCatalog = normalizeServiceCatalog(servicesResult.value?.data);
      primeServiceCatalog(nextCatalog);
    }

    if (statusResult.status === "fulfilled") {`
      ),
      rep(
        "set catálogo",
        `    setPlans(nextPlans);
    setExtraNotices(nextExtraNotices);`,
        `    setPlans(nextPlans);
    setServiceCatalog(nextCatalog);
    setExtraNotices(nextExtraNotices);`
      ),
      rep(
        "planes sin lista fija",
        `      .filter((x) => ["EP", "RF", "RA", "SYN"].includes(x.serviceKey) && x.active !== false);`,
        `      .filter((x) => x.serviceKey && x.active !== false);`
      ),
      rep(
        "buyable memo catálogo",
        `  const buyableKeys = useMemo(() => getBuyableServiceKeys(), []);`,
        `  const buyableKeys = useMemo(
    () => getBuyableServiceKeys(serviceCatalog),
    [serviceCatalog]
  );`
      ),
      rep(
        "cards servicio dinámicas",
        `  const services = useMemo(() => {
    // Servicios operativos actuales.
    const order = ["EP", "RF", "RA", "SYN"];

    return buyableKeys
      .filter((key) => SERVICE_KEY_SET.has(key))
      .map((key) => {
        const hasPlans = normalized.some((p) => p.serviceKey === key);

        return {
          key,
          title: serviceLabel(key),
          desc: serviceDescription(key),
          chip: key,
          hasPlans,
        };
      })
      .sort((a, b) => {
        const ai = order.indexOf(a.key);
        const bi = order.indexOf(b.key);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return norm(a.title).localeCompare(norm(b.title));
      });
  }, [normalized, buyableKeys]);`,
        `  const services = useMemo(() => {
    return buyableKeys
      .map((key) => {
        const hasPlans = normalized.some((p) => p.serviceKey === key);
        const catalogItem = serviceCatalogRecord(key);

        return {
          key,
          title: serviceLabel(key),
          desc: serviceDescription(key),
          chip: key,
          hasPlans,
          sortOrder: Number(catalogItem?.sortOrder ?? 100),
        };
      })
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder ||
          norm(a.title).localeCompare(norm(b.title))
      );
  }, [normalized, buyableKeys, serviceCatalog]);`
      ),
    ],
  },

  {
    file: "src/pages/MiPlan.jsx",
    marker: "// STEP3C1_MIPLAN_DYNAMIC_SERVICES",
    replacements: [
      rep(
        "import catálogo",
        `import api from "../lib/api";`,
        `import api from "../lib/api";
import {
  isCatalogServiceEnabled,
  normalizeServiceCatalog,
  primeServiceCatalog,
  serviceCatalogName,
} from "../lib/serviceCatalogClient";

// STEP3C1_MIPLAN_DYNAMIC_SERVICES`
      ),
      rep(
        "label catálogo",
        `function serviceLabel(key, fallback = "") {
  return SERVICE_LABELS[String(key || "").toUpperCase()] || fallback || "Servicio";
}`,
        `function serviceLabel(key, fallback = "") {
  const normalized = String(key || "").toUpperCase().trim();
  return serviceCatalogName(
    normalized,
    SERVICE_LABELS[normalized] || fallback || normalized || "Servicio"
  );
}`
      ),
      rep(
        "state catálogo",
        `  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(true);`,
        `  const [plans, setPlans] = useState([]);
  const [serviceCatalog, setServiceCatalog] = useState([]);
  const [loading, setLoading] = useState(true);`
      ),
      rep(
        "load services",
        `      const [subsRes, noticesRes, extrasRes, pricingRes] = await Promise.all([
        api.get("/subscriptions/me", { params: { _ts: Date.now() } }),
        api.get("/subscriptions/notices", { params: { _ts: Date.now() } }),
        api.get("/subscription-extras/me", { params: { _ts: Date.now() } }),
        api.get("/pricing?active=1"),
      ]);

      setSubscriptions(subsRes?.data?.subscriptions || []);
      setNotices(noticesRes?.data?.notices || []);
      setExtras(extrasRes?.data?.items || []);

      const rawPlans = Array.isArray(pricingRes?.data)
        ? pricingRes.data
        : pricingRes?.data?.items || pricingRes?.data?.list || [];
      setPlans(rawPlans.map(normalizePlan).filter((p) => p.id && p.active && !p.isCustom && ["EP", "RF", "RA", "SYN"].includes(p.serviceKey)));`,
        `      const [subsRes, noticesRes, extrasRes, pricingRes, servicesRes] =
        await Promise.all([
          api.get("/subscriptions/me", { params: { _ts: Date.now() } }),
          api.get("/subscriptions/notices", { params: { _ts: Date.now() } }),
          api.get("/subscription-extras/me", { params: { _ts: Date.now() } }),
          api.get("/pricing?active=1"),
          api.get("/services", { params: { _ts: Date.now() } }),
        ]);

      const nextCatalog = normalizeServiceCatalog(servicesRes?.data);
      primeServiceCatalog(nextCatalog);
      setServiceCatalog(nextCatalog);

      setSubscriptions(subsRes?.data?.subscriptions || []);
      setNotices(noticesRes?.data?.notices || []);
      setExtras(extrasRes?.data?.items || []);

      const rawPlans = Array.isArray(pricingRes?.data)
        ? pricingRes.data
        : pricingRes?.data?.items || pricingRes?.data?.list || [];

      setPlans(
        rawPlans
          .map(normalizePlan)
          .filter(
            (p) =>
              p.id &&
              p.active &&
              !p.isCustom &&
              isCatalogServiceEnabled(
                p.serviceKey,
                "recurringPlanEnabled"
              )
          )
      );`
      ),
      rep(
        "consume state catálogo",
        `  const extrasBySubscription = useMemo(() => {`,
        `  // serviceCatalog fuerza re-render cuando cambian nombres/flags del catálogo.
  void serviceCatalog;

  const extrasBySubscription = useMemo(() => {`
      ),
    ],
  },

  {
    file: "src/pages/Home.jsx",
    marker: "// STEP3C1_HOME_DYNAMIC_SERVICES",
    replacements: [
      rep(
        "import catálogo",
        `import { formatDM } from "../lib/date";`,
        `import { formatDM } from "../lib/date";
import {
  isCatalogServiceEnabled,
  normalizeDynamicServiceKey,
  normalizeServiceCatalog,
  primeServiceCatalog,
  serviceCatalogKeys,
  serviceCatalogName,
  serviceCatalogRecord,
} from "../lib/serviceCatalogClient";

// STEP3C1_HOME_DYNAMIC_SERVICES`
      ),
      rep(
        "normalize dynamic",
        `function normalizeServiceKey(value) {
  const up = String(value || "").toUpperCase().trim();
  if (up === "AR") return "RA";
  if (up === "KINEDEPO" || up === "KINE-DEPO") return "KD";
  if (SERVICE_KEY_SET.has(up)) return up;

  const s = String(value || "")
    .normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase()
    .trim();

  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("kinefilaxia") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("synergy") || s.includes("sinergia")) return "SYN";
  if (s.includes("nutric")) return "NUT";

  return "";
}`,
        `function normalizeServiceKey(value) {
  return normalizeDynamicServiceKey(value);
}`
      ),
      rep(
        "label catálogo",
        `function serviceNameFromKey(serviceKey, fallback = "") {
  return (
    SERVICE_KEY_TO_LABEL[normalizeServiceKey(serviceKey)] ||
    String(fallback || "").trim() ||
    "Sesión"
  );
}`,
        `function serviceNameFromKey(serviceKey, fallback = "") {
  const key = normalizeServiceKey(serviceKey);
  return serviceCatalogName(
    key,
    SERVICE_KEY_TO_LABEL[key] ||
      String(fallback || "").trim() ||
      key ||
      "Sesión"
  );
}`
      ),
      rep(
        "policy catálogo",
        `function refundPolicyForService(serviceNameOrKey) {
  const sk = normalizeServiceKey(serviceNameOrKey);

  if (sk === "PE") return { key: "PE", cutoffHours: 1, inclusive: true };`,
        `function refundPolicyForService(serviceNameOrKey) {
  const sk = normalizeServiceKey(serviceNameOrKey);
  const catalogItem = serviceCatalogRecord(sk);

  if (catalogItem) {
    return {
      key: sk,
      cutoffHours: Math.max(
        0,
        Number(catalogItem.cancellationCutoffHours ?? 1)
      ),
      inclusive: true,
    };
  }

  if (sk === "PE") return { key: "PE", cutoffHours: 1, inclusive: true };`
      ),
      rep(
        "meta catálogo",
        `function serviceMetaFromAny(raw) {
  const s = norm(raw);

  if (s.includes("primera evaluacion") || s === "pe") {`,
        `function serviceMetaFromAny(raw) {
  const s = norm(raw);
  const dynamicKey = normalizeServiceKey(raw);
  const catalogItem = serviceCatalogRecord(dynamicKey);

  if (catalogItem) {
    return {
      key: dynamicKey,
      code: dynamicKey,
      title: serviceCatalogName(dynamicKey, dynamicKey),
      order: Number(catalogItem.sortOrder ?? 100),
    };
  }

  if (s.includes("primera evaluacion") || s === "pe") {`
      ),
      rep(
        "sum active catálogo",
        `    if (!ACTIVE_SERVICE_KEYS.has(sk)) return acc;`,
        `    if (!isCatalogServiceEnabled(sk, "active")) return acc;`
      ),
      rep(
        "expiry active catálogo",
        `    if (!ACTIVE_SERVICE_KEYS.has(sk)) continue;`,
        `    if (!isCatalogServiceEnabled(sk, "active")) continue;`
      ),
      rep(
        "ensure item catálogo",
        `    if (!key || !ACTIVE_SERVICE_KEYS.has(key)) return null;`,
        `    if (!key || !isCatalogServiceEnabled(key, "active")) return null;`
      ),
      rep(
        "iterate servicios catálogo",
        `  for (const sk of ACTIVE_SERVICE_KEYS) {

    const fromServer = creditsByServiceKey[sk];`,
        `  for (const sk of serviceCatalogKeys(null, "active")) {
    const fromServer = creditsByServiceKey[sk];`
      ),
      rep(
        "state catálogo",
        `  const [appointments, setAppointments] = useState([]);
  const [extraNotices, setExtraNotices] = useState([]);`,
        `  const [appointments, setAppointments] = useState([]);
  const [serviceCatalog, setServiceCatalog] = useState([]);
  const [extraNotices, setExtraNotices] = useState([]);`
      ),
      rep(
        "credits depende catálogo",
        `  }, [effectiveUser]);

  const creditCards = useMemo(() => {`,
        `  }, [effectiveUser, serviceCatalog]);

  const creditCards = useMemo(() => {`
      ),
      rep(
        "cards depende catálogo",
        `  }, [effectiveUser, appointments, credits]);`,
        `  }, [effectiveUser, appointments, credits, serviceCatalog]);`
      ),
      rep(
        "loader catálogo",
        `  const loadExtraNotices = useCallback(async () => {`,
        `  const loadServiceCatalog = useCallback(async () => {
    try {
      const { data } = await api.get("/services", {
        params: { _ts: Date.now() },
      });
      const next = normalizeServiceCatalog(data);
      primeServiceCatalog(next);
      setServiceCatalog(next);
      return next;
    } catch (e) {
      console.error("Home loadServiceCatalog:", e);
      return [];
    }
  }, []);

  const loadExtraNotices = useCallback(async () => {`
      ),
      rep(
        "loadAll catálogo",
        `        loadHistory(),
        loadExtraNotices(),
      ]);
    } finally {
      setLoading(false);
    }
  }, [loadAppointments, loadFreshUser, loadHistory, loadExtraNotices]);`,
        `        loadHistory(),
        loadServiceCatalog(),
        loadExtraNotices(),
      ]);
    } finally {
      setLoading(false);
    }
  }, [
    loadAppointments,
    loadFreshUser,
    loadHistory,
    loadServiceCatalog,
    loadExtraNotices,
  ]);`
      ),
      rep(
        "focus catálogo",
        `    function onFocus() {
      loadFreshUser();
      loadExtraNotices();
    }

    function onVisible() {
      if (document.visibilityState === "visible") {
        loadFreshUser();
        loadExtraNotices();
      }
    }`,
        `    function onFocus() {
      loadFreshUser();
      loadServiceCatalog();
      loadExtraNotices();
    }

    function onVisible() {
      if (document.visibilityState === "visible") {
        loadFreshUser();
        loadServiceCatalog();
        loadExtraNotices();
      }
    }`
      ),
      rep(
        "focus deps catálogo",
        `  }, [currentUserId, loadFreshUser, loadExtraNotices]);`,
        `  }, [
    currentUserId,
    loadFreshUser,
    loadServiceCatalog,
    loadExtraNotices,
  ]);`
      ),
    ],
  },

  {
    file: "src/pages/Perfil.jsx",
    marker: "// STEP3C1_PERFIL_DYNAMIC_SERVICES",
    replacements: [
      rep(
        "import catálogo",
        `import { formatDM } from "../lib/date";`,
        `import { formatDM } from "../lib/date";
import {
  isCatalogServiceEnabled,
  normalizeDynamicServiceKey,
  normalizeServiceCatalog,
  primeServiceCatalog,
  serviceCatalogName,
  serviceCatalogRecord,
} from "../lib/serviceCatalogClient";

// STEP3C1_PERFIL_DYNAMIC_SERVICES`
      ),
      rep(
        "normalize dynamic",
        `function normalizeServiceKey(value) {
  const up = String(value || "").toUpperCase().trim();
  if (up === "AR") return "RA";
  if (up === "KINEDEPO" || up === "KINE-DEPO") return "KD";
  if (SERVICE_KEY_SET.has(up)) return up;

  const s = String(value || "")
    .normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .trim()
    .toLowerCase();

  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("kinefilaxia") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("synergy") || s.includes("sinergia")) return "SYN";
  if (s.includes("nutric")) return "NUT";

  return "";
}`,
        `function normalizeServiceKey(value) {
  return normalizeDynamicServiceKey(value);
}`
      ),
      rep(
        "label catálogo",
        `function serviceNameFromKey(serviceKey, fallback = "") {
  return SERVICE_KEY_TO_LABEL[normalizeServiceKey(serviceKey)] || String(fallback || "").trim() || "Sesión";
}`,
        `function serviceNameFromKey(serviceKey, fallback = "") {
  const key = normalizeServiceKey(serviceKey);
  return serviceCatalogName(
    key,
    SERVICE_KEY_TO_LABEL[key] ||
      String(fallback || "").trim() ||
      key ||
      "Sesión"
  );
}`
      ),
      rep(
        "credits catálogo",
        `    if (!ACTIVE_SERVICE_KEYS.has(sk)) return acc;`,
        `    if (!isCatalogServiceEnabled(sk, "active")) return acc;`
      ),
      rep(
        "policy catálogo",
        `function refundPolicyForService(serviceNameOrKey) {
  const sk = normalizeServiceKey(serviceNameOrKey);

  if (sk === "RA") return { key: "RA", cutoffHours: 4, inclusive: true };`,
        `function refundPolicyForService(serviceNameOrKey) {
  const sk = normalizeServiceKey(serviceNameOrKey);
  const catalogItem = serviceCatalogRecord(sk);

  if (catalogItem) {
    return {
      key: sk,
      cutoffHours: Math.max(
        0,
        Number(catalogItem.cancellationCutoffHours ?? 1)
      ),
      inclusive: true,
    };
  }

  if (sk === "RA") return { key: "RA", cutoffHours: 4, inclusive: true };`
      ),
      rep(
        "state catálogo",
        `  const [appointments, setAppointments] = useState([]);
  const [loadingAp, setLoadingAp] = useState(true);`,
        `  const [appointments, setAppointments] = useState([]);
  const [serviceCatalog, setServiceCatalog] = useState([]);
  const [loadingAp, setLoadingAp] = useState(true);`
      ),
      rep(
        "credits deps catálogo",
        `  }, [effectiveUser]);

  const role = String(effectiveUser?.role || "client").toLowerCase();`,
        `  }, [effectiveUser, serviceCatalog]);

  const role = String(effectiveUser?.role || "client").toLowerCase();`
      ),
      rep(
        "loader catálogo",
        `  async function loadAppointments() {`,
        `  async function loadServiceCatalog() {
    try {
      const { data } = await api.get("/services", {
        params: { _ts: Date.now() },
      });
      const next = normalizeServiceCatalog(data);
      primeServiceCatalog(next);
      setServiceCatalog(next);
      return next;
    } catch (e) {
      console.error("Perfil loadServiceCatalog:", e);
      return [];
    }
  }

  async function loadAppointments() {`
      ),
      rep(
        "initial catálogo",
        `  useEffect(() => {
    loadFreshUser();

    function onFocus() {`,
        `  useEffect(() => {
    loadFreshUser();
    loadServiceCatalog();

    function onFocus() {`
      ),
      rep(
        "focus catálogo",
        `      loadFreshUser({ silent: true });
    }

    function onVisible() {`,
        `      loadFreshUser({ silent: true });
      loadServiceCatalog();
    }

    function onVisible() {`
      ),
      rep(
        "visible catálogo",
        `      loadFreshUser({ silent: true });
    }

    window.addEventListener("focus", onFocus);`,
        `      loadFreshUser({ silent: true });
      loadServiceCatalog();
    }

    window.addEventListener("focus", onFocus);`
      ),
    ],
  },
];

function inspectPatch(patch) {
  const original = read(patch.file);

  if (original.includes(patch.marker)) {
    return {
      file: patch.file,
      original,
      patched: original,
      changed: false,
      beforeHash: sha(original),
      afterHash: sha(original),
      status: "ALREADY_APPLIED",
      replacements: [],
    };
  }

  let current = original;
  const details = [];

  for (const item of patch.replacements) {
    const count = current.split(item.from).length - 1;

    if (count !== item.count) {
      fail(
        `${patch.file}: "${item.label}" encontró ${count} coincidencias; ` +
          `esperaba ${item.count}. No se escribió ningún archivo.`
      );
    }

    for (let i = 0; i < item.count; i += 1) {
      current = current.replace(item.from, item.to);
    }

    details.push({
      label: item.label,
      status: "READY",
      occurrences: item.count,
    });
  }

  if (!current.includes(patch.marker)) {
    fail(`${patch.file}: no quedó marker ${patch.marker}.`);
  }

  return {
    file: patch.file,
    original,
    patched: current,
    changed: current !== original,
    beforeHash: sha(original),
    afterHash: sha(current),
    status: "READY",
    replacements: details,
  };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");

  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(
    d.getDate()
  )}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function atomicWrite(rel, content) {
  const target = abs(rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const tmp = `${target}.step3c1.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, target);
}

try {
  const inspected = patches.map(inspectPatch);

  const existingHelper = fs.existsSync(abs(HELPER_REL))
    ? fs.readFileSync(abs(HELPER_REL), "utf8")
    : "";

  const helperAlreadyApplied = existingHelper.includes(HELPER_MARKER);

  if (
    existingHelper &&
    !helperAlreadyApplied &&
    existingHelper !== HELPER_CONTENT
  ) {
    fail(
      `${HELPER_REL} ya existe pero no pertenece a Paso 3C1. ` +
        `No se sobrescribirá automáticamente.`
    );
  }

  const helperChanged = !helperAlreadyApplied;

  const result = {
    ok: true,
    mode: APPLY ? "APPLY" : "DRY_RUN",
    root: ROOT,
    helper: {
      file: HELPER_REL,
      status: helperAlreadyApplied ? "ALREADY_APPLIED" : "CREATE_READY",
      changed: helperChanged,
    },
    files: inspected.map((row) => ({
      file: row.file,
      status: row.status,
      changed: row.changed,
      beforeHash: row.beforeHash,
      afterHash: row.afterHash,
      replacements: row.replacements,
    })),
    filesWritten: 0,
  };

  if (APPLY) {
    const changing = inspected.filter((row) => row.changed);

    if (changing.length || helperChanged) {
      const backupDir = path.join(
        ROOT,
        "backups",
        `services-step3c1-${stamp()}`
      );

      fs.mkdirSync(backupDir, { recursive: true });

      for (const row of changing) {
        const target = path.join(backupDir, row.file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, row.original, "utf8");
      }

      if (existingHelper) {
        const helperBackup = path.join(backupDir, HELPER_REL);
        fs.mkdirSync(path.dirname(helperBackup), { recursive: true });
        fs.writeFileSync(helperBackup, existingHelper, "utf8");
      }

      if (helperChanged) {
        atomicWrite(HELPER_REL, HELPER_CONTENT);
      }

      for (const row of changing) {
        atomicWrite(row.file, row.patched);
      }

      result.backupDir = path.relative(ROOT, backupDir);
      result.filesWritten = changing.length + (helperChanged ? 1 : 0);
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
