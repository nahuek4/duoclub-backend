import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  creditExpiryForDate,
  creditExpiryForMonthKey,
  monthKeyFromArgentinaDate,
  nextMonthKey,
} from "../src/utils/creditExpiry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

assert.equal(nextMonthKey("2026-08"), "2026-09");
assert.equal(nextMonthKey("2026-12"), "2027-01");
assert.equal(
  creditExpiryForMonthKey("2026-08").toISOString(),
  "2026-09-01T03:00:00.000Z"
);
assert.equal(
  creditExpiryForMonthKey("2026-12").toISOString(),
  "2027-01-01T03:00:00.000Z"
);
assert.equal(
  monthKeyFromArgentinaDate(new Date("2026-08-16T01:30:00.000Z")),
  "2026-08"
);
assert.equal(
  creditExpiryForDate(new Date("2026-08-31T23:30:00.000Z")).toISOString(),
  "2026-09-01T03:00:00.000Z"
);

const checks = [
  ["src/routes/users.js", "creditExpiryForDate(now)"],
  ["src/routes/orders.js", "creditExpiryForDate(now)"],
  ["src/routes/mpWebhook.js", "creditExpiryForDate(now)"],
  ["src/routes/appointments.js", "creditExpiryForDate(now)"],
  ["src/services/subscriptions/subscriptionLifecycle.js", "creditExpiryForMonthKey(periodKey)"],
];

for (const [relativePath, expected] of checks) {
  const text = fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.ok(text.includes(expected), `${relativePath} no usa ${expected}`);
}

for (const relativePath of [
  "src/routes/users.js",
  "src/routes/orders.js",
  "src/routes/mpWebhook.js",
]) {
  const text = fs.readFileSync(path.join(root, relativePath), "utf8");
  assert.ok(
    !text.includes("const exp = lastDayOfCurrentMonth();"),
    `${relativePath} todavía acredita al último día del mes`
  );
}

const appointments = fs.readFileSync(path.join(root, "src/routes/appointments.js"), "utf8");
assert.ok(
  !appointments.includes("exp.setDate(exp.getDate() + Number(getCreditsExpireDays() || 30))"),
  "appointments.js todavía genera reintegros con +30 días"
);

console.log("✅ creditMonthlyExpiry: todos los créditos nuevos vencen el día 1 del mes siguiente.");
