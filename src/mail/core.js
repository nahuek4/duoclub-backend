// backend/src/mail/core.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

let transporter = null;

/* =========================================================
   Config
========================================================= */
export const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "duoclub.ar@gmail.com").trim();
export const BRAND_NAME = String(process.env.BRAND_NAME || "DUO").trim();
export const BRAND_URL = String(process.env.BRAND_URL || "https://duoclub.ar").trim();

/* =========================================================
   Boot log (SIEMPRE)
========================================================= */
console.log("[MAIL] core loaded", {
  NODE_ENV: process.env.NODE_ENV,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_SECURE: process.env.SMTP_SECURE,
  SMTP_USER: process.env.SMTP_USER ? JSON.stringify(process.env.SMTP_USER) : null,
  hasSMTP_PASS: !!process.env.SMTP_PASS,
  MAIL_FROM: process.env.MAIL_FROM,
  ADMIN_EMAIL,
});

/* =========================================================
   Util: fire-and-forget
========================================================= */
export function fireAndForget(fn, label = "MAIL") {
  try {
    setImmediate(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => console.log(`[${label}] async error:`, e));
    });
  } catch (e) {
    console.log(`[${label}] schedule error:`, e);
  }
}

/* =========================================================
   Helpers
========================================================= */
function envTrim(key, fallback = "") {
  const v = process.env?.[key];
  return String(v ?? fallback).trim();
}

function envBool(key, fallback = "false") {
  const v = envTrim(key, fallback).toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

/* =========================================================
   Transporter
========================================================= */
function getTransporter() {
  if (transporter) return transporter;

  const SMTP_HOST = envTrim("SMTP_HOST");
  const SMTP_PORT = Number(envTrim("SMTP_PORT", "587"));
  const SMTP_USER = envTrim("SMTP_USER");
  const SMTP_PASS = envTrim("SMTP_PASS");

  const inferredSecure = SMTP_PORT === 465 ? "true" : "false";
  const SMTP_SECURE = envBool("SMTP_SECURE", inferredSecure);

  console.log("[MAIL] init transporter", {
    SMTP_HOST: SMTP_HOST || null,
    SMTP_PORT,
    SMTP_SECURE,
    SMTP_USER: SMTP_USER ? JSON.stringify(SMTP_USER) : null,
    hasPass: !!SMTP_PASS,
    MAIL_FROM: envTrim("MAIL_FROM") || null,
  });

  // Modo mock
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log("[MAIL] SMTP missing -> MOCK", {
      hasHost: !!SMTP_HOST,
      hasUser: !!SMTP_USER,
      hasPass: !!SMTP_PASS,
    });
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: { user: SMTP_USER, pass: SMTP_PASS },

    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,

    pool: true,
    maxConnections: 2,
    maxMessages: 50,
  });

  transporter.verify().then(
    () => console.log("[MAIL] SMTP VERIFY OK"),
    (e) => console.log("[MAIL] SMTP VERIFY FAILED", e)
  );

  return transporter;
}

/* =========================================================
   Send base
========================================================= */
export async function sendMail(to, subject, text, html) {
  console.log("[MAIL] sendMail called", { to, subject });

  const tx = getTransporter();
  const cleanTo = String(to || "").trim();
  const cleanSubject = String(subject || "").trim();

  if (!cleanTo || !cleanSubject) {
    console.log("[MAIL] invalid args", { to, subject });
    return;
  }

  if (!tx) {
    console.log("[MAIL MOCK] not sent", { to: cleanTo, subject: cleanSubject });
    return;
  }

  const from = envTrim("MAIL_FROM") || envTrim("SMTP_USER");

  const payload = { from, to: cleanTo, subject: cleanSubject };
  if (text) payload.text = String(text);
  if (html) payload.html = String(html);

  try {
    const info = await tx.sendMail(payload);

    console.log("[MAIL] SENT OK", {
      to: cleanTo,
      subject: cleanSubject,
      messageId: info?.messageId,
      accepted: info?.accepted,
      rejected: info?.rejected,
      response: info?.response,
    });

    return info;
  } catch (e) {
    console.log("[MAIL] SEND FAILED", {
      to: cleanTo,
      subject: cleanSubject,
      code: e?.code,
      command: e?.command,
      response: e?.response,
      responseCode: e?.responseCode,
    });
    console.log("[MAIL] ERROR FULL:", e);
    throw e;
  }
}
