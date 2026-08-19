// backend/src/mail.js
// Entry point único del sistema de mails DUO.

export * from "./mail/core.js";
export * from "./mail/authEmails.js";
export * from "./mail/appointmentEmails.js";
export * from "./mail/admissionEmails.js";
export * from "./mail/orderEmails.js";
export * from "./mail/layout.js";
export * from "./mail/creditsEmails.js";
export * from "./mail/medicalClearanceEmails.js";
export * from "./mail/userNotificationEmails.js";
export * from "./mail/subscriptionEmails.js";
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

// Nombres públicos que siguen usando las rutas actuales de órdenes.
export const sendAdminNewOrderEmail = sendAdminOrderPendingEmail;
export const sendAdminOrderEmail = sendAdminOrderPendingEmail;
export const sendUserOrderCashCreatedEmail = sendOrderPendingEmail;
export const sendOrderCashCreatedEmail = sendOrderPendingEmail;
export const sendUserOrderPaidEmail = sendOrderPaidEmail;
export const sendUserOrderCancelledEmail = sendOrderCancelledEmail;

function normalizeCreditsCall(first = {}, items = [], meta = {}) {
  if (
    first &&
    typeof first === "object" &&
    (Object.prototype.hasOwnProperty.call(first, "user") ||
      Object.prototype.hasOwnProperty.call(first, "items"))
  ) {
    return {
      user: first.user || {},
      items: Array.isArray(first.items) ? first.items : [],
      meta: {
        ...(first.meta && typeof first.meta === "object" ? first.meta : {}),
        ...(first.actorName ? { actorName: first.actorName } : {}),
        ...(first.reason ? { reason: first.reason } : {}),
      },
    };
  }

  return {
    user: first || {},
    items: Array.isArray(items) ? items : [],
    meta: meta && typeof meta === "object" ? meta : {},
  };
}

// Compatibilidad con users.js: acepta tanto firma posicional como objeto payload.
export async function sendUserCreditsAssignedEmail(first = {}, items = [], meta = {}) {
  const call = normalizeCreditsCall(first, items, meta);
  return sendCreditsChangedEmail(call.user, call.items, call.meta);
}

export async function sendAdminCreditsAssignedEmail(first = {}, items = [], meta = {}) {
  const call = normalizeCreditsCall(first, items, meta);
  return sendAdminCreditsChangedEmail(call.user, call.items, call.meta);
}

export const sendCreditsAssignedEmail = sendUserCreditsAssignedEmail;
