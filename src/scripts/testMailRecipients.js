// scripts/testMailRecipients.js
import assert from "node:assert/strict";

process.env.TRAINING_ZONE_EMAIL = "training.by.duo@gmail.com";
process.env.PERFORMANCE_ZONE_EMAIL = "performance.by.duo@gmail.com";
process.env.ADMIN_EMAIL = "admin.general@example.com";

const {
  normalizeServiceKey,
  zoneEmailForService,
  adminRecipientsForService,
  adminRecipientsForAppointment,
  adminRecipientsForOrder,
  adminRecipientsForServiceItems,
} = await import("../src/mail/recipients.js");

const TRAINING = "training.by.duo@gmail.com";
const PERFORMANCE = "performance.by.duo@gmail.com";
const ADMIN = "admin.general@example.com";

assert.equal(normalizeServiceKey("Entrenamiento Personal"), "EP");
assert.equal(normalizeServiceKey("Rehabilitación Activa"), "RA");
assert.equal(normalizeServiceKey("Reeducación Funcional"), "RF");
assert.equal(normalizeServiceKey("Synergy"), "SYN");
assert.equal(normalizeServiceKey("Sinergia"), "SYN");

assert.equal(zoneEmailForService("EP"), TRAINING);
assert.equal(zoneEmailForService("RA"), PERFORMANCE);
assert.equal(zoneEmailForService("RF"), PERFORMANCE);
assert.equal(zoneEmailForService("SYN"), PERFORMANCE);

// Un mail ligado a servicio NO debe copiar por defecto al admin general.
assert.deepEqual(adminRecipientsForService("EP"), [TRAINING]);
assert.deepEqual(adminRecipientsForService("RA"), [PERFORMANCE]);
assert.deepEqual(adminRecipientsForService("RF"), [PERFORMANCE]);
assert.deepEqual(adminRecipientsForService("SYN"), [PERFORMANCE]);

assert.deepEqual(
  adminRecipientsForAppointment({ serviceKey: "EP" }),
  [TRAINING]
);

assert.deepEqual(
  adminRecipientsForAppointment({ serviceName: "Synergy" }),
  [PERFORMANCE]
);

assert.deepEqual(
  adminRecipientsForOrder({
    items: [{ kind: "CREDITS", serviceKey: "EP", credits: 8 }],
  }),
  [TRAINING]
);

assert.deepEqual(
  adminRecipientsForOrder({
    items: [{ kind: "CREDITS", serviceKey: "RA", credits: 8 }],
  }),
  [PERFORMANCE]
);

assert.deepEqual(
  adminRecipientsForOrder({
    items: [
      { kind: "CREDITS", serviceKey: "EP", credits: 8 },
      { kind: "CREDITS", serviceKey: "SYN", credits: 4 },
    ],
  }),
  [TRAINING, PERFORMANCE]
);

assert.deepEqual(
  adminRecipientsForServiceItems([
    { serviceKey: "RF", delta: 2 },
    { serviceKey: "SYN", delta: 1 },
  ]),
  [PERFORMANCE]
);

// Si no hay servicio reconocible, conserva el fallback general.
assert.deepEqual(adminRecipientsForService(""), [ADMIN]);

// Solo si se pide explícitamente, también copia al admin general.
assert.deepEqual(
  adminRecipientsForService("EP", { includeMainAdmin: true }),
  [TRAINING, ADMIN]
);

console.log(
  "✅ Mail routing OK: EP -> Training; RA/RF/SYN -> Performance; sin copia general automática."
);
