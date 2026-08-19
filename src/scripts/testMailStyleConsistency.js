import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const mailDir = path.join(root, "src", "mail");

function fail(message) {
  console.error(`❌ Mail style: ${message}`);
  process.exitCode = 1;
}

const files = fs
  .readdirSync(mailDir)
  .filter((name) => name.endsWith(".js"))
  .sort();

let badWeightCount = 0;
let duplicateFooterSourceCount = 0;

for (const name of files) {
  const full = path.join(mailDir, name);
  const src = fs.readFileSync(full, "utf8");

  const weightRegex = /(?:font-weight|weight)\s*:\s*(\d+)/g;
  let match;
  while ((match = weightRegex.exec(src))) {
    const weight = Number(match[1]);
    if (Number.isFinite(weight) && weight > 750) {
      badWeightCount += 1;
      fail(`${name} contiene peso ${weight}; el máximo permitido es 750.`);
    }
  }

  if (name !== "ui.js") {
    for (const token of [
      "DUOCLUB.AR",
      "duohealthclub.png",
      "iconoig.png",
      "iconolnkd.png",
      "iconospot.png",
      "+54 9 249 420 7343",
    ]) {
      if (src.includes(token)) {
        duplicateFooterSourceCount += 1;
        fail(`${name} redefine contenido del footer (${token}). El footer debe vivir solo en ui.js.`);
      }
    }
  }
}

const ui = fs.readFileSync(path.join(mailDir, "ui.js"), "utf8");
const requiredUiTokens = [
  "export function renderUnifiedMailFooter",
  "DUOCLUB.AR",
  "+54 9 249 420 7343",
  "Avellaneda 1425 of. 201, Tandil",
  "iconoig.png",
  "iconolnkd.png",
  "iconospot.png",
  "color:#ffffff !important",
  "font-weight:700",
];

for (const token of requiredUiTokens) {
  if (!ui.includes(token)) fail(`ui.js no contiene el elemento obligatorio del footer: ${token}`);
}

const directFooterFiles = [
  "admissionEmails.js",
  "appointmentEmails.js",
  "authEmails.js",
  "creditsEmails.js",
  "orderEmails.js",
  "subscriptionEmails.js",
  "userNotificationEmails.js",
];

for (const name of directFooterFiles) {
  const src = fs.readFileSync(path.join(mailDir, name), "utf8");
  if (!src.includes("renderUnifiedMailFooter")) {
    fail(`${name} no usa renderUnifiedMailFooter.`);
  }
}

const exactMailFiles = [
  "medicalClearanceEmails.js",
];
for (const name of exactMailFiles) {
  const src = fs.readFileSync(path.join(mailDir, name), "utf8");
  if (!src.includes("buildExactMail")) {
    fail(`${name} no pasa por buildExactMail/ui.js para recibir el footer unificado.`);
  }
}

if (!process.exitCode) {
  console.log(
    "✅ Mail style OK: footer único en ui.js, iconos sociales presentes, DUOCLUB.AR forzado en blanco y pesos <= 750."
  );
}
