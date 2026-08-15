// Normaliza lotes de crédito existentes a la regla DUO:
// todo crédito vence a las 00:00 del día 1 del mes siguiente al período en que fue acreditado.
//
// SEGURIDAD:
// - por defecto es DRY RUN.
// - solo modifica con --apply --confirm=NORMALIZE_CREDIT_EXPIRY
// - no borra lotes, órdenes, turnos ni suscripciones.
// - los lotes ya consumidos (remaining <= 0) no se modifican.
//
// Preview:
//   node scripts/normalizeCreditExpiry.js --out=credit-expiry-preview.json
//
// Aplicar:
//   node scripts/normalizeCreditExpiry.js \
//     --apply \
//     --confirm=NORMALIZE_CREDIT_EXPIRY \
//     --out=credit-expiry-applied.json

import fs from "node:fs";
import dotenv from "dotenv";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import {
  creditExpiryForMonthKey,
  monthKeyFromArgentinaDate,
} from "../src/utils/creditExpiry.js";

dotenv.config();

const CONFIRMATION = "NORMALIZE_CREDIT_EXPIRY";

function argsMap(argv = []) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, ...rest] = raw.slice(2).split("=");
    out[key] = rest.length ? rest.join("=") : true;
  }
  return out;
}

function clean(value) {
  return String(value || "").trim();
}

function asBool(value) {
  if (value === true) return true;
  return ["1", "true", "yes", "si", "sí"].includes(clean(value).toLowerCase());
}

function periodKeyFromSubscriptionCycleSource(source) {
  const raw = clean(source);
  if (!raw.startsWith("subscription_cycle:")) return "";
  const match = /:(\d{4}-\d{2})$/.exec(raw);
  return match?.[1] || "";
}

function resolveLotPeriodKey(lot) {
  const sourcePeriod = periodKeyFromSubscriptionCycleSource(lot?.source);
  if (sourcePeriod) return sourcePeriod;

  if (!lot?.createdAt) return "";
  try {
    return monthKeyFromArgentinaDate(lot.createdAt);
  } catch {
    return "";
  }
}

function recalcCredits(user, now = new Date()) {
  user.credits = (Array.isArray(user.creditLots) ? user.creditLots : []).reduce((sum, lot) => {
    const remaining = Math.max(0, Number(lot?.remaining || 0));
    if (!remaining) return sum;

    const expiresAt = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt <= now) return sum;

    return sum + remaining;
  }, 0);
}

const args = argsMap(process.argv.slice(2));
const apply = asBool(args.apply);
const confirm = clean(args.confirm);
const outFile = clean(args.out);

if (apply && confirm !== CONFIRMATION) {
  console.error(`Para aplicar usá --confirm=${CONFIRMATION}`);
  process.exit(1);
}

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
if (!mongoUri) {
  console.error("No se encontró MONGO_URI/MONGODB_URI/MONGO_URL.");
  process.exit(1);
}

await mongoose.connect(mongoUri);

try {
  const now = new Date();
  const users = await User.find({ "creditLots.0": { $exists: true } });

  const report = {
    mode: apply ? "apply" : "dry_run",
    generatedAt: now.toISOString(),
    usersRead: users.length,
    usersAffected: 0,
    activeLotsRead: 0,
    lotsAlreadyCorrect: 0,
    lotsToChange: 0,
    lotsMissingPeriod: 0,
    lotsWithoutExpiry: 0,
    lotsShortened: 0,
    lotsExtended: 0,
    lotsThatBecomeExpiredNow: 0,
    changedUsers: [],
  };

  for (const user of users) {
    let changed = false;
    const changes = [];

    for (const lot of Array.isArray(user.creditLots) ? user.creditLots : []) {
      const remaining = Math.max(0, Number(lot?.remaining || 0));
      if (remaining <= 0) continue;

      report.activeLotsRead += 1;

      const periodKey = resolveLotPeriodKey(lot);
      if (!periodKey) {
        report.lotsMissingPeriod += 1;
        changes.push({
          lotId: String(lot?._id || ""),
          serviceKey: clean(lot?.serviceKey),
          remaining,
          status: "missing_period",
        });
        continue;
      }

      const target = creditExpiryForMonthKey(periodKey);
      const current = lot?.expiresAt ? new Date(lot.expiresAt) : null;
      const currentValid = current && !Number.isNaN(current.getTime());

      if (!currentValid) report.lotsWithoutExpiry += 1;

      if (currentValid && current.getTime() === target.getTime()) {
        report.lotsAlreadyCorrect += 1;
        continue;
      }

      report.lotsToChange += 1;
      if (currentValid && current > target) report.lotsShortened += 1;
      if (currentValid && current < target) report.lotsExtended += 1;
      if (target <= now && (!currentValid || current > now)) {
        report.lotsThatBecomeExpiredNow += 1;
      }

      changes.push({
        lotId: String(lot?._id || ""),
        serviceKey: clean(lot?.serviceKey),
        source: clean(lot?.source),
        remaining,
        periodKey,
        from: currentValid ? current.toISOString() : null,
        to: target.toISOString(),
        becomesExpiredNow: target <= now && (!currentValid || current > now),
      });

      if (apply) {
        lot.expiresAt = target;
        changed = true;
      }
    }

    if (changes.length) {
      report.usersAffected += 1;
      report.changedUsers.push({
        userId: String(user._id),
        email: clean(user.email),
        name: [clean(user.name), clean(user.lastName)].filter(Boolean).join(" "),
        changes,
      });
    }

    if (apply && changed) {
      user.markModified?.("creditLots");
      recalcCredits(user, now);
      await user.save();
    }
  }

  console.log("\n=== VENCIMIENTO MENSUAL DE CRÉDITOS ===");
  console.log({
    mode: report.mode,
    usersRead: report.usersRead,
    usersAffected: report.usersAffected,
    activeLotsRead: report.activeLotsRead,
    lotsAlreadyCorrect: report.lotsAlreadyCorrect,
    lotsToChange: report.lotsToChange,
    lotsWithoutExpiry: report.lotsWithoutExpiry,
    lotsShortened: report.lotsShortened,
    lotsExtended: report.lotsExtended,
    lotsThatBecomeExpiredNow: report.lotsThatBecomeExpiredNow,
    lotsMissingPeriod: report.lotsMissingPeriod,
  });

  if (report.lotsThatBecomeExpiredNow > 0) {
    console.log(
      "\n⚠️ Hay lotes que hoy siguen visibles con la regla vieja y pasarían a estar vencidos al aplicar la nueva regla. Revisá el reporte antes de usar --apply."
    );
  }

  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`📄 Reporte guardado en ${outFile}`);
  }

  if (!apply) {
    console.log("\nDRY RUN: no se modificó MongoDB.");
  } else {
    console.log("\n✅ Vencimientos existentes normalizados al día 1 del mes siguiente.");
  }
} finally {
  await mongoose.disconnect();
}
