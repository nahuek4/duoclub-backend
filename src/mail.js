// backend/src/mail.js
// ✅ Entry-point único para imports tipo: import { ... } from "../mail.js"

export * from "./mail/core.js";
export * from "./mail/authEmails.js";
export * from "./mail/appointmentEmails.js";
export * from "./mail/admissionEmails.js";
export * from "./mail/orderEmails.js";
export * from "./mail/layout.js";
export * from "./mail/creditsEmails.js";

/* =========================================================
   ALIASES DE COMPATIBILIDAD
   users.js hoy importa:
   - sendAdminCreditsAssignedEmail
   - sendUserCreditsAssignedEmail

   Pero creditsEmails.js expone:
   - sendAdminCreditsChangedEmail
   - sendCreditsChangedEmail

   Entonces los reexportamos con alias para no romper el resto.
========================================================= */

export {
  sendAdminCreditsChangedEmail as sendAdminCreditsAssignedEmail,
  sendCreditsChangedEmail as sendUserCreditsAssignedEmail,
} from "./mail/creditsEmails.js";