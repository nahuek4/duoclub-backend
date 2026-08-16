import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function must(text, token, label) {
  if (!text.includes(token)) throw new Error(`Falta ${label}: ${token}`);
}

function mustNot(text, token, label) {
  if (text.includes(token)) throw new Error(`No debería existir ${label}: ${token}`);
}

const appointments = read("src/routes/appointments.js");
const services = read("src/routes/services.js");
const users = read("src/routes/users.js");

must(appointments, 'const ACTIVE_SERVICE_KEYS = new Set(["EP", "RA", "RF", "SYN"]);', "servicios activos en appointments");
must(appointments, "const EP_CAP_PER_SLOT = 11;", "cupo Training 11");
must(appointments, "const THERAPY_SHARED_CAP_PER_SLOT = 6;", "cupo Performance 6");
must(appointments, '"20:00",', "último inicio Training 20:00");
must(appointments, '"15:00", "16:00", "17:00", "18:00",', "franja continua Performance hasta 18:00");
must(appointments, 'return ["RA", "RF", "SYN"].includes(sk);', "pool Performance RA/RF/SYN");

must(users, 'const ACTIVE_SERVICE_KEYS = new Set(["EP", "RF", "RA", "SYN"]);', "servicios activos en users");

for (const key of ["EP", "RA", "RF", "SYN"]) {
  must(services, `serviceKey: "${key}"`, `servicio ${key} en /services`);
}
for (const key of ["PE", "KD", "NUT"]) {
  mustNot(services, `serviceKey: "${key}"`, `servicio retirado ${key} en /services`);
}

console.log("✅ operationalServices: EP/RA/RF/SYN activos, cupos 11/6 y horarios nuevos configurados.");
