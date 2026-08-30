import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const file = path.join(root, "src/services/subscriptions/subscriptionBootstrap.js");
const src = fs.readFileSync(file, "utf8");

const expected = 'const RECURRING_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);';

if (!src.includes(expected)) {
  console.error("❌ subscriptionBootstrap.js no está limitado a EP/RA/RF/SYN.");
  process.exit(1);
}

if (/RECURRING_SERVICE_KEYS\s*=\s*new Set\([^\n]*(?:"KD"|"NUT"|"PE")/.test(src)) {
  console.error("❌ KD/NUT/PE siguen habilitados como servicios recurrentes en bootstrap.");
  process.exit(1);
}

console.log("✅ Subscription bootstrap hardening OK: solo EP/RA/RF/SYN pueden inicializar suscripciones nuevas.");
console.log("✅ PE/KD/NUT pueden seguir existiendo en nombres/histórico, pero no dentro de RECURRING_SERVICE_KEYS.");
console.log("✅ Test estático: no conecta MongoDB ni crea suscripciones.");
