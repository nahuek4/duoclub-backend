import fs from "fs";

const route = fs.readFileSync("src/routes/admission.js", "utf8");
const mail = fs.readFileSync("src/mail/admissionEmails.js", "utf8");

const checks = {
  performanceEmailConfigured:
    route.includes('performance.by.duo@gmail.com'),
  performanceFormDetection:
    route.includes('formType === "PERFORMANCE"'),
  defaultAdminPreserved:
    route.includes('process.env.ADMIN_EMAIL'),
  explicitRecipientPassed:
    route.includes('sendAdminAdmissionCompletedEmail(doc, pseudoUser, { to: adminTo })'),
  mailOverrideSupported:
    mail.includes('options = {}') &&
    mail.includes('options?.to || ADMIN_EMAIL'),
  userReceiptPreserved:
    route.includes('sendUserAdmissionReceivedEmail(doc, pseudoUser)'),
  noMassDatabaseWrites:
    !route.includes("updateMany(") &&
    !route.includes("deleteMany(") &&
    !route.includes("dropDatabase"),
};

console.log(JSON.stringify({
  ok: Object.values(checks).every(Boolean),
  mode: "STATIC_READ_ONLY",
  writesToDatabase: false,
  networkRequests: false,
  checks,
}, null, 2));

if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
