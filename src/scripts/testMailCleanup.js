// scripts/testMailCleanup.js
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const allMailFiles = fs
  .readdirSync(path.join(root, "src/mail"))
  .filter((name) => name.endsWith(".js"))
  .map((name) => read(`src/mail/${name}`))
  .join("\n");

const forbidden = [
  "sendAdminFixedScheduleDebtSummaryEmail",
  "sendCreditConsumedEmail",
  "sendFinalWeekOfMonthEmail",
  "sendMonthEndEmail",
  "sendMonthStartFixedSchedulesEmail",
  "sendAppointmentCancelledBatchEmail",
  "Resumen semanal de sesiones adeudadas",
  "Sesiones adeudadas",
  "buildVerifyVisualEmail",
];

for (const token of forbidden) {
  assert.equal(
    allMailFiles.includes(token),
    false,
    `Todavía existe mail/código obsoleto: ${token}`
  );
}

const notificationJob = read("src/jobs/userNotifications.js");
assert.match(notificationJob, /sendCreditsExpiryReminderEmail/);
assert.match(notificationJob, /sendBirthdayEmail/);
assert.match(notificationJob, /sendAdminBirthdayEmail/);
assert.doesNotMatch(notificationJob, /FixedSchedule/);
assert.doesNotMatch(notificationJob, /sendFinalWeekOfMonthEmail/);
assert.doesNotMatch(notificationJob, /sendMonthEndEmail/);
assert.doesNotMatch(notificationJob, /sendMonthStartFixedSchedulesEmail/);

const mailEntry = read("src/mail.js");
assert.match(mailEntry, /sendUserCreditsAssignedEmail/);
assert.match(mailEntry, /sendAdminCreditsAssignedEmail/);

const index = read("src/index.js");
assert.doesNotMatch(index, /testMailRouter/);
assert.doesNotMatch(index, /FIXED_DEBT_SUMMARY_EVERY_MINUTES/);

assert.equal(
  fs.existsSync(path.join(root, "src/routes/testMail.js")),
  false,
  "Borrá src/routes/testMail.js"
);
assert.equal(
  fs.existsSync(path.join(root, "src/scheduler.js")),
  false,
  "Borrá src/scheduler.js (scheduler legacy no utilizado)"
);

console.log("✅ Mail cleanup OK: sin deuda, sin avisos mensuales duplicados, sin template de verificación duplicado y sin endpoints/schedulers legacy.");
