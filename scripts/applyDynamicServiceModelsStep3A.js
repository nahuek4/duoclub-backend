// backend/scripts/applyDynamicServiceModelsStep3A.js
//
// PASO 3A - DUO servicios dinámicos
//
// Uso:
//   node scripts/applyDynamicServiceModelsStep3A.js --dry-run
//   node scripts/applyDynamicServiceModelsStep3A.js --apply
//
// Este script:
// - NO toca MongoDB.
// - NO modifica rutas públicas.
// - NO habilita servicios nuevos en Comprar/Reservar.
// - Verifica cada patrón antes de escribir.
// - Hace backup de todos los modelos modificados antes de aplicar.
// - Es idempotente: si ya fue aplicado, lo informa y no duplica cambios.

import fs from "fs";
import path from "path";
import crypto from "crypto";

const ROOT = process.cwd();
const APPLY = process.argv.includes("--apply");
const DRY_RUN = process.argv.includes("--dry-run") || !APPLY;

function fail(message) {
  const error = new Error(message);
  error.code = "STEP3A_PATCH_FAILED";
  throw error;
}

function filePath(rel) {
  return path.join(ROOT, rel);
}

function read(rel) {
  const p = filePath(rel);
  if (!fs.existsSync(p)) fail(`No existe ${rel}`);
  return fs.readFileSync(p, "utf8");
}

function sha(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function replacement(label, from, to) {
  return { label, from, to };
}

const patches = [
  {
    file: "src/models/Appointment.js",
    replacements: [
      replacement(
        "regex dinámica",
        `const ALLOWED_SERVICE_KEYS = new Set(Object.keys(SERVICE_KEY_TO_NAME));`,
        `const ALLOWED_SERVICE_KEYS = new Set(Object.keys(SERVICE_KEY_TO_NAME));
const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;`
      ),
      replacement(
        "normalización de claves dinámicas",
        `  if (up === "AR") return "RA";
  if (ALLOWED_SERVICE_KEYS.has(up)) return up;

  const s = stripAccents(raw).toLowerCase().trim();`,
        `  if (up === "AR") return "RA";
  if (ALLOWED_SERVICE_KEYS.has(up)) return up;
  if (SERVICE_KEY_RE.test(up)) return up;

  const s = stripAccents(raw).toLowerCase().trim();`
      ),
      replacement(
        "nombre fallback dinámico",
        `function serviceKeyToName(serviceKey) {
  return SERVICE_KEY_TO_NAME[normalizeServiceKey(serviceKey)] || "";
}`,
        `function serviceKeyToName(serviceKey) {
  const key = normalizeServiceKey(serviceKey);
  return SERVICE_KEY_TO_NAME[key] || key || "";
}`
      ),
      replacement(
        "schema serviceKey dinámico",
        `      enum: [...ALLOWED_SERVICE_KEYS],
      index: true,`,
        `      match: SERVICE_KEY_RE,
      index: true,`
      ),
      replacement(
        "mensaje validación",
        `      "serviceKey inválido. Debe ser uno de: PE, EP, RA, RF, KD, NUT."`,
        `      "serviceKey inválido. Usá una clave válida del catálogo de servicios."`
      ),
    ],
  },

  {
    file: "src/models/FixedSchedule.js",
    replacements: [
      replacement(
        "regex dinámica",
        `const ALLOWED_SERVICE_KEY_SET = new Set(ALLOWED_SERVICE_KEYS);`,
        `const ALLOWED_SERVICE_KEY_SET = new Set(ALLOWED_SERVICE_KEYS);
const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;`
      ),
      replacement(
        "normalización dinámica",
        `  if (upper === "AR") return "RA";
  if (ALLOWED_SERVICE_KEY_SET.has(upper)) return upper;

  const text = stripAccents(raw).toLowerCase().trim();`,
        `  if (upper === "AR") return "RA";
  if (ALLOWED_SERVICE_KEY_SET.has(upper)) return upper;
  if (SERVICE_KEY_RE.test(upper)) return upper;

  const text = stripAccents(raw).toLowerCase().trim();`
      ),
      replacement(
        "nombre fallback",
        `function getServiceNameFromKey(serviceKey) {
  const key = normalizeServiceKey(serviceKey);
  return SERVICE_KEY_TO_NAME[key] || "";
}`,
        `function getServiceNameFromKey(serviceKey) {
  const key = normalizeServiceKey(serviceKey);
  return SERVICE_KEY_TO_NAME[key] || key || "";
}`
      ),
      replacement(
        "domingo habilitado en modelo",
        `    // 1 = lunes, 2 = martes ... 5 = viernes, 6 = sábado`,
        `    // 1 = lunes, 2 = martes ... 7 = domingo`
      ),
      replacement(
        "weekday hasta domingo",
        `      max: 6,`,
        `      max: 7,`
      ),
      replacement(
        "schema serviceKey dinámico",
        `      enum: ALLOWED_SERVICE_KEYS,
      index: true,`,
        `      match: SERVICE_KEY_RE,
      index: true,`
      ),
      replacement(
        "mensaje validación",
        `      "serviceKey inválido. Valores permitidos: PE, EP, RA, RF, KD, SYN, NUT."`,
        `      "serviceKey inválido. Usá una clave válida del catálogo de servicios."`
      ),
    ],
  },

  {
    file: "src/models/User.js",
    replacements: [
      replacement(
        "regex dinámica",
        `const ALLOWED_SERVICE_KEYS_SET = new Set(ALLOWED_SERVICE_KEYS);`,
        `const ALLOWED_SERVICE_KEYS_SET = new Set(ALLOWED_SERVICE_KEYS);
const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;`
      ),
      replacement(
        "normalización dinámica",
        `  if (up === "AR") return "RA";
  if (up === "KINEDEPO" || up === "KINE-DEPO") return "KD";
  if (ALLOWED_SERVICE_KEYS_SET.has(up)) return up;

  const s = stripAccents(raw).toLowerCase().trim();`,
        `  if (up === "AR") return "RA";
  if (up === "KINEDEPO" || up === "KINE-DEPO") return "KD";
  if (ALLOWED_SERVICE_KEYS_SET.has(up)) return up;
  if (SERVICE_KEY_RE.test(up)) return up;

  const s = stripAccents(raw).toLowerCase().trim();`
      ),
      replacement(
        "history validator dinámico",
        `          return !v || ALLOWED_SERVICE_KEYS_SET.has(String(v || "").toUpperCase().trim());`,
        `          return !v || SERVICE_KEY_RE.test(String(v || "").toUpperCase().trim());`
      ),
      replacement(
        "credit lot dinámico",
        `      enum: ALLOWED_SERVICE_KEYS,
    },
    serviceName:`,
        `      match: SERVICE_KEY_RE,
    },
    serviceName:`
      ),
      replacement(
        "history subdocument display dinámico",
        `    const displayName = SERVICE_KEY_TO_NAME[normalized] || "";

    if (!String(this.serviceName || "").trim())`,
        `    const displayName = SERVICE_KEY_TO_NAME[normalized] || normalized;

    if (!String(this.serviceName || "").trim())`
      ),
      replacement(
        "history root display dinámico",
        `      const displayName = SERVICE_KEY_TO_NAME[normalized] || "";
      if (!item.serviceKey)`,
        `      const displayName = SERVICE_KEY_TO_NAME[normalized] || normalized;
      if (!item.serviceKey)`
      ),
    ],
  },

  {
    file: "src/models/WaitlistEntry.js",
    replacements: [
      replacement(
        "regex dinámica",
        `const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RA", "RF", "KD", "SYN", "NUT"]);`,
        `const ALLOWED_SERVICE_KEYS = new Set(["PE", "EP", "RA", "RF", "KD", "SYN", "NUT"]);
const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;`
      ),
      replacement(
        "normalización dinámica",
        `  if (upper === "AR") return "RA";
  if (ALLOWED_SERVICE_KEYS.has(upper)) return upper;

  const normalized = stripAccents(raw).toLowerCase().trim();`,
        `  if (upper === "AR") return "RA";
  if (ALLOWED_SERVICE_KEYS.has(upper)) return upper;
  if (SERVICE_KEY_RE.test(upper)) return upper;

  const normalized = stripAccents(raw).toLowerCase().trim();`
      ),
      replacement(
        "nombre fallback",
        `function getServiceNameFromKey(serviceKey) {
  return SERVICE_KEY_TO_NAME[String(serviceKey || "").toUpperCase().trim()] || "";
}`,
        `function getServiceNameFromKey(serviceKey) {
  const key = String(serviceKey || "").toUpperCase().trim();
  return SERVICE_KEY_TO_NAME[key] || (SERVICE_KEY_RE.test(key) ? key : "");
}`
      ),
      replacement(
        "schema serviceKey dinámico",
        `      enum: [...ALLOWED_SERVICE_KEYS],
      index: true,`,
        `      match: SERVICE_KEY_RE,
      index: true,`
      ),
    ],
  },

  {
    file: "src/models/ServiceSubscription.js",
    replacements: [
      replacement(
        "regex dinámica",
        `const RECURRING_SERVICE_KEY_SET = new Set(RECURRING_SERVICE_KEYS);`,
        `const RECURRING_SERVICE_KEY_SET = new Set(RECURRING_SERVICE_KEYS);
const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;`
      ),
      replacement(
        "normalización dinámica",
        `  if (upper === "SYNERGY" || upper === "SINERGIA") return "SYN";
  if (RECURRING_SERVICE_KEY_SET.has(upper)) return upper;

  const text = stripAccents(raw).toLowerCase().trim();`,
        `  if (upper === "SYNERGY" || upper === "SINERGIA") return "SYN";
  if (RECURRING_SERVICE_KEY_SET.has(upper)) return upper;
  if (SERVICE_KEY_RE.test(upper)) return upper;

  const text = stripAccents(raw).toLowerCase().trim();`
      ),
      replacement(
        "schema serviceKey dinámico",
        `      enum: RECURRING_SERVICE_KEYS,
      index: true,
      set: normalizeServiceKey,`,
        `      match: SERVICE_KEY_RE,
      index: true,
      set: normalizeServiceKey,`
      ),
      replacement(
        "mensaje validación",
        `      "Servicio recurrente inválido. Valores permitidos: EP, RA, RF, KD, SYN, NUT."`,
        `      "Servicio recurrente inválido. Usá una clave válida del catálogo."`
      ),
    ],
  },

  {
    file: "src/models/CapacityRule.js",
    replacements: [
      replacement(
        "regex dinámica",
        `import mongoose from "mongoose";

const capacityRuleSchema`,
        `import mongoose from "mongoose";

const SERVICE_KEY_RE = /^$|^[A-Z][A-Z0-9_]{1,23}$/;

const capacityRuleSchema`
      ),
      replacement(
        "schema serviceKey dinámico",
        `      enum: ["", "EP", "RA", "RF", "SYN"],
      default: "",`,
        `      match: SERVICE_KEY_RE,
      default: "",`
      ),
    ],
  },

  {
    file: "src/models/ScheduleBlock.js",
    replacements: [
      replacement(
        "regex dinámica",
        `const SERVICE_KEY_SET = new Set(SERVICE_KEYS);`,
        `const SERVICE_KEY_SET = new Set(SERVICE_KEYS);
const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;`
      ),
      replacement(
        "normalización dinámica",
        `  if (up === "SINERGIA") return "SYN";
  return SERVICE_KEY_SET.has(up) ? up : "";`,
        `  if (up === "SINERGIA") return "SYN";
  if (SERVICE_KEY_SET.has(up)) return up;
  return SERVICE_KEY_RE.test(up) ? up : "";`
      ),
      replacement(
        "validator dinámico",
        `            value.every((x) => SERVICE_KEY_SET.has(String(x || "").toUpperCase()))`,
        `            value.every((x) => SERVICE_KEY_RE.test(String(x || "").toUpperCase().trim()))`
      ),
    ],
  },

  {
    file: "src/models/SubscriptionBillingCycle.js",
    replacements: [
      replacement(
        "regex dinámica",
        `const SERVICE_KEYS = ["EP", "RA", "RF", "KD", "SYN", "NUT"];`,
        `const SERVICE_KEYS = ["EP", "RA", "RF", "KD", "SYN", "NUT"];
const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;`
      ),
      replacement(
        "schema serviceKey dinámico",
        `      enum: SERVICE_KEYS,
      uppercase: true,`,
        `      match: SERVICE_KEY_RE,
      uppercase: true,`
      ),
    ],
  },

  {
    file: "src/models/SubscriptionExtraSessionNotice.js",
    replacements: [
      replacement(
        "regex dinámica",
        `const SERVICE_KEYS = ["EP", "RA", "RF", "KD", "SYN", "NUT"];`,
        `const SERVICE_KEYS = ["EP", "RA", "RF", "KD", "SYN", "NUT"];
const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;`
      ),
      replacement(
        "schema serviceKey dinámico",
        `      enum: SERVICE_KEYS,
      required: true,`,
        `      match: SERVICE_KEY_RE,
      required: true,`
      ),
    ],
  },

  {
    file: "src/models/SubscriptionLifecycleNotice.js",
    replacements: [
      replacement(
        "regex dinámica",
        `const TYPES = [
  "renewal_preview",`,
        `const SERVICE_KEY_RE = /^[A-Z][A-Z0-9_]{1,23}$/;

const TYPES = [
  "renewal_preview",`
      ),
      replacement(
        "schema serviceKey dinámico",
        `      enum: ["EP", "RA", "RF", "KD", "SYN", "NUT"],
      index: true,`,
        `      match: SERVICE_KEY_RE,
      index: true,`
      ),
    ],
  },
];

function inspectPatch(patch) {
  const original = read(patch.file);
  let current = original;
  const details = [];

  for (const rep of patch.replacements) {
    const hasFrom = current.includes(rep.from);
    const hasTo = current.includes(rep.to);

    if (hasFrom) {
      const occurrences = current.split(rep.from).length - 1;
      if (occurrences !== 1) {
        fail(`${patch.file}: "${rep.label}" aparece ${occurrences} veces; esperaba exactamente 1.`);
      }
      current = current.replace(rep.from, rep.to);
      details.push({ label: rep.label, status: "READY" });
      continue;
    }

    if (hasTo) {
      details.push({ label: rep.label, status: "ALREADY_APPLIED" });
      continue;
    }

    fail(
      `${patch.file}: no encontré el patrón esperado para "${rep.label}". ` +
      `No se escribió ningún archivo. Verificá que estés usando las versiones que me pasaste.`
    );
  }

  return {
    file: patch.file,
    beforeHash: sha(original),
    afterHash: sha(current),
    changed: current !== original,
    details,
    original,
    patched: current,
  };
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function atomicWrite(rel, content) {
  const target = filePath(rel);
  const tmp = `${target}.step3a.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, target);
}

try {
  const inspected = patches.map(inspectPatch);

  const summary = {
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
  };

  if (APPLY) {
    const changing = inspected.filter((row) => row.changed);

    if (changing.length) {
      const backupDir = path.join(ROOT, "backups", `services-step3a-${timestamp()}`);
      fs.mkdirSync(backupDir, { recursive: true });

      for (const row of changing) {
        const backupFile = path.join(backupDir, row.file);
        fs.mkdirSync(path.dirname(backupFile), { recursive: true });
        fs.writeFileSync(backupFile, row.original, "utf8");
      }

      // Todas las verificaciones ya pasaron antes de entrar acá.
      for (const row of changing) {
        atomicWrite(row.file, row.patched);
      }

      summary.backupDir = path.relative(ROOT, backupDir);
      summary.filesWritten = changing.length;
    } else {
      summary.backupDir = null;
      summary.filesWritten = 0;
    }
  } else {
    summary.filesWritten = 0;
  }

  console.log(JSON.stringify(summary, null, 2));
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
