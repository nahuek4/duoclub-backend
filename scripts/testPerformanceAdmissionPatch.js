import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

const model = read("src/models/Admission.js");
const route = read("src/routes/admission.js");

const checks = {
  modelEmergencyPhone: model.includes("emergencyPhone:"),
  modelHealthInsurancePlan: model.includes("healthInsurancePlan:"),
  modelFormType: model.includes("formType:"),
  modelPerformanceGoal: model.includes("performanceGoal:"),
  step2StillMixed: model.includes("step2: {") && model.includes("type: mongoose.Schema.Types.Mixed"),
  publicStep1RoutePreserved: route.includes('router.post("/step1"'),
  publicStep2RoutePreserved: route.includes('router.patch("/:id/step2"'),
  performanceNotesSupported: route.includes('formType === "PERFORMANCE"'),
  adminListIncludesFormType: route.includes('"step1.formType"'),
  adminListIncludesGoal: route.includes('"step1.performanceGoal"'),
  adminListIncludesEmergencyPhone: route.includes('"step1.emergencyPhone"'),
  adminListIncludesInsurancePlan: route.includes('"step1.healthInsurancePlan"'),
  noMassDatabaseWritesAdded: !route.includes("updateMany(") && !route.includes("deleteMany("),
};

const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({
  ok,
  mode: "STATIC_READ_ONLY",
  writesToDatabase: false,
  networkRequests: false,
  checks,
}, null, 2));

if (!ok) process.exitCode = 1;
