import fs from "fs";
import path from "path";

const file = path.resolve(process.cwd(), "src/routes/appointments.js");
const src = fs.readFileSync(file, "utf8");

const checks = [
  [src.includes("const EP_CAP_PER_SLOT = 11;"), "EP debe tener máximo 11"],
  [src.includes("const THERAPY_SHARED_CAP_PER_SLOT = 6;"), "Performance debe tener máximo compartido 6"],
  [src.includes('const OPERATIONAL_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);'), "Solo EP/RA/RF/SYN deben ser operativos"],
  [src.includes('"13:00", "14:00"') && src.includes('"15:00", "16:00", "17:00", "18:00"'), "Performance debe ser continuo 07:00-18:00"],
  [src.includes('return ["RA", "RF", "SYN"].includes(sk);'), "RA/RF/SYN deben compartir el pool Performance"],
];

const failed = checks.filter(([ok]) => !ok);
if (failed.length) {
  for (const [, msg] of failed) console.error(`❌ ${msg}`);
  process.exit(1);
}

console.log("✅ Cupos y horarios operativos correctos: EP=11; RA/RF/SYN=6 compartidos; horarios actualizados.");
