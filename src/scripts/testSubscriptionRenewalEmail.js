// scripts/testSubscriptionRenewalEmail.js
import fs from "node:fs";
import assert from "node:assert/strict";

const lifecycle = fs.readFileSync(
  new URL("../src/services/subscriptions/subscriptionLifecycle.js", import.meta.url),
  "utf8"
);
const model = fs.readFileSync(
  new URL("../src/models/SubscriptionBillingCycle.js", import.meta.url),
  "utf8"
);
const mailEntry = fs.readFileSync(
  new URL("../src/mail.js", import.meta.url),
  "utf8"
);
const subscriptionMail = fs.readFileSync(
  new URL("../src/mail/subscriptionEmails.js", import.meta.url),
  "utf8"
);

assert.match(lifecycle, /sendSubscriptionRenewalEmail/);
assert.match(lifecycle, /sendRenewalConfirmationEmailOnce/);
assert.match(lifecycle, /renewalConfirmationSentAt/);
assert.match(lifecycle, /renewalConfirmationSendingAt/);
assert.match(lifecycle, /result\.renewalEmail/);

assert.match(model, /renewalConfirmationSendingAt/);
assert.match(model, /renewalConfirmationSentAt/);
assert.match(model, /renewalConfirmationLastError/);

assert.match(mailEntry, /subscriptionEmails\.js/);

assert.match(subscriptionMail, /Tu plan DUO se renovó/);
assert.match(subscriptionMail, /Plan actual/);
assert.match(subscriptionMail, /Valor mensual/);
assert.match(subscriptionMail, /Forma de pago/);
assert.match(subscriptionMail, /Próxima renovación/);
assert.match(subscriptionMail, /Vencimiento de pago/);
assert.match(subscriptionMail, /agenda\/mi-plan/);
assert.match(subscriptionMail, /\.invalid/);

console.log(
  "✅ subscriptionRenewalEmail: mail de renovación idempotente, datos de Mi Plan y protección de simulaciones configurados."
);
