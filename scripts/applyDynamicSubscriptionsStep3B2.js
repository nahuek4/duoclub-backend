// backend/scripts/applyDynamicSubscriptionsStep3B2.js
//
// PASO 3B2
// Uso:
//   node scripts/applyDynamicSubscriptionsStep3B2.js --dry-run
//   node scripts/applyDynamicSubscriptionsStep3B2.js --apply
//
// No toca MongoDB.
// Hace backup antes de escribir.
// Es idempotente mediante markers STEP3B2_*.

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
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function rep(label, from, to) {
  return { label, from, to };
}

const patches = [
  {
    file: "src/services/subscriptions/fixedScheduleCoverage.js",
    marker: "// STEP3B2_DYNAMIC_FIXED_COVERAGE",
    replacements: [
      rep(
        "serviceKey dinámico puro",
        `const SERVICE_KEYS = ["PE", "EP", "RA", "RF", "KD", "SYN", "NUT"];
const SERVICE_KEY_SET = new Set(SERVICE_KEYS);`,
        `// STEP3B2_DYNAMIC_FIXED_COVERAGE
const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;`
      ),
      rep(
        "normalización dinámica",
        `  if (upper === "SYNERGY" || upper === "SINERGIA") return "SYN";
  if (SERVICE_KEY_SET.has(upper)) return upper;

  const text = stripAccents(raw).toLowerCase().trim();`,
        `  if (upper === "SYNERGY" || upper === "SINERGIA") return "SYN";
  if (SERVICE_KEY_RE.test(upper)) return upper;

  const text = stripAccents(raw).toLowerCase().trim();`
      ),
    ],
  },

  {
    file: "src/services/subscriptions/subscriptionLifecycle.js",
    marker: "// STEP3B2_DYNAMIC_SUBSCRIPTION_LIFECYCLE",
    replacements: [
      rep(
        "runtime catálogo import",
        `import { projectActiveFixedSchedulesForMonth } from "./subscriptionScheduleProjection.js";`,
        `import { projectActiveFixedSchedulesForMonth } from "./subscriptionScheduleProjection.js";
import {
  ensureServiceCatalogLoaded,
  isServiceEnabledFor,
  normalizeCatalogServiceKey,
  serviceNameForKey,
} from "../serviceCatalogRuntime.js";

// STEP3B2_DYNAMIC_SUBSCRIPTION_LIFECYCLE`
      ),
      rep(
        "operational dinámico",
        `const RENEWABLE_STATUSES = ["active", "pending_change"];
const OPERATIONAL_SUBSCRIPTION_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);
const SERVICE_NAME = {
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
  NUT: "Nutrición",
};`,
        `const RENEWABLE_STATUSES = ["active", "pending_change"];`
      ),
      rep(
        "isOperational catálogo",
        `function isOperationalSubscriptionServiceKey(value) {
  return OPERATIONAL_SUBSCRIPTION_SERVICE_KEYS.has(clean(value).toUpperCase());
}`,
        `function isOperationalSubscriptionServiceKey(value) {
  const key = normalizeCatalogServiceKey(value);
  return isServiceEnabledFor(key, "recurringPlanEnabled");
}`
      ),
      rep(
        "snapshot usa precio vigente",
        `async function resolvePlanSnapshot(subscription, { session = null } = {}) {
  let plan = null;
  if (subscription.pricingPlan) {
    const query = PricingPlan.findById(subscription.pricingPlan).lean();
    if (session) query.session(session);
    plan = await query;
  }

  const monthlySessions = Math.max(1, asInt(plan?.credits || subscription.monthlySessions));
  const basePrice = asMoney(subscription.price ?? plan?.price);
  const payMethod = clean(subscription.payMethod || plan?.payMethod || "CASH").toUpperCase();

  return {
    pricingPlan: plan?._id || subscription.pricingPlan || null,
    label: clean(plan?.label || plan?.title || \`\${monthlySessions} sesiones\`),
    monthlySessions,
    basePrice,
    regularPrice: asMoney(subscription.regularPrice || basePrice),
    coveragePrice:
      subscription.coveragePrice === null || subscription.coveragePrice === undefined
        ? null
        : asMoney(subscription.coveragePrice),
    coverageApplied: !!subscription.coverageApplied,
    coverageReason: clean(subscription.coverageReason),
    payMethod: payMethod === "MP" ? "MP" : "CASH",
    fixedScheduleIds: Array.isArray(subscription.fixedScheduleIds)
      ? subscription.fixedScheduleIds
      : [],
    addOns: Array.isArray(subscription.addOns) ? subscription.addOns : [],
  };
}`,
        `async function findCurrentPublishedPlan(subscription, { session = null } = {}) {
  const serviceKey = normalizeCatalogServiceKey(subscription?.serviceKey);
  const monthlySessions = Math.max(1, asInt(subscription?.monthlySessions));
  const rawPayMethod = clean(subscription?.payMethod || "CASH").toUpperCase();
  const payMethod = rawPayMethod === "MP" ? "MP" : "CASH";

  if (!serviceKey || !monthlySessions) return null;

  const match = {
    active: true,
    isCustom: { $ne: true },
    serviceKey,
    credits: monthlySessions,
    payMethod,
  };

  if (
    subscription?.pricingPlan &&
    mongoose.Types.ObjectId.isValid(String(subscription.pricingPlan))
  ) {
    const linkedQuery = PricingPlan.findOne({
      _id: subscription.pricingPlan,
      ...match,
    }).lean();
    if (session) linkedQuery.session(session);
    const linked = await linkedQuery;
    if (linked) return linked;
  }

  const query = PricingPlan.findOne(match)
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();
  if (session) query.session(session);
  return query;
}

export async function resolvePlanSnapshot(
  subscription,
  { session = null } = {}
) {
  await ensureServiceCatalogLoaded();

  const serviceKey = normalizeCatalogServiceKey(subscription?.serviceKey);
  if (!isOperationalSubscriptionServiceKey(serviceKey)) {
    const error = new Error("SUBSCRIPTION_SERVICE_NOT_RECURRING");
    error.code = "SUBSCRIPTION_SERVICE_NOT_RECURRING";
    error.serviceKey = serviceKey;
    throw error;
  }

  const plan = await findCurrentPublishedPlan(subscription, { session });
  if (!plan) {
    const error = new Error(
      \`CURRENT_PUBLISHED_PLAN_NOT_FOUND:\${serviceKey}:\${Math.max(
        1,
        asInt(subscription?.monthlySessions)
      )}:\${clean(subscription?.payMethod || "CASH").toUpperCase()}\`
    );
    error.code = "CURRENT_PUBLISHED_PLAN_NOT_FOUND";
    error.serviceKey = serviceKey;
    throw error;
  }

  const monthlySessions = Math.max(1, asInt(plan.credits));
  const payMethod =
    clean(plan.payMethod || subscription.payMethod || "CASH").toUpperCase() ===
    "MP"
      ? "MP"
      : "CASH";

  const regularPrice = asMoney(plan.price);
  const currentCoveragePrice =
    plan.coveragePrice === null || plan.coveragePrice === undefined
      ? null
      : asMoney(plan.coveragePrice);

  // Si la suscripción usa cobertura, se toma también el valor ACTUAL de
  // cobertura publicado. Nunca se conserva un importe viejo.
  const basePrice =
    subscription.coverageApplied && currentCoveragePrice !== null
      ? currentCoveragePrice
      : regularPrice;

  return {
    pricingPlan: plan._id,
    label: clean(
      plan.label || plan.title || \`\${monthlySessions} sesiones\`
    ),
    monthlySessions,
    basePrice,
    regularPrice,
    coveragePrice: currentCoveragePrice,
    coverageApplied: !!subscription.coverageApplied,
    coverageReason: clean(subscription.coverageReason),
    payMethod,
    fixedScheduleIds: Array.isArray(subscription.fixedScheduleIds)
      ? subscription.fixedScheduleIds
      : [],
    addOns: Array.isArray(subscription.addOns)
      ? subscription.addOns
      : [],
  };
}`
      ),
      rep(
        "credit lot serviceName dinámico",
        `  user.creditLots.push({
    serviceKey: subscription.serviceKey,
    serviceName: SERVICE_NAME[subscription.serviceKey] || subscription.serviceKey,`,
        `  user.creditLots.push({
    serviceKey: subscription.serviceKey,
    serviceName: serviceNameForKey(subscription.serviceKey),`
      ),
      rep(
        "history serviceName dinámico",
        `    serviceName: SERVICE_NAME[subscription.serviceKey] || subscription.serviceKey,
    service: SERVICE_NAME[subscription.serviceKey] || subscription.serviceKey,`,
        `    serviceName: serviceNameForKey(subscription.serviceKey),
    service: serviceNameForKey(subscription.serviceKey),`
      ),
      rep(
        "mail serviceName dinámico",
        `      serviceName: SERVICE_NAME[claimedCycle.serviceKey] || claimedCycle.serviceKey,`,
        `      serviceName: serviceNameForKey(claimedCycle.serviceKey),`
      ),
      rep(
        "ensure lifecycle catálogo",
        `export async function ensureMonthlyCycleForSubscription({ subscriptionId, periodKey, now = new Date() } = {}) {
  const session = await mongoose.startSession();`,
        `export async function ensureMonthlyCycleForSubscription({ subscriptionId, periodKey, now = new Date() } = {}) {
  await ensureServiceCatalogLoaded();
  const session = await mongoose.startSession();`
      ),
      rep(
        "subscription snapshot actualiza precio guardado",
        `      subscription.status = "active";
      subscription.currentPeriodKey = periodKey;`,
        `      // La suscripción refleja el catálogo vigente para que Admin también
      // vea el precio actual. El ciclo conserva su snapshot histórico.
      subscription.pricingPlan = snapshot.pricingPlan;
      subscription.monthlySessions = snapshot.monthlySessions;
      subscription.price = snapshot.basePrice;
      subscription.regularPrice = snapshot.regularPrice;
      subscription.coveragePrice = snapshot.coveragePrice;
      subscription.payMethod = snapshot.payMethod;
      subscription.serviceName = serviceNameForKey(subscription.serviceKey);

      subscription.status = "active";
      subscription.currentPeriodKey = periodKey;`
      ),
      rep(
        "preview renovación precio vigente",
        `export async function createRenewalPreviewNotices({ targetPeriodKey, now = new Date(), force = false } = {}) {
  const previewDate = renewalPreviewDate(targetPeriodKey);
  if (!force && !isSameArgentinaYmd(now, previewDate)) {
    return { ok: true, skipped: true, reason: "NOT_PREVIEW_DATE", targetPeriodKey };
  }

  const subscriptions = await ServiceSubscription.find({
    autoRenew: true,
    status: { $in: RENEWABLE_STATUSES },
    serviceKey: { $in: [...OPERATIONAL_SUBSCRIPTION_SERVICE_KEYS] },
  }).lean();

  let createdOrUpdated = 0;
  for (const subscription of subscriptions) {
    const pending = subscription.pendingChange;
    const pendingForTarget = pending && clean(pending.effectivePeriodKey) === targetPeriodKey;
    const sessions = pendingForTarget && pending.monthlySessions
      ? pending.monthlySessions
      : subscription.monthlySessions;
    const price = pendingForTarget && pending.price !== null && pending.price !== undefined
      ? pending.price
      : subscription.price;

    await upsertLifecycleNotice({
      userId: subscription.user,
      subscriptionId: subscription._id,
      serviceKey: subscription.serviceKey,
      periodKey: targetPeriodKey,
      type: "renewal_preview",
      title: \`Próxima renovación \${subscription.serviceKey}\`,
      message: \`Tu próximo plan incluye \${sessions} sesiones. Podés modificarlo antes de la renovación.\`,
      action: "change_plan",
      actionRequired: false,
      metadata: {
        monthlySessions: sessions,
        amount: price,
        payMethod: pendingForTarget && pending.payMethod
          ? pending.payMethod
          : subscription.payMethod,
        pendingChangeType: pendingForTarget ? pending.type : "",
      },
    });
    createdOrUpdated += 1;
  }

  return { ok: true, targetPeriodKey, subscriptions: subscriptions.length, createdOrUpdated };
}`,
        `export async function createRenewalPreviewNotices({ targetPeriodKey, now = new Date(), force = false } = {}) {
  await ensureServiceCatalogLoaded();

  const previewDate = renewalPreviewDate(targetPeriodKey);
  if (!force && !isSameArgentinaYmd(now, previewDate)) {
    return { ok: true, skipped: true, reason: "NOT_PREVIEW_DATE", targetPeriodKey };
  }

  const subscriptions = await ServiceSubscription.find({
    autoRenew: true,
    status: { $in: RENEWABLE_STATUSES },
  }).lean();

  let createdOrUpdated = 0;
  let skippedServices = 0;
  let pricingErrors = 0;

  for (const subscription of subscriptions) {
    if (!isOperationalSubscriptionServiceKey(subscription.serviceKey)) {
      skippedServices += 1;
      continue;
    }

    const pending = subscription.pendingChange;
    const pendingForTarget =
      pending &&
      clean(pending.effectivePeriodKey) === targetPeriodKey &&
      clean(pending.type || "change") === "change";

    const candidate = {
      ...subscription,
      pricingPlan:
        pendingForTarget && pending.pricingPlan
          ? pending.pricingPlan
          : subscription.pricingPlan,
      monthlySessions:
        pendingForTarget && pending.monthlySessions
          ? pending.monthlySessions
          : subscription.monthlySessions,
      payMethod:
        pendingForTarget && pending.payMethod
          ? pending.payMethod
          : subscription.payMethod,
    };

    let snapshot = null;
    try {
      snapshot = await resolvePlanSnapshot(candidate);
    } catch (error) {
      pricingErrors += 1;
      console.error(
        "[SUBSCRIPTION PREVIEW][PRICING]",
        String(subscription._id),
        error?.message || error
      );
      continue;
    }

    await upsertLifecycleNotice({
      userId: subscription.user,
      subscriptionId: subscription._id,
      serviceKey: subscription.serviceKey,
      periodKey: targetPeriodKey,
      type: "renewal_preview",
      title: \`Próxima renovación \${subscription.serviceKey}\`,
      message: \`Tu próximo plan incluye \${snapshot.monthlySessions} sesiones. Podés modificarlo antes de la renovación.\`,
      action: "change_plan",
      actionRequired: false,
      metadata: {
        monthlySessions: snapshot.monthlySessions,
        amount: snapshot.basePrice,
        regularPrice: snapshot.regularPrice,
        coveragePrice: snapshot.coveragePrice,
        coverageApplied: snapshot.coverageApplied,
        payMethod: snapshot.payMethod,
        pricingPlanId: String(snapshot.pricingPlan || ""),
        pendingChangeType: pendingForTarget ? pending.type : "",
        pricingSource: "current_admin_precios",
      },
    });
    createdOrUpdated += 1;
  }

  return {
    ok: pricingErrors === 0,
    targetPeriodKey,
    subscriptions: subscriptions.length,
    createdOrUpdated,
    skippedServices,
    pricingErrors,
  };
}`
      ),
    ],
  },

  {
    file: "src/services/subscriptions/subscriptionExtraSessions.js",
    marker: "// STEP3B2_DYNAMIC_EXTRA_SESSIONS",
    replacements: [
      rep(
        "runtime catálogo import",
        `import { projectActiveFixedSchedulesForMonth } from "./subscriptionScheduleProjection.js";`,
        `import { projectActiveFixedSchedulesForMonth } from "./subscriptionScheduleProjection.js";
import {
  ensureServiceCatalogLoaded,
  isServiceEnabledFor,
  normalizeCatalogServiceKey,
} from "../serviceCatalogRuntime.js";

// STEP3B2_DYNAMIC_EXTRA_SESSIONS`
      ),
      rep(
        "operational dinámico",
        `const CLOSED_ORDER_STATUSES = new Set(["cancelled", "canceled", "expired"]);
const OPERATIONAL_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);`,
        `const CLOSED_ORDER_STATUSES = new Set(["cancelled", "canceled", "expired"]);`
      ),
      rep(
        "isOperational dinámico",
        `function isOperationalServiceKey(value) {
  return OPERATIONAL_SERVICE_KEYS.has(clean(value).toUpperCase());
}`,
        `function isOperationalServiceKey(value) {
  const key = normalizeCatalogServiceKey(value);
  return isServiceEnabledFor(key, "recurringPlanEnabled");
}`
      ),
      rep(
        "carga catálogo cálculo extras",
        `async function calculateExtraSessionStateForUserService({
  userId,
  serviceKey,
  now = new Date(),
} = {}) {
  const normalizedServiceKey = normalizeServiceKey(serviceKey);`,
        `async function calculateExtraSessionStateForUserService({
  userId,
  serviceKey,
  now = new Date(),
} = {}) {
  await ensureServiceCatalogLoaded();
  const normalizedServiceKey = normalizeServiceKey(serviceKey);`
      ),
      rep(
        "carga catálogo serialize extras",
        `export async function serializeExtraSessionNoticeForUser(noticeInput) {
  const notice =`,
        `export async function serializeExtraSessionNoticeForUser(noticeInput) {
  await ensureServiceCatalogLoaded();
  const notice =`
      ),
      rep(
        "carga catálogo checkout extras",
        `export async function resolveExtraSessionCheckoutItem({
  noticeId,
  userId,
  payMethod,
} = {}) {
  if (!mongoose.Types.ObjectId.isValid(clean(noticeId))) {`,
        `export async function resolveExtraSessionCheckoutItem({
  noticeId,
  userId,
  payMethod,
} = {}) {
  await ensureServiceCatalogLoaded();

  if (!mongoose.Types.ObjectId.isValid(clean(noticeId))) {`
      ),
    ],
  },

  {
    file: "src/services/subscriptions/subscriptionPlanPurchase.js",
    marker: "// STEP3B2_DYNAMIC_PLAN_PURCHASE",
    replacements: [
      rep(
        "runtime catálogo import",
        `} from "./subscriptionExtraSessions.js";`,
        `} from "./subscriptionExtraSessions.js";
import {
  ensureServiceCatalogLoaded,
  isServiceEnabledFor,
  normalizeCatalogServiceKey,
  serviceNameForKey,
} from "../serviceCatalogRuntime.js";

// STEP3B2_DYNAMIC_PLAN_PURCHASE`
      ),
      rep(
        "sets servicios fuera",
        `const RECURRING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN", "NUT"]);
const OPERATIONAL_RECURRING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);
const ACTIVE_SUBSCRIPTION_STATUSES`,
        `const ACTIVE_SUBSCRIPTION_STATUSES`
      ),
      rep(
        "normalize service dinámico",
        `function normalizeServiceKey(value) {
  const raw = clean(value).toUpperCase();
  if (raw === "AR") return "RA";
  if (raw === "KINEDEPO" || raw === "KINE-DEPO") return "KD";
  return RECURRING_SERVICE_KEYS.has(raw) ? raw : "";
}

function isOperationalRecurringServiceKey(value) {
  const key = normalizeServiceKey(value);
  return Boolean(key && OPERATIONAL_RECURRING_SERVICE_KEYS.has(key));
}`,
        `function normalizeServiceKey(value) {
  return normalizeCatalogServiceKey(value);
}

function isOperationalRecurringServiceKey(value) {
  const key = normalizeServiceKey(value);
  return Boolean(
    key && isServiceEnabledFor(key, "recurringPlanEnabled")
  );
}`
      ),
      rep(
        "load catálogo activación",
        `export async function activateSubscriptionsFromPaidOrder({ order, session = null, now = new Date() } = {}) {
  if (!order?._id || !order?.user)`,
        `export async function activateSubscriptionsFromPaidOrder({ order, session = null, now = new Date() } = {}) {
  await ensureServiceCatalogLoaded();

  if (!order?._id || !order?.user)`
      ),
      rep(
        "nombre suscripción dinámico nueva",
        `        serviceName: item.serviceKey,`,
        `        serviceName: serviceNameForKey(item.serviceKey),`
      ),
      rep(
        "nombre suscripción dinámico existente",
        `    subscription.pricingPlan = plan._id;
    subscription.status = "active";`,
        `    subscription.pricingPlan = plan._id;
    subscription.serviceName = serviceNameForKey(item.serviceKey);
    subscription.status = "active";`
      ),
      rep(
        "load catálogo reconcile",
        `export async function reconcilePendingFixedAppointmentsForUserService({
  userId,
  serviceKey,
  now = new Date(),
} = {}) {
  const sk = normalizeServiceKey(serviceKey);`,
        `export async function reconcilePendingFixedAppointmentsForUserService({
  userId,
  serviceKey,
  now = new Date(),
} = {}) {
  await ensureServiceCatalogLoaded();
  const sk = normalizeServiceKey(serviceKey);`
      ),
    ],
  },

  {
    file: "src/routes/adminSubscriptions.js",
    marker: "// STEP3B2_DYNAMIC_ADMIN_SUBSCRIPTIONS",
    replacements: [
      rep(
        "runtime catálogo import",
        `import { projectActiveFixedSchedulesForMonth } from "../services/subscriptions/subscriptionScheduleProjection.js";`,
        `import { projectActiveFixedSchedulesForMonth } from "../services/subscriptions/subscriptionScheduleProjection.js";
import {
  ensureServiceCatalogLoaded,
  isServiceEnabledFor,
  normalizeCatalogServiceKey,
} from "../services/serviceCatalogRuntime.js";

// STEP3B2_DYNAMIC_ADMIN_SUBSCRIPTIONS`
      ),
      rep(
        "middleware catálogo",
        `const router = express.Router();
router.use(protect, adminOnly);

const RECURRING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN", "NUT"]);`,
        `const router = express.Router();
router.use(protect, adminOnly);
router.use(async (req, res, next) => {
  await ensureServiceCatalogLoaded();
  next();
});`
      ),
      rep(
        "assert service dinámico",
        `function assertServiceKey(value) {
  const serviceKey = normalizeServiceKey(value);
  if (!serviceKey || !RECURRING_SERVICE_KEYS.has(serviceKey)) {
    const error = new Error(
      "serviceKey inválido. Valores permitidos: EP, RA, RF, KD, SYN, NUT."
    );
    error.status = 400;
    throw error;
  }
  return serviceKey;
}`,
        `function assertServiceKey(value) {
  const serviceKey =
    normalizeCatalogServiceKey(value) ||
    normalizeServiceKey(value);

  if (
    !serviceKey ||
    !isServiceEnabledFor(serviceKey, "recurringPlanEnabled")
  ) {
    const error = new Error(
      "serviceKey inválido o servicio sin plan mensual habilitado."
    );
    error.status = 400;
    throw error;
  }

  return serviceKey;
}`
      ),
    ],
  },

  {
    file: "src/routes/adminPlans.js",
    marker: "// STEP3B2_DYNAMIC_ADMIN_PLANS",
    replacements: [
      rep(
        "runtime catálogo import",
        `} from "../services/subscriptions/subscriptionLifecycle.js";`,
        `} from "../services/subscriptions/subscriptionLifecycle.js";
import {
  ensureServiceCatalogLoaded,
  isServiceEnabledFor,
  normalizeCatalogServiceKey,
} from "../services/serviceCatalogRuntime.js";

// STEP3B2_DYNAMIC_ADMIN_PLANS`
      ),
      rep(
        "middleware catálogo",
        `const router = express.Router();
router.use(protect, adminOnly);

const SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN", "NUT"]);`,
        `const router = express.Router();
router.use(protect, adminOnly);
router.use(async (req, res, next) => {
  await ensureServiceCatalogLoaded();
  next();
});`
      ),
      rep(
        "assert service dinámico",
        `function assertServiceKey(value, optional = true) {
  const key = upper(value);
  if (!key && optional) return "";
  if (!SERVICE_KEYS.has(key)) {
    const error = new Error("Servicio inválido.");
    error.status = 400;
    throw error;
  }
  return key;
}`,
        `function assertServiceKey(value, optional = true) {
  const raw = clean(value);
  if (!raw && optional) return "";

  const key = normalizeCatalogServiceKey(raw);
  if (
    !key ||
    !isServiceEnabledFor(key, "recurringPlanEnabled")
  ) {
    const error = new Error(
      "Servicio inválido o sin plan mensual habilitado."
    );
    error.status = 400;
    throw error;
  }

  return key;
}`
      ),
    ],
  },
];

function inspect(patch) {
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
    if (count !== 1) {
      fail(
        `${patch.file}: "${item.label}" encontró ${count} coincidencias; esperaba 1. ` +
        `No se escribió ningún archivo.`
      );
    }
    current = current.replace(item.from, item.to);
    details.push({ label: item.label, status: "READY" });
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
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function atomicWrite(rel, content) {
  const target = abs(rel);
  const tmp = `${target}.step3b2.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, target);
}

try {
  const inspected = patches.map(inspect);

  const result = {
    ok: true,
    mode: APPLY ? "APPLY" : "DRY_RUN",
    root: ROOT,
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

    if (changing.length) {
      const backupDir = path.join(
        ROOT,
        "backups",
        `services-step3b2-${stamp()}`
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
