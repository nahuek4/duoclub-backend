#!/usr/bin/env node
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";

const ROOT = process.cwd();
dotenv.config({ path: path.resolve(ROOT, ".env") });

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const getArg = (name, def = "") => {
  const prefix = `${name}=`;
  const found = args.find((x) => String(x).startsWith(prefix));
  return found ? found.slice(prefix.length) : def;
};

const APPLY = has("--apply") || String(getArg("--dryRun", "true")).toLowerCase() === "false";
const LIMIT = Math.max(1, Math.min(5000, Number(getArg("--limit", "1000")) || 1000));
const USER_ID = String(getArg("--userId", "")).trim();
const SERVICE_FILTER = normalizeServiceKey(getArg("--serviceKey", ""));
const INCLUDE_ADMIN = has("--include-admin") || has("--includeAdmin");

const MONGO_URI =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL ||
  process.env.DB_URI ||
  "";

if (!MONGO_URI) {
  console.error("No encontré MONGO_URI/MONGODB_URI/MONGO_URL/DB_URI en .env");
  process.exit(1);
}

const SERVICE_KEYS = ["EP", "RA", "RF", "KD", "SYN"];

function normalizeServiceKey(value) {
  const raw = String(value || "").trim();
  const up = raw.toUpperCase();
  if (SERVICE_KEYS.includes(up)) return up;

  const s = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("kinefilaxia") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("synergy") || s.includes("sinergia")) return "SYN";
  return "";
}

function oid(value) {
  const s = String(value || "").trim();
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

function idString(value) {
  if (!value) return "";
  if (value?._id) return String(value._id);
  return String(value);
}

function userName(user = {}) {
  return (
    String(user.fullName || "").trim() ||
    [user.name, user.lastName].filter(Boolean).join(" ").trim() ||
    String(user.email || "").trim() ||
    "Usuario"
  );
}

function getActualDebt(user, serviceKey) {
  const n = Number(user?.fixedScheduleDebt?.[serviceKey] || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function isAdminUser(user = {}) {
  const role = String(user.role || "").toLowerCase().trim();
  return ["admin", "staff", "profesor", "teacher", "coach"].includes(role);
}

function apServiceKey(ap = {}) {
  return normalizeServiceKey(ap.serviceKey || ap.service || ap.serviceName || "");
}

function isoFileStamp(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, "-");
}

function appointmentLine(ap) {
  return {
    appointmentId: String(ap._id),
    userId: idString(ap.user),
    date: String(ap.date || "").slice(0, 10),
    time: String(ap.time || "").slice(0, 5),
    serviceKey: apServiceKey(ap),
    service: ap.service || ap.serviceName || "",
    status: ap.status || "",
    creditDebitStatus: ap.creditDebitStatus || "",
    fixedDebtAmount: Number(ap.fixedDebtAmount || 0),
    fixedScheduleId: ap.fixedScheduleId ? String(ap.fixedScheduleId) : "",
  };
}

function printUsage() {
  console.log(`\nUso:\n  node scripts/cleanupFixedDebtMetadata.js              # dry-run seguro\n  node scripts/cleanupFixedDebtMetadata.js --apply      # aplica limpieza\n\nOpciones:\n  --userId=<id>          Limita a un usuario\n  --serviceKey=EP        Limita a EP/RA/RF/KD/SYN\n  --limit=1000           Cantidad máxima de turnos a revisar\n  --include-admin        Incluye usuarios admin/staff/profesor\n\nQué limpia:\n  Turnos fijos NO cancelados que quedaron con creditDebitStatus=debt o fixedDebtAmount>0\n  cuando la deuda real del usuario para ese servicio ya es 0.\n\nNo toca:\n  fixedScheduleDebt\n  créditos\n  turnos cancelados\n  usuarios que todavía tienen deuda real en ese servicio\n`);
}

if (has("--help") || has("-h")) {
  printUsage();
  process.exit(0);
}

await mongoose.connect(MONGO_URI);
const db = mongoose.connection.db;
const now = new Date();

console.log(`Conectado a MongoDB: ${db.databaseName}`);
console.log(APPLY ? "MODO APPLY: se van a modificar turnos." : "MODO DRY-RUN: no se modifica nada.");

const query = {
  fixedScheduleId: { $ne: null },
  status: { $in: ["reserved", "completed"] },
  $or: [
    { creditDebitStatus: "debt" },
    { fixedDebtAmount: { $gt: 0 } },
  ],
};

if (USER_ID) {
  const userObjectId = oid(USER_ID);
  query.$and = query.$and || [];
  query.$and.push({
    $or: [
      ...(userObjectId ? [{ user: userObjectId }] : []),
      { user: USER_ID },
      { userId: USER_ID },
    ],
  });
}

const appointments = await db
  .collection("appointments")
  .find(query)
  .sort({ user: 1, date: 1, time: 1, createdAt: 1 })
  .limit(LIMIT)
  .toArray();

const userIds = [...new Set(appointments.map((ap) => idString(ap.user)).filter(Boolean))];
const userObjectIds = userIds.map(oid).filter(Boolean);

const usersRaw = await db
  .collection("users")
  .find({
    $or: [
      ...(userObjectIds.length ? [{ _id: { $in: userObjectIds } }] : []),
      { _id: { $in: userIds } },
    ],
  })
  .project({ name: 1, lastName: 1, fullName: 1, email: 1, role: 1, fixedScheduleDebt: 1 })
  .toArray();

const usersById = new Map(usersRaw.map((u) => [String(u._id), u]));

const safeCandidates = [];
const blocked = [];
const skipped = [];

for (const ap of appointments) {
  const sk = apServiceKey(ap);
  const uid = idString(ap.user);
  const user = usersById.get(uid);

  if (!sk) {
    skipped.push({ ...appointmentLine(ap), reason: "INVALID_SERVICE" });
    continue;
  }

  if (SERVICE_FILTER && sk !== SERVICE_FILTER) {
    skipped.push({ ...appointmentLine(ap), reason: "SERVICE_FILTER" });
    continue;
  }

  if (!user) {
    skipped.push({ ...appointmentLine(ap), reason: "USER_NOT_FOUND" });
    continue;
  }

  if (!INCLUDE_ADMIN && isAdminUser(user)) {
    skipped.push({ ...appointmentLine(ap), reason: "ADMIN_SKIPPED", user: userName(user), email: user.email || "" });
    continue;
  }

  const actualDebt = getActualDebt(user, sk);
  const item = {
    ...appointmentLine(ap),
    user: userName(user),
    email: user.email || "",
    role: user.role || "",
    actualDebt,
  };

  if (actualDebt > 0) {
    blocked.push({ ...item, reason: "USER_STILL_HAS_REAL_DEBT_FOR_SERVICE" });
    continue;
  }

  safeCandidates.push({ ...item, reason: "SAFE_METADATA_GHOST" });
}

const byUserService = new Map();
for (const c of safeCandidates) {
  const key = `${c.userId}__${c.serviceKey}`;
  if (!byUserService.has(key)) {
    byUserService.set(key, {
      userId: c.userId,
      user: c.user,
      email: c.email,
      serviceKey: c.serviceKey,
      count: 0,
      appointmentIds: [],
      dates: [],
    });
  }
  const g = byUserService.get(key);
  g.count += 1;
  g.appointmentIds.push(c.appointmentId);
  g.dates.push(`${c.date} ${c.time}`.trim());
}

const summary = {
  ok: true,
  dryRun: !APPLY,
  scannedAppointments: appointments.length,
  safeCandidates: safeCandidates.length,
  blockedStillRealDebt: blocked.length,
  skipped: skipped.length,
  groups: [...byUserService.values()],
};

console.log("\nResumen:");
console.table([
  {
    scanned: summary.scannedAppointments,
    safe_to_clean: summary.safeCandidates,
    blocked_real_debt: summary.blockedStillRealDebt,
    skipped: summary.skipped,
    groups: summary.groups.length,
  },
]);

if (summary.groups.length) {
  console.log("\nGrupos seguros para limpiar:");
  console.table(summary.groups.map((g) => ({
    userId: g.userId,
    user: g.user,
    email: g.email,
    svc: g.serviceKey,
    count: g.count,
    first: g.dates[0] || "",
    last: g.dates[g.dates.length - 1] || "",
  })));
}

if (blocked.length) {
  console.log("\nBloqueados porque todavía tienen deuda real en ese servicio:");
  console.table(blocked.slice(0, 50).map((x) => ({
    user: x.user,
    email: x.email,
    svc: x.serviceKey,
    actualDebt: x.actualDebt,
    date: x.date,
    time: x.time,
    status: x.status,
    creditDebitStatus: x.creditDebitStatus,
    fixedDebtAmount: x.fixedDebtAmount,
  })));
  if (blocked.length > 50) console.log(`... ${blocked.length - 50} bloqueados más.`);
}

let applied = { appointmentsModified: 0, usersUpdated: 0 };

if (APPLY && safeCandidates.length) {
  const ids = safeCandidates.map((x) => oid(x.appointmentId)).filter(Boolean);

  const upd = await db.collection("appointments").updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        creditDebitStatus: "monthly_reserved",
        fixedDebtAmount: 0,
        fixedDebtMetadataCleanedAt: now,
        fixedDebtMetadataCleanedReason:
          "La deuda real del usuario para este servicio ya estaba en 0. Se limpió metadata vieja de turno fijo marcado como deuda.",
      },
    }
  );

  applied.appointmentsModified = Number(upd.modifiedCount || 0);

  for (const group of byUserService.values()) {
    const userObjectId = oid(group.userId);
    if (!userObjectId) continue;

    const userUpd = await db.collection("users").updateOne(
      { _id: userObjectId },
      {
        $push: {
          history: {
            action: "fixed_schedule_debt_metadata_cleaned",
            title: `Metadata de deuda de turnos fijos limpiada ${group.serviceKey}`,
            message:
              `Se limpiaron ${group.count} turno(s) fijo(s) que seguían marcados como deuda, ` +
              "pero la deuda real del servicio ya estaba en 0. No se modificaron créditos ni deuda real.",
            serviceKey: group.serviceKey,
            service: group.serviceKey,
            serviceName: group.serviceKey,
            qty: group.count,
            appointmentIds: group.appointmentIds,
            createdAt: now,
          },
        },
      }
    );

    applied.usersUpdated += Number(userUpd.modifiedCount || 0);
  }

  console.log("\nAplicado:");
  console.table([applied]);
} else if (APPLY) {
  console.log("\nNo había candidatos seguros para aplicar.");
} else {
  console.log("\nDRY-RUN listo. Para aplicar, ejecutar con --apply.");
}

const reportDir = path.join(ROOT, "debt-audits");
fs.mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `fixed-debt-metadata-cleanup-${isoFileStamp(now)}.json`);
fs.writeFileSync(
  reportPath,
  JSON.stringify({
    ...summary,
    applied,
    safeCandidates,
    blocked,
    skipped,
    generatedAt: now.toISOString(),
  }, null, 2),
  "utf8"
);

console.log(`\nReporte JSON: ${reportPath}`);
console.log("\nRegla: fixedScheduleDebt es la deuda real. Este script solo limpia metadata vieja en appointments cuando esa deuda real ya está en 0.");

await mongoose.disconnect();
