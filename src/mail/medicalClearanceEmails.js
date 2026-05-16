// backend/src/mail/medicalClearanceEmails.js
import { BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { escapeHtml, formatARDateTime } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";
import {
  buildExactMail,
  renderExactBodyText,
  renderPrimaryButton,
  renderAdminDetailPanel,
} from "./ui.js";

/* =========================================================
   Helpers
========================================================= */

function fullNameOf(user = {}) {
  return (
    `${String(user?.name || "").trim()} ${String(user?.lastName || "").trim()}`.trim() ||
    String(user?.fullName || "").trim() ||
    String(user?.email || "").trim() ||
    "alumno/a"
  );
}

function firstNameOf(user = {}) {
  return String(user?.name || "").trim() || fullNameOf(user) || "alumno/a";
}

function safeDate(value) {
  const { date } = formatARDateTime(value);
  return date && date !== "-" ? date : "-";
}

function buildMedicalClearanceEmail({ title, preheader, icon = "✓", innerHtml }) {
  const exact = buildExactMail({
    brandName: BRAND_NAME,
    title,
    preheader,
    icon,
    innerHtml,
  });

  return buildEmailLayout({
    title: exact.title,
    preheader: exact.preheader,
    bodyHtml: exact.bodyHtml,
    footerNote: "",
  });
}

function dueAtOf(user = {}, opts = {}) {
  return opts?.dueAt || user?.medicalClearance?.dueAt || null;
}

function buildAptoDetailRows(user = {}, opts = {}) {
  const dueAt = dueAtOf(user, opts);
  const rows = [];

  if (dueAt) rows.push({ label: "Fecha límite", value: safeDate(dueAt) });
  if (opts?.statusLabel) rows.push({ label: "Estado", value: opts.statusLabel });
  if (opts?.note) rows.push({ label: "Detalle", value: opts.note });

  return rows;
}

async function sendMedicalEmail({ user, subject, text, title, preheader, icon, bodyHtml, ctaLabel = "Ingresar a DUO", ctaHref = BRAND_URL }) {
  const to = String(user?.email || "").trim();
  if (!to) return null;

  const html = buildMedicalClearanceEmail({
    title,
    preheader,
    icon,
    innerHtml: `
      ${bodyHtml}
      ${ctaLabel && ctaHref ? renderPrimaryButton(ctaLabel, ctaHref) : ""}
    `,
  });

  return sendMail(to, subject, text, html);
}

/* =========================================================
   RECORDATORIOS AUTOMÁTICOS
========================================================= */

export async function sendMedicalClearanceReminderEmail(user = {}, opts = {}) {
  const reminderDay = Number(opts?.day || opts?.reminderDay || 0);
  const dueAt = dueAtOf(user, opts);
  const firstName = firstNameOf(user);
  const fullName = fullNameOf(user);

  let subject = `Recordatorio de apto físico - ${BRAND_NAME}`;
  let title = "Recordatorio\nde apto físico";
  let intro = "Te recordamos que la entrega del apto físico es muy importante para cuidarte y cuidarnos.";
  let mainLine = "";
  let preheader = "Recordatorio de apto físico pendiente";

  if (reminderDay === 10) {
    mainLine = "Te quedan 20 días para presentarlo.";
    preheader = "Te quedan 20 días para presentar tu apto físico";
  } else if (reminderDay === 20) {
    subject = `Te quedan 10 días para presentar tu apto físico - ${BRAND_NAME}`;
    mainLine = "Te quedan 10 días para presentarlo.";
    preheader = "Te quedan 10 días para presentar tu apto físico";
  } else if (reminderDay === 30) {
    subject = `Último aviso de apto físico - ${BRAND_NAME}`;
    title = "Último aviso\nde apto físico";
    intro = "Llegamos al límite de tiempo para la presentación de tu apto físico y aún no lo recibimos.";
    mainLine = "Desde el día 31, si no está aprobado, no vas a poder reservar nuevos turnos hasta regularizarlo.";
    preheader = "Último aviso antes del bloqueo de nuevas reservas";
  } else {
    mainLine = "Necesitamos que presentes tu apto físico para mantener habilitada la reserva de turnos.";
  }

  const text = [
    `Hola ${firstName},`,
    "",
    intro,
    mainLine,
    dueAt ? `Fecha límite: ${safeDate(dueAt)}` : "",
    "",
    "Podés ingresar a la plataforma para revisar tu estado o contactarnos si tenés dudas.",
    "",
    `${BRAND_NAME} Health Club`,
  ]
    .filter(Boolean)
    .join("\n");

  const detailRows = buildAptoDetailRows(user, {
    dueAt,
    statusLabel: "Apto físico pendiente",
  });

  return sendMedicalEmail({
    user,
    subject,
    text,
    title,
    preheader,
    icon: "!",
    bodyHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(firstName)}</b>,<br/>${escapeHtml(intro)}<br/><b>${escapeHtml(mainLine)}</b>`,
        {
          fontSize: 14,
          lineHeight: 19,
          weight: 700,
          maxWidth: 320,
          marginBottom: 14,
        }
      )}

      ${renderAdminDetailPanel(detailRows)}

      ${renderExactBodyText(
        `Este aviso corresponde al día ${escapeHtml(String(reminderDay || ""))} desde el alta de ${escapeHtml(fullName)}.`,
        {
          fontSize: 12,
          lineHeight: 17,
          weight: 600,
          maxWidth: 320,
          marginTop: 8,
          marginBottom: 0,
        }
      )}
    `,
  });
}

/* =========================================================
   ESTADOS DE APTO
========================================================= */

export async function sendMedicalClearanceReceivedEmail(user = {}) {
  const firstName = firstNameOf(user);
  const subject = `Recibimos tu apto físico - ${BRAND_NAME}`;

  const text = [
    `Hola ${firstName},`,
    "",
    "Recibimos tu apto físico y quedó pendiente de revisión por nuestro equipo.",
    "Te vamos a avisar cuando esté aprobado u observado.",
    "",
    `${BRAND_NAME} Health Club`,
  ].join("\n");

  return sendMedicalEmail({
    user,
    subject,
    text,
    title: "Apto físico\nrecibido",
    preheader: "Tu apto físico quedó pendiente de revisión",
    icon: "✓",
    bodyHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(firstName)}</b>,<br/>Recibimos tu apto físico y quedó <b>pendiente de revisión</b>.`,
        {
          fontSize: 14,
          lineHeight: 19,
          weight: 700,
          maxWidth: 320,
          marginBottom: 14,
        }
      )}
      ${renderAdminDetailPanel([{ label: "Estado", value: "Pendiente de revisión" }])}
    `,
  });
}

export async function sendMedicalClearanceApprovedEmail(user = {}) {
  const firstName = firstNameOf(user);
  const subject = `Apto físico aprobado - ${BRAND_NAME}`;

  const text = [
    `Hola ${firstName},`,
    "",
    "Tu apto físico fue aprobado por el equipo de DUO.",
    "Ya podés continuar utilizando la plataforma normalmente.",
    "",
    `${BRAND_NAME} Health Club`,
  ].join("\n");

  return sendMedicalEmail({
    user,
    subject,
    text,
    title: "Apto físico\naprobado",
    preheader: "Tu apto físico fue aprobado",
    icon: "✓",
    bodyHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(firstName)}</b>,<br/>Tu apto físico fue <b>aprobado</b> por el equipo de DUO.`,
        {
          fontSize: 14,
          lineHeight: 19,
          weight: 700,
          maxWidth: 320,
          marginBottom: 14,
        }
      )}
      ${renderAdminDetailPanel([{ label: "Estado", value: "Aprobado" }])}
    `,
  });
}

export async function sendMedicalClearanceRejectedEmail(user = {}, opts = {}) {
  const firstName = firstNameOf(user);
  const note = String(opts?.note || opts?.notes || "").trim();
  const subject = `Apto físico observado - ${BRAND_NAME}`;

  const text = [
    `Hola ${firstName},`,
    "",
    "Tu apto físico fue revisado y necesitamos que regularices o vuelvas a enviarlo.",
    note ? `Detalle: ${note}` : "",
    "Por favor, contactanos si tenés dudas.",
    "",
    `${BRAND_NAME} Health Club`,
  ]
    .filter(Boolean)
    .join("\n");

  return sendMedicalEmail({
    user,
    subject,
    text,
    title: "Apto físico\nobservado",
    preheader: "Necesitamos que regularices tu apto físico",
    icon: "!",
    bodyHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(firstName)}</b>,<br/>Tu apto físico fue revisado y necesitamos que lo regularices o vuelvas a enviarlo.`,
        {
          fontSize: 14,
          lineHeight: 19,
          weight: 700,
          maxWidth: 320,
          marginBottom: 14,
        }
      )}
      ${renderAdminDetailPanel([
        { label: "Estado", value: "Observado" },
        ...(note ? [{ label: "Detalle", value: note }] : []),
      ])}
    `,
  });
}

export async function sendMedicalClearanceSuspendedEmail(user = {}) {
  const firstName = firstNameOf(user);
  const subject = `Reserva de turnos suspendida por apto físico - ${BRAND_NAME}`;

  const text = [
    `Hola ${firstName},`,
    "",
    "Como todavía no contamos con tu apto físico aprobado, desde hoy no podés reservar nuevos turnos en la plataforma.",
    "Podés seguir entrando a tu cuenta. Cuando regularices el apto, el equipo de DUO va a reactivar la reserva de turnos.",
    "",
    `${BRAND_NAME} Health Club`,
  ].join("\n");

  return sendMedicalEmail({
    user,
    subject,
    text,
    title: "Reserva\nsuspendida",
    preheader: "Tu reserva de turnos quedó suspendida hasta regularizar el apto físico",
    icon: "!",
    bodyHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(firstName)}</b>,<br/>Como todavía no contamos con tu apto físico aprobado, desde hoy <b>no podés reservar nuevos turnos</b> en la plataforma.`,
        {
          fontSize: 14,
          lineHeight: 19,
          weight: 700,
          maxWidth: 320,
          marginBottom: 14,
        }
      )}
      ${renderAdminDetailPanel([
        { label: "Estado", value: "Reserva suspendida" },
        { label: "Motivo", value: "Apto físico pendiente" },
      ])}
      ${renderExactBodyText(
        "Podés seguir entrando a tu cuenta. Cuando regularices el apto, el equipo de DUO va a reactivar la reserva de turnos.",
        {
          fontSize: 12,
          lineHeight: 17,
          weight: 600,
          maxWidth: 320,
          marginTop: 8,
          marginBottom: 0,
        }
      )}
    `,
  });
}

export async function sendMedicalClearanceStatusEmail(user = {}, status = "", opts = {}) {
  const st = String(status || "").toLowerCase().trim();

  if (st === "pending_review") return sendMedicalClearanceReceivedEmail(user, opts);
  if (st === "approved") return sendMedicalClearanceApprovedEmail(user, opts);
  if (st === "rejected") return sendMedicalClearanceRejectedEmail(user, opts);
  if (st === "suspended") return sendMedicalClearanceSuspendedEmail(user, opts);

  return null;
}
