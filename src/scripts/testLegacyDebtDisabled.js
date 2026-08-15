import fs from "fs";
import path from "path";
import assert from "assert";

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const appointments = read("src/routes/appointments.js");
const orders = read("src/routes/orders.js");
const webhook = read("src/routes/mpWebhook.js");
const users = read("src/routes/users.js");
const fixedBilling = read("src/jobs/fixedScheduleBilling.js");

// No debe existir ninguna escritura operativa sobre el saldo legacy.
for (const [name, source] of [
  ["appointments", appointments],
  ["orders", orders],
  ["mpWebhook", webhook],
  ["users", users],
  ["fixedScheduleBilling", fixedBilling],
]) {
  assert.ok(
    !/fixedScheduleDebt\s*\[[^\]]+\]\s*=/.test(source),
    `${name}: todavía escribe fixedScheduleDebt`
  );
}

// Compras/cargas deben acreditar completo, sin settlement legacy.
assert.ok(!/function\s+settleFixedScheduleDebt\s*\(/.test(orders), "orders: settlement legacy activo");
assert.ok(!/function\s+settleFixedScheduleDebt\s*\(/.test(webhook), "mpWebhook: settlement legacy activo");
assert.ok(!/function\s+settleFixedScheduleDebt\s*\(/.test(users), "users: settlement legacy activo");

// La asignación manual ya no debe crear deuda.
assert.ok(!appointments.includes('action: "manual_admin_debt"'), "appointments: manual_admin_debt sigue activo");
assert.ok(!appointments.includes('manualBillingAction = "debt"'), "appointments: manualBillingAction debt sigue activo");
assert.ok(appointments.includes('manualBillingAction = "pending_coverage"'), "appointments: falta pending_coverage");

// El backfill legacy debe quedar deshabilitado.
assert.ok(appointments.includes('code: "LEGACY_DEBT_DISABLED"'), "appointments: backfill legacy no está deshabilitado");

// El job viejo no puede liberar turnos por deuda ni enviar resumen de deuda.
assert.ok(
  /releaseUnpaidFixedSchedules\(\)[\s\S]*LEGACY_DEBT_DISABLED/.test(fixedBilling),
  "fixedScheduleBilling: liberación legacy no está deshabilitada"
);
assert.ok(
  /sendWeeklyFixedDebtSummary\(\)[\s\S]*LEGACY_DEBT_DISABLED/.test(fixedBilling),
  "fixedScheduleBilling: resumen legacy no está deshabilitado"
);

console.log("✅ legacyDebtDisabled: la deuda legacy quedó aislada de la lógica operativa.");
