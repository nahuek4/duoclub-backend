// DUO — Tester read-only del fix permanente.
// No conecta a Mongo, no hace requests y no escribe.

import fs from "fs";
import crypto from "crypto";
import { spawnSync } from "child_process";

const MONTHLY = "src/jobs/monthlyRollover.js";
const FIXED = "src/jobs/fixedScheduleBilling.js";

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function read(file) {
  if (!fs.existsSync(file)) throw new Error(`Falta ${file}`);
  return fs.readFileSync(file, "utf8");
}

const monthly = read(MONTHLY);
const fixed = read(FIXED);

const syntax = spawnSync(process.execPath, ["--check", MONTHLY], {
  encoding: "utf8",
});
if (syntax.status !== 0) {
  throw new Error(`monthlyRollover.js no pasa node --check: ${syntax.stderr || syntax.stdout}`);
}

const helperStart = monthly.indexOf("// RENEWAL_FIXED_CREDIT_RESERVATION_V1");
const helperEnd = monthly.indexOf("async function expirePastCreditsForUser", helperStart);
const helper = helperStart >= 0 && helperEnd > helperStart
  ? monthly.slice(helperStart, helperEnd)
  : "";

const checks = {
  markerPresent:
    helperStart >= 0,
  cycleModelUsed:
    monthly.includes('import SubscriptionBillingCycle from "../models/SubscriptionBillingCycle.js";'),
  transactionUsed:
    helper.includes("mongoose.startSession()") &&
    helper.includes("session.withTransaction"),
  cycleLotIsExplicit:
    helper.includes("subscription_cycle:${String(cycle._id)}:${periodKey}") &&
    helper.includes("cycle.creditGrant?.lotId"),
  fixedAppointmentsReceiveLot:
    helper.includes("ap.creditLotId = lot._id || null;") &&
    helper.includes('ap.creditDebitStatus = "monthly_reserved";'),
  lotActuallyDecrements:
    helper.includes("lot.remaining = remainingBefore - reserveCount;"),
  userCreditsRecalculated:
    helper.includes("recalcUserCredits(user);"),
  newReservationDoesNotCreateDebt:
    helper.includes("ap.fixedDebtAmount = 0;") &&
    !helper.includes("fixedScheduleDebt"),
  reservationRunsBeforeExtraNotice:
    monthly.indexOf("reserveMonthlyCycleCreditsForFixedAppointments({", helperEnd) <
    monthly.lastIndexOf("syncExtraSessionNoticeForUserService({"),
  retriesCheckAllCurrentSubscriptions:
    monthly.includes("for (const sub of subscriptions)") &&
    monthly.includes("reservationTargets.set"),
  fixedBillingUnderstandsReservedCredits:
    fixed.includes('["monthly_reserved", "debited"].includes(billingStatus)'),
  monthlyReturnReportsReservations:
    monthly.includes("creditsReserved") &&
    monthly.includes("pendingAfterReservation") &&
    monthly.includes("reservationErrors"),
};

for (const [name, ok] of Object.entries(checks)) {
  if (!ok) throw new Error(`Check falló: ${name}`);
}

function preview(plan, fixedCount) {
  const reserved = Math.min(plan, fixedCount);
  return {
    reserved,
    available: Math.max(0, plan - reserved),
    extraNeeded: Math.max(0, fixedCount - plan),
  };
}

const examples = {
  plan10_fixed8: preview(10, 8),
  plan8_fixed8: preview(8, 8),
  plan8_fixed9: preview(8, 9),
};

if (
  examples.plan10_fixed8.available !== 2 ||
  examples.plan8_fixed8.available !== 0 ||
  examples.plan8_fixed9.available !== 0 ||
  examples.plan8_fixed9.extraNeeded !== 1
) {
  throw new Error("Fallaron los ejemplos de cobertura.");
}

console.log(JSON.stringify({
  ok: true,
  readOnly: true,
  writesToDatabase: false,
  networkRequests: false,
  monthlyRolloverHash: sha256(Buffer.from(monthly)).slice(0,16),
  checks,
  examples,
}, null, 2));
