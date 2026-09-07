// DUO — tester read-only: acciones de administración de servicios.
// Ejecutar desde la raíz del backend:
//   node scripts/testServiceAdminActions.js
//
// No conecta a Mongo, no hace requests y no escribe.

import fs from "fs";
import { spawnSync } from "child_process";

const file = "src/routes/services.js";
if (!fs.existsSync(file)) {
  throw new Error(`Falta ${file}`);
}

const source = fs.readFileSync(file, "utf8");

const syntax = spawnSync(process.execPath, ["--check", file], {
  encoding: "utf8",
});
if (syntax.status !== 0) {
  throw new Error(syntax.stderr || syntax.stdout || "services.js no pasa node --check");
}

const deleteStart = source.indexOf('// DELETE /services/admin/catalog/:serviceKey');
const deleteEnd = source.indexOf('export default router;', deleteStart);
const deleteBlock = deleteStart >= 0 && deleteEnd > deleteStart
  ? source.slice(deleteStart, deleteEnd)
  : "";

const checks = {
  quickStatusRoute:
    source.includes('router.patch(') &&
    source.includes('"/admin/catalog/:serviceKey/status"'),
  statusOnlyChangesActive:
    source.includes('existing.active = req.body.active;'),
  deleteRoute:
    source.includes('router.delete(') &&
    source.includes('"/admin/catalog/:serviceKey"'),
  deleteChecksUsage:
    deleteBlock.includes('const usage = await serviceUsageSummary(serviceKey);') &&
    deleteBlock.includes('if (totalUsage > 0)'),
  deleteDoesNotCascadeUserData:
    !deleteBlock.includes('deleteMany(') &&
    !deleteBlock.includes('updateMany('),
  physicalDeleteOnlyDefinition:
    deleteBlock.includes('await existing.deleteOne();'),
  legacyProtected:
    deleteBlock.includes('LEGACY_SERVICE_PROTECTED'),
  pricingChecked:
    source.includes('["pricingPlans", "pricingplans"'),
  appointmentsChecked:
    source.includes('["appointments", "appointments"'),
  fixedSchedulesChecked:
    source.includes('["fixedSchedules", "fixedschedules"'),
  subscriptionsChecked:
    source.includes('["subscriptions", "servicesubscriptions"'),
  billingCyclesChecked:
    source.includes('["billingCycles", "subscriptionbillingcycles"'),
  creditsChecked:
    source.includes('"creditLots.serviceKey"'),
};

for (const [name, ok] of Object.entries(checks)) {
  if (!ok) throw new Error(`Check falló: ${name}`);
}

console.log(JSON.stringify({
  ok: true,
  readOnly: true,
  writesToDatabase: false,
  networkRequests: false,
  checks,
}, null, 2));
