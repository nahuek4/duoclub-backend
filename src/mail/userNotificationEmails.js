// backend/src/mail/userNotificationEmails.js
import { ADMIN_EMAIL, BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { escapeHtml } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";
import {
  buildExactMail,
  renderExactBodyText,
  renderPrimaryButton,
  renderAdminDetailPanel,
  renderAdminMetaPanel,
  renderRowCard,
} from "./ui.js";

const SERVICE_LABELS = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  NUT: "Nutrición",
};

function cleanStr(v, fallback = "-") {
  const s = String(v ?? "").trim();
  return s ? s : fallback;
}

function fullNameOf(user = {}) {
  const n = String(user?.name || "").trim();
  const l = String(user?.lastName || "").trim();
  return [n, l].filter(Boolean).join(" ") || user?.fullName || user?.email || "Usuario";
}

function firstNameOf(user = {}) {
  return String(user?.name || "").trim() || "Usuario";
}

function serviceLabel(key) {
  const k = String(key || "").toUpperCase().trim();
  return SERVICE_LABELS[k] || k || "Servicio";
}

function formatDateAR(dateLike) {
  try {
    const d = dateLike ? new Date(dateLike) : null;
    if (!d || Number.isNaN(d.getTime())) return "-";
    return d.toLocaleDateString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
  } catch {
    return "-";
  }
}

function buildNotificationEmail({ title, preheader, icon = "✓", innerHtml }) {
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

function renderCreditsPanel(summary = {}) {
  const items = Object.entries(SERVICE_LABELS).map(([key, label]) => {
    const n = Math.max(0, Number(summary?.[key] || 0));
    return renderRowCard({
      titleLeft: `${label} · ${key}`,
      titleRight: `${n}`,
      subtitle: `<span style="color:#ffffff;">${n === 1 ? "1 sesión disponible" : `${n} sesiones disponibles`}</span>`,
    });
  });

  return `
    <div
      class="panel"
      style="
        background:#0a0a0a;
        border-radius:6px;
        padding:14px;
        margin:0 auto 22px;
        max-width:100%;
        text-align:left;
      "
    >
      ${items.join("")}
    </div>
  `;
}

function fixedScheduleRows(schedules = []) {
  const list = Array.isArray(schedules) ? schedules : [];
  if (!list.length) return [];

  const weekday = {
    1: "Lunes",
    2: "Martes",
    3: "Miércoles",
    4: "Jueves",
    5: "Viernes",
  };

  return list.flatMap((s) => {
    const sk = String(s?.serviceKey || "").toUpperCase().trim();
    const svc = serviceLabel(sk || s?.service);
    const items = Array.isArray(s?.items) ? s.items : [];
    return items.map((it) => ({
      label: `${svc} · ${weekday[it?.weekday] || `Día ${it?.weekday || "-"}`}`,
      value: `${String(it?.time || "-").slice(0, 5)} hs`,
    }));
  });
}

export async function sendCreditsExpiryReminderEmail(user = {}, summary = {}, meta = {}) {
  const to = String(user?.email || "").trim();
  if (!to) return;

  const name = firstNameOf(user);
  const monthLabel = cleanStr(meta?.monthLabel, "este mes");
  const endDate = formatDateAR(meta?.monthEnd);

  const text = [
    `Hola ${name},`,
    "",
    `Te compartimos el estado de tus sesiones disponibles para ${monthLabel}.`,
    "",
    ...Object.entries(SERVICE_LABELS).map(([key, label]) => `${label} (${key}): ${Math.max(0, Number(summary?.[key] || 0))}`),
    "",
    `Recordá que las sesiones del mes vencen el ${endDate}, al finalizar el día.`,
    "",
    BRAND_URL ? `Ingresar: ${BRAND_URL}` : "",
  ].filter(Boolean).join("\n");

  const html = buildNotificationEmail({
    title: "Sesiones del mes",
    preheader: "Revisá tus sesiones disponibles antes del cierre del mes",
    icon: "!",
    innerHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(name)}</b>,<br/>Te compartimos el estado de tus sesiones disponibles para <b>${escapeHtml(monthLabel)}</b>.`,
        { fontSize: 14, lineHeight: 19, weight: 700, maxWidth: 320, marginBottom: 14 }
      )}

      ${renderCreditsPanel(summary)}

      ${renderExactBodyText(
        `Recordá que las sesiones del mes vencen el <b>${escapeHtml(endDate)}</b>, al finalizar el día.`,
        { fontSize: 13, lineHeight: 18, weight: 700, maxWidth: 320, marginTop: 0, marginBottom: 10 }
      )}

      ${BRAND_URL ? renderPrimaryButton(`Ingresar a ${BRAND_NAME}`, BRAND_URL) : ""}
    `,
  });

  await sendMail(to, `Sesiones del mes - ${BRAND_NAME}`, text, html);
}

export async function sendFinalWeekOfMonthEmail(user = {}, meta = {}) {
  const to = String(user?.email || "").trim();
  if (!to) return;

  const name = firstNameOf(user);
  const endDate = formatDateAR(meta?.monthEnd);

  const text = [
    `Hola ${name},`,
    "",
    "Entramos en la última semana del mes.",
    `Las sesiones disponibles de este mes pueden usarse hasta el ${endDate}, al finalizar el día.`,
    "",
    "Si necesitás coordinar algo, escribinos por WhatsApp.",
    BRAND_URL ? `Ingresar: ${BRAND_URL}` : "",
  ].filter(Boolean).join("\n");

  const html = buildNotificationEmail({
    title: "Última semana del mes",
    preheader: "Revisá tus sesiones y coordiná tus turnos",
    icon: "!",
    innerHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(name)}</b>,<br/>Entramos en la <b>última semana del mes</b>.`,
        { fontSize: 14, lineHeight: 19, weight: 700, maxWidth: 320, marginBottom: 14 }
      )}

      ${renderAdminDetailPanel([
        { label: "Cierre del mes", value: endDate },
        { label: "Importante", value: "Revisá tus sesiones y coordiná tus turnos pendientes." },
      ])}

      ${BRAND_URL ? renderPrimaryButton(`Ingresar a ${BRAND_NAME}`, BRAND_URL) : ""}
    `,
  });

  await sendMail(to, `Última semana del mes - ${BRAND_NAME}`, text, html);
}

export async function sendMonthEndEmail(user = {}, summary = {}, meta = {}) {
  const to = String(user?.email || "").trim();
  if (!to) return;

  const name = firstNameOf(user);
  const endDate = formatDateAR(meta?.monthEnd);

  const text = [
    `Hola ${name},`,
    "",
    "Hoy finaliza el mes en DUO.",
    `Las sesiones disponibles de este mes vencen hoy (${endDate}) al finalizar el día.`,
    "",
    ...Object.entries(SERVICE_LABELS).map(([key, label]) => `${label} (${key}): ${Math.max(0, Number(summary?.[key] || 0))}`),
    "",
    BRAND_URL ? `Ingresar: ${BRAND_URL}` : "",
  ].filter(Boolean).join("\n");

  const html = buildNotificationEmail({
    title: "Cierre del mes",
    preheader: "Hoy es el último día del mes",
    icon: "!",
    innerHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(name)}</b>,<br/>Hoy finaliza el mes en DUO. Las sesiones disponibles vencen al finalizar el día.`,
        { fontSize: 14, lineHeight: 19, weight: 700, maxWidth: 320, marginBottom: 14 }
      )}

      ${renderCreditsPanel(summary)}

      ${renderAdminDetailPanel([{ label: "Vencimiento", value: endDate }])}

      ${BRAND_URL ? renderPrimaryButton(`Ingresar a ${BRAND_NAME}`, BRAND_URL) : ""}
    `,
  });

  await sendMail(to, `Cierre del mes - ${BRAND_NAME}`, text, html);
}

export async function sendMonthStartFixedSchedulesEmail(user = {}, schedules = [], meta = {}) {
  const to = String(user?.email || "").trim();
  if (!to) return;

  const name = firstNameOf(user);
  const monthLabel = cleanStr(meta?.monthLabel, "este mes");
  const rows = fixedScheduleRows(schedules);

  const text = [
    `Hola ${name},`,
    "",
    `Arranca ${monthLabel} en DUO.`,
    "Tenés turnos fijos asignados. Recordá coordinar la renovación con el equipo para conservar tu regularidad.",
    "",
    rows.length ? "Turnos fijos:" : "",
    ...rows.map((r) => `• ${r.label}: ${r.value}`),
    "",
    BRAND_URL ? `Ingresar: ${BRAND_URL}` : "",
  ].filter(Boolean).join("\n");

  const html = buildNotificationEmail({
    title: "Renovación mensual",
    preheader: "Recordatorio de renovación para tus turnos fijos",
    icon: "✓",
    innerHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(name)}</b>,<br/>Arranca <b>${escapeHtml(monthLabel)}</b> en DUO. Tenés turnos fijos asignados: recordá coordinar la renovación con el equipo para conservar tu regularidad.`,
        { fontSize: 14, lineHeight: 19, weight: 700, maxWidth: 320, marginBottom: 14 }
      )}

      ${rows.length ? renderAdminDetailPanel(rows) : ""}

      ${BRAND_URL ? renderPrimaryButton(`Ingresar a ${BRAND_NAME}`, BRAND_URL) : ""}
    `,
  });

  await sendMail(to, `Renovación mensual - ${BRAND_NAME}`, text, html);
}

export async function sendBirthdayEmail(user = {}) {
  const to = String(user?.email || "").trim();
  if (!to) return;

  const name = firstNameOf(user);
  const text = [
    `Hola ${name},`,
    "",
    `¡Feliz cumpleaños de parte de todo el equipo de ${BRAND_NAME}!`,
    "Que tengas un gran día.",
  ].join("\n");

  const html = buildNotificationEmail({
    title: "¡Feliz cumpleaños!",
    preheader: `Feliz cumpleaños de parte de ${BRAND_NAME}`,
    icon: "✓",
    innerHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(name)}</b>,<br/>¡Feliz cumpleaños de parte de todo el equipo de <b>${escapeHtml(BRAND_NAME)}</b>!`,
        { fontSize: 14, lineHeight: 19, weight: 700, maxWidth: 320, marginBottom: 14 }
      )}

      ${renderExactBodyText(
        "Que tengas un gran día.",
        { fontSize: 13, lineHeight: 18, weight: 700, maxWidth: 320, marginTop: 0, marginBottom: 0 }
      )}
    `,
  });

  await sendMail(to, `¡Feliz cumpleaños! - ${BRAND_NAME}`, text, html);
}

export async function sendAdminBirthdayEmail(user = {}) {
  if (!ADMIN_EMAIL) return;

  const name = fullNameOf(user);
  const email = cleanStr(user?.email);
  const phone = cleanStr(user?.phone);

  const text = [
    `${BRAND_NAME} - Cumpleaños de usuario`,
    "",
    `Hoy cumple años: ${name}`,
    `Email: ${email}`,
    `Teléfono: ${phone}`,
  ].join("\n");

  const html = buildNotificationEmail({
    title: "Cumpleaños de usuario",
    preheader: `${name} cumple años hoy`,
    icon: "✓",
    innerHtml: `
      ${renderAdminMetaPanel([
        { label: "Usuario", value: name },
        { label: "Email", value: email },
      ])}

      ${renderAdminDetailPanel([
        { label: "Teléfono", value: phone },
        { label: "Acción sugerida", value: "Saludar o enviar mensaje desde el equipo DUO." },
      ])}
    `,
  });

  await sendMail(ADMIN_EMAIL, `Cumpleaños de usuario - ${BRAND_NAME}`, text, html);
}
