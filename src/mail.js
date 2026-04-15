// backend/src/mail.js

export * from "./mail/core.js";
export * from "./mail/authEmails.js";
export * from "./mail/appointmentEmails.js";
export * from "./mail/admissionEmails.js";
export * from "./mail/orderEmails.js";
export * from "./mail/layout.js";
export * from "./mail/creditsEmails.js";

/* =========================================================
   FIX COMPATIBILIDAD
========================================================= */

// CREDITOS
export {
  sendAdminCreditsChangedEmail as sendAdminCreditsAssignedEmail,
  sendCreditsChangedEmail as sendUserCreditsAssignedEmail,
} from "./mail/creditsEmails.js";

// ORDERS
export {
  sendAdminOrderPendingEmail as sendAdminNewOrderEmail,
  sendOrderPendingEmail as sendUserOrderCashCreatedEmail,
} from "./mail/orderEmails.js";