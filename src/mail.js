// backend/src/mail.js
// Entry point único para centralizar exports y mantener compatibilidad
// con nombres viejos usados por algunas rutas.

export * from "./mail/core.js";
export * from "./mail/authEmails.js";
export * from "./mail/appointmentEmails.js";
export * from "./mail/admissionEmails.js";
export * from "./mail/orderEmails.js";
export * from "./mail/layout.js";
export * from "./mail/creditsEmails.js";
export * from "./mail/helpers.js";
export * from "./mail/ui.js";

import {
  sendAdminOrderPendingEmail,
  sendOrderPendingEmail,
  sendOrderPaidEmail,
  sendOrderCancelledEmail,
} from "./mail/orderEmails.js";

import {
  sendCreditsChangedEmail,
  sendAdminCreditsChangedEmail,
} from "./mail/creditsEmails.js";

// Aliases legacy / compatibilidad
export {
  sendAdminOrderPendingEmail as sendAdminNewOrderEmail,
  sendAdminOrderPendingEmail as sendAdminOrderEmail,
  sendOrderPendingEmail as sendUserOrderCashCreatedEmail,
  sendOrderPendingEmail as sendOrderCashCreatedEmail,
  sendOrderPaidEmail as sendUserOrderPaidEmail,
  sendOrderCancelledEmail as sendUserOrderCancelledEmail,
  sendCreditsChangedEmail as sendUserCreditsAssignedEmail,
  sendAdminCreditsChangedEmail as sendAdminCreditsAssignedEmail,
  sendCreditsChangedEmail as sendCreditsAssignedEmail,
};
