import fs from "fs";
import path from "path";

const root = process.cwd();
const files = {
  orders: path.join(root, "src/routes/orders.js"),
  pricing: path.join(root, "src/routes/pricing.js"),
  extras: path.join(root, "src/services/subscriptions/subscriptionExtraSessions.js"),
};

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

for (const [name, file] of Object.entries(files)) {
  if (!fs.existsSync(file)) fail(`No existe ${name}: ${file}`);
}

function replaceOnce(source, oldText, newText, label) {
  const count = source.split(oldText).length - 1;
  if (count !== 1) fail(`${label}: se esperaban 1 coincidencia y se encontraron ${count}. No se modificó nada.`);
  return source.replace(oldText, newText);
}

function replaceRegexOnce(source, regex, replacement, label) {
  const matches = source.match(regex);
  if (!matches) fail(`${label}: no se encontró el bloque esperado. No se modificó nada.`);
  const first = source.replace(regex, replacement);
  if (first === source) fail(`${label}: el reemplazo no produjo cambios.`);
  return first;
}

function replaceWithin(source, startMarker, oldText, newText, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) fail(`${label}: no se encontró el marcador inicial.`);
  const idx = source.indexOf(oldText, start);
  if (idx < 0) fail(`${label}: no se encontró el texto a reemplazar dentro del bloque.`);
  return source.slice(0, idx) + newText + source.slice(idx + oldText.length);
}

function backup(file, original) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${file}.bak-operational-${stamp}`;
  fs.writeFileSync(target, original, "utf8");
  return target;
}

function patchOrders(original) {
  let s = original;

  if (s.includes('const OPERATIONAL_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);') &&
      s.includes("normalizeOperationalServiceKey") &&
      s.includes("SERVICE_RETIRED_PUBLIC_EVALUATION")) {
    return { content: s, changed: false };
  }

  s = replaceOnce(
    s,
    'const PERFORMANCE_COPAY_KEYS = new Set(["RA", "RF", "KD", "SYN"]);',
    'const PERFORMANCE_COPAY_KEYS = new Set(["RA", "RF", "SYN"]);',
    "orders: copago Performance"
  );

  s = replaceOnce(
    s,
    'const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RA", "RF", "KD", "SYN", "NUT"]);',
    `// Compatibilidad histórica: estos keys se siguen pudiendo leer en órdenes/historiales ya existentes.\nconst LEGACY_SERVICE_KEYS = new Set(["PE", "EP", "RA", "RF", "KD", "SYN", "NUT"]);\n\n// Únicos servicios habilitados para NUEVA operatoria/compra.\nconst OPERATIONAL_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);`,
    "orders: sets de servicios"
  );

  s = replaceOnce(
    s,
    `function normalizeServiceKey(value, { allowEmpty = false } = {}) {\n  const sk = String(value || "").toUpperCase().trim();\n  if (!sk) return allowEmpty ? "" : null;\n  return ALLOWED_SERVICE_KEYS.has(sk) ? sk : null;\n}\n\nfunction assertServiceKey(value, label = "serviceKey") {\n  const sk = normalizeServiceKey(value);\n  if (!sk) throw new Error(\`${'${label}'} inválido.\`);\n  return sk;\n}`,
    `function normalizeServiceKey(value, { allowEmpty = false } = {}) {\n  const sk = String(value || "").toUpperCase().trim();\n  if (!sk) return allowEmpty ? "" : null;\n  return LEGACY_SERVICE_KEYS.has(sk) ? sk : null;\n}\n\nfunction normalizeOperationalServiceKey(value, { allowEmpty = false } = {}) {\n  const sk = String(value || "").toUpperCase().trim();\n  if (!sk) return allowEmpty ? "" : null;\n  return OPERATIONAL_SERVICE_KEYS.has(sk) ? sk : null;\n}\n\nfunction assertServiceKey(value, label = "serviceKey") {\n  const sk = normalizeServiceKey(value);\n  if (!sk) throw new Error(\`${'${label}'} inválido.\`);\n  return sk;\n}\n\nfunction assertOperationalServiceKey(value, label = "serviceKey") {\n  const sk = normalizeOperationalServiceKey(value);\n  if (!sk) {\n    const err = new Error(\`${'${label}'} no está habilitado para nuevas compras.\`);\n    err.status = 410;\n    err.code = "SERVICE_RETIRED";\n    throw err;\n  }\n  return sk;\n}`,
    "orders: normalizadores"
  );

  s = replaceWithin(
    s,
    "async function resolveCreditsItem(",
    "  const sk = normalizeServiceKey(serviceKey);",
    "  const sk = normalizeOperationalServiceKey(serviceKey);",
    "orders: checkout créditos"
  );

  s = replaceWithin(
    s,
    'router.post("/", protect, async (req, res) => {',
    "    const sk = normalizeServiceKey(serviceKey);",
    "    const sk = normalizeOperationalServiceKey(serviceKey);",
    "orders: endpoint legacy de compra"
  );

  s = replaceWithin(
    s,
    'router.post("/admin-payment-link", protect, adminOnly, async (req, res) => {',
    '    const sk = assertServiceKey(req.body?.serviceKey, "serviceKey");',
    '    const sk = assertOperationalServiceKey(req.body?.serviceKey, "serviceKey");',
    "orders: link de pago admin"
  );

  s = replaceWithin(
    s,
    'router.post("/admin-create", protect, adminOnly, async (req, res) => {',
    '    const sk = assertServiceKey(req.body?.serviceKey, "serviceKey");',
    '    const sk = assertOperationalServiceKey(req.body?.serviceKey, "serviceKey");',
    "orders: orden manual admin"
  );

  s = replaceOnce(
    s,
    'router.post("/public-evaluation/pay", async (req, res) => {\n  try {',
    `router.post("/public-evaluation/pay", async (req, res) => {\n  try {\n    // Evaluación PE retirada de la operatoria nueva. Se conserva la ruta para\n    // responder de forma explícita a clientes/versiones antiguas de la app.\n    return res.status(410).json({\n      error: "La evaluación pública ya no está disponible para nuevas compras.",\n      code: "SERVICE_RETIRED_PUBLIC_EVALUATION",\n    });`,
    "orders: evaluación pública retirada"
  );

  return { content: s, changed: s !== original };
}

function patchPricing(original) {
  let s = original;

  if (s.includes('const OPERATIONAL_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);') &&
      !s.includes("ensureKDPricingPlans") &&
      !s.includes("ensurePEEvaluationVariantPlans")) {
    return { content: s, changed: false };
  }

  s = replaceOnce(
    s,
    'const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RF", "RA", "KD", "SYN", "NUT"]);',
    `// Se conserva el parser legacy para poder leer/auditar documentos históricos.\nconst LEGACY_SERVICE_KEYS = new Set(["PE", "EP", "RF", "RA", "KD", "SYN", "NUT"]);\n\n// Únicos servicios publicables/creables desde ahora.\nconst OPERATIONAL_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);`,
    "pricing: sets de servicios"
  );

  s = replaceOnce(
    s,
    `function normalizeServiceKey(value) {\n  const raw = String(value || "").toUpperCase().trim();\n  if (!raw) return "";\n\n  const canonical = SERVICE_KEY_ALIASES[raw] || raw;\n  return ALLOWED_SERVICE_KEYS.has(canonical) ? canonical : "";\n}`,
    `function normalizeServiceKey(value) {\n  const raw = String(value || "").toUpperCase().trim();\n  if (!raw) return "";\n\n  const canonical = SERVICE_KEY_ALIASES[raw] || raw;\n  return LEGACY_SERVICE_KEYS.has(canonical) ? canonical : "";\n}\n\nfunction normalizeOperationalServiceKey(value) {\n  const canonical = normalizeServiceKey(value);\n  return OPERATIONAL_SERVICE_KEYS.has(canonical) ? canonical : "";\n}`,
    "pricing: normalizadores"
  );

  s = replaceRegexOnce(
    s,
    /\/\* =========================\n   AUTO-SEED KD PRICING[\s\S]*?\nrouter\.use\(protect\);/,
    "router.use(protect);",
    "pricing: eliminar auto-seed KD/PE"
  );

  s = s.replace(/\n\s*await ensurePEEvaluationVariantPlans\(\);/g, "");
  s = s.replace(/\n\s*await ensureKDPricingPlans\(\);/g, "");

  s = replaceOnce(
    s,
    '    const query = active ? { active: true } : {};',
    '    const query = active\n      ? { active: true, serviceKey: { $in: [...OPERATIONAL_SERVICE_KEYS] } }\n      : {};',
    "pricing: catálogo activo"
  );

  s = replaceOnce(
    s,
    "    const normalizedServiceKey = normalizeServiceKey(serviceKey);",
    "    const normalizedServiceKey = normalizeOperationalServiceKey(serviceKey);",
    "pricing: upsert operativo"
  );

  return { content: s, changed: s !== original };
}

function patchExtras(original) {
  let s = original;

  if (s.includes('const OPERATIONAL_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);') &&
      s.includes("RETIRED_SERVICE_EXTRA_SESSIONS")) {
    return { content: s, changed: false };
  }

  s = replaceOnce(
    s,
    'const CLOSED_ORDER_STATUSES = new Set(["cancelled", "canceled", "expired"]);',
    'const CLOSED_ORDER_STATUSES = new Set(["cancelled", "canceled", "expired"]);\nconst OPERATIONAL_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);',
    "extras: set operativo"
  );

  s = replaceOnce(
    s,
    `function clean(value) {\n  return String(value || "").trim();\n}`,
    `function clean(value) {\n  return String(value || "").trim();\n}\n\nfunction isOperationalServiceKey(value) {\n  return OPERATIONAL_SERVICE_KEYS.has(clean(value).toUpperCase());\n}`,
    "extras: helper operativo"
  );

  s = replaceOnce(
    s,
    `  if (!mongoose.Types.ObjectId.isValid(clean(userId)) || !normalizedServiceKey) {\n    throw createHttpError(\n      "Usuario o servicio inválido para calcular sesiones adicionales.",\n      400,\n      "INVALID_USER_OR_SERVICE"\n    );\n  }`,
    `  if (!mongoose.Types.ObjectId.isValid(clean(userId)) || !normalizedServiceKey) {\n    throw createHttpError(\n      "Usuario o servicio inválido para calcular sesiones adicionales.",\n      400,\n      "INVALID_USER_OR_SERVICE"\n    );\n  }\n\n  if (!isOperationalServiceKey(normalizedServiceKey)) {\n    return {\n      ok: true,\n      skipped: true,\n      reason: "RETIRED_SERVICE",\n      userId: String(userId),\n      serviceKey: normalizedServiceKey,\n    };\n  }`,
    "extras: no generar avisos legacy"
  );

  s = replaceOnce(
    s,
    `  if (!notice) return null;\n  await refreshNoticePendingOrder(notice);`,
    `  if (!notice) return null;\n  if (!isOperationalServiceKey(notice.serviceKey)) return null;\n  await refreshNoticePendingOrder(notice);`,
    "extras: ocultar avisos legacy"
  );

  s = replaceOnce(
    s,
    `  if (!notice) {\n    throw createHttpError("El aviso de sesiones adicionales no existe.", 404, "NOTICE_NOT_FOUND");\n  }\n\n  await refreshNoticePendingOrder(notice);`,
    `  if (!notice) {\n    throw createHttpError("El aviso de sesiones adicionales no existe.", 404, "NOTICE_NOT_FOUND");\n  }\n\n  if (!isOperationalServiceKey(notice.serviceKey)) {\n    throw createHttpError(\n      "Este servicio ya no admite nuevas compras de sesiones adicionales.",\n      410,\n      "RETIRED_SERVICE_EXTRA_SESSIONS"\n    );\n  }\n\n  await refreshNoticePendingOrder(notice);`,
    "extras: bloquear checkout legacy"
  );

  return { content: s, changed: s !== original };
}

const originals = {
  orders: fs.readFileSync(files.orders, "utf8"),
  pricing: fs.readFileSync(files.pricing, "utf8"),
  extras: fs.readFileSync(files.extras, "utf8"),
};

const results = {
  orders: patchOrders(originals.orders),
  pricing: patchPricing(originals.pricing),
  extras: patchExtras(originals.extras),
};

// No escribimos nada hasta que LOS TRES parches hayan sido validados en memoria.
const backups = [];
for (const key of Object.keys(files)) {
  if (results[key].changed) backups.push(backup(files[key], originals[key]));
}

for (const key of Object.keys(files)) {
  if (results[key].changed) fs.writeFileSync(files[key], results[key].content, "utf8");
}

console.log("✅ Hardening aplicado sin tocar MongoDB.");
console.log("Servicios operativos: EP / RA / RF / SYN");
console.log("Servicios legacy solo lectura/histórico: PE / KD / NUT");
console.log(`Archivos modificados: ${Object.entries(results).filter(([,v]) => v.changed).map(([k]) => k).join(", ") || "ninguno (ya aplicado)"}`);
if (backups.length) {
  console.log("Backups:");
  for (const b of backups) console.log(`- ${b}`);
}
