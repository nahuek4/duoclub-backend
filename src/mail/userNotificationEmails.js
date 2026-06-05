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


const IMG_BASE = "https://api.duoclub.ar/images";

const SOCIAL_LINKS = {
  instagram: process.env.DUO_INSTAGRAM_URL || "https://www.instagram.com/duoclub.ar/",
  linkedin: process.env.DUO_LINKEDIN_URL || "https://www.linkedin.com/company/duo-club-ar/",
  spotify: process.env.DUO_SPOTIFY_URL || "https://open.spotify.com/",
};


function renderMailHeaderLogo(width = 34) {
  return `<img src="${IMG_BASE}/logo.png" alt="${escapeHtml(BRAND_NAME)}" width="${Number(width) || 34}" style="display:block; margin:0 auto; width:${Number(width) || 34}px; max-width:${Number(width) || 34}px; height:auto; border:0; outline:none; text-decoration:none;" />`;
}

function renderMailCheckIcon(size = 19) {
  return `<img src="${IMG_BASE}/iconocheck.png" alt="" width="${Number(size) || 19}" height="${Number(size) || 19}" style="display:block; width:${Number(size) || 19}px; height:${Number(size) || 19}px; border:0; outline:none; text-decoration:none;" />`;
}

function renderMailFooterBrand(width = 92) {
  return `<img src="${IMG_BASE}/duohealthclub.png" alt="${escapeHtml(BRAND_NAME)} Health Club" width="${Number(width) || 92}" style="display:block; width:${Number(width) || 92}px; max-width:100%; height:auto; border:0; outline:none; text-decoration:none; filter:invert(1);" />`;
}

function renderMailFooterIcons() {
  const icons = [
    { file: "iconoig.png", alt: "Instagram", href: SOCIAL_LINKS.instagram },
    { file: "iconolnkd.png", alt: "LinkedIn", href: SOCIAL_LINKS.linkedin },
    { file: "iconospot.png", alt: "Spotify", href: SOCIAL_LINKS.spotify },
  ];

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin-top:8px; margin-left:auto;">
      <tr>
        ${icons
          .map(
            (icon, idx) => `
              <td style="${idx > 0 ? "padding-left:6px;" : ""}">
                <a
                  href="${escapeHtml(icon.href)}"
                  target="_blank"
                  rel="noopener noreferrer"
                  style="display:inline-block; text-decoration:none; border:0; outline:none;"
                >
                  <img
                    src="${IMG_BASE}/${icon.file}"
                    alt="${escapeHtml(icon.alt)}"
                    width="20"
                    height="20"
                    style="display:block; width:20px; height:20px; border:0; outline:none; text-decoration:none;"
                  />
                </a>
              </td>
            `
          )
          .join("")}
      </tr>
    </table>
  `;
}

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


function buildNotificationAdminVisualEmail({
  title,
  preheader,
  heading,
  introHtml,
  bodyHtml,
}) {
  return buildEmailLayout({
    title: `${BRAND_NAME} · ${title}`,
    preheader,
    footerNote: "",
    bodyHtml: `
      <style>
        @media only screen and (max-width: 560px) {
          .duo-admin-wrap { max-width: 100% !important; }
          .duo-admin-card { border-radius: 0 0 22px 22px !important; }
          .duo-admin-content { padding: 30px 26px 34px !important; }
          .duo-admin-heading { font-size: 22px !important; line-height: 26px !important; }
          .duo-admin-copy { font-size: 14px !important; line-height: 21px !important; }
          .duo-admin-footer { padding: 36px 32px 38px !important; border-radius: 0 0 22px 22px !important; }
          .duo-footer-brand { font-size: 22px !important; line-height: 22px !important; letter-spacing: 6px !important; }
          .duo-footer-info { font-size: 9px !important; line-height: 13px !important; }
        }
      </style>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr><td align="center" style="padding:0;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="duo-admin-wrap" style="max-width:430px; border-collapse:separate; border-spacing:0;">
            <tr><td class="duo-admin-card" style="background:#FBFBFB; border-radius:0 0 28px 28px; overflow:hidden; font-family:Arial, Helvetica, sans-serif; color:#111111;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                <tr><td class="duo-admin-content" style="padding:34px 28px 34px; background:#FBFBFB; color:#111111;">
                  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                    <tr><td align="center" style="padding:0 0 36px;"><div style="font-size:34px; line-height:34px; font-weight:700; color:#0A0A0A; letter-spacing:-3px;">${renderMailHeaderLogo()}</div></td></tr>
                    <tr><td style="padding:0 0 14px;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;"><tr><td valign="middle" style="width:24px; padding:0 10px 0 0;"><div style="width:19px; height:19px; border:2px solid #111111; border-radius:999px; font-size:11px; line-height:17px; text-align:center; font-weight:700; color:#111111;">🎂</div></td><td class="duo-admin-heading" valign="middle" style="font-size:24px; line-height:28px; font-weight:700; color:#111111; letter-spacing:-0.6px;">${escapeHtml(heading)}</td></tr></table></td></tr>
                    <tr><td style="padding:0 0 16px;"><div style="height:1px; background:#c9c9c9; width:100%;"></div></td></tr>
                    <tr><td class="duo-admin-copy" style="font-size:14px; line-height:20px; font-weight:400; color:#111111; text-align:left; padding:0 0 18px;">${introHtml}</td></tr>
                    <tr><td>${bodyHtml}</td></tr>
                  </table>
                </td></tr>
                <tr><td class="duo-admin-footer" style="background:#0A0A0A; padding:40px 48px 42px; border-radius:0 0 28px 28px; font-family:Arial, Helvetica, sans-serif;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;"><tr><td valign="middle" style="width:42%; color:#ffffff;"><div class="duo-footer-brand" style="font-size:23px; line-height:23px; font-weight:700; letter-spacing:7px;">${renderMailFooterBrand()}</div><div style="font-size:4px; line-height:7px; font-weight:700; letter-spacing:1.8px; margin-top:4px; opacity:0.95;"></div></td><td valign="middle" align="right" class="duo-footer-info" style="width:58%; color:#ffffff; font-size:9px; line-height:13px; font-weight:500; letter-spacing:0.2px;"><div style="font-weight:700; letter-spacing:2.8px;">DUOCLUB.AR</div><div>+54 249 420 7343</div><div>Av. Santamaría 54, Tandil.</div><div style="padding-top:6px; font-size:10px; line-height:10px; letter-spacing:4px;">${renderMailFooterIcons()}</div></td></tr></table></td></tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
      </table>
    `,
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
        background:#0A0A0A;
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

  const html = buildNotificationAdminVisualEmail({
    title: "Cumpleaños de usuario",
    preheader: `${name} cumple años hoy`,
    heading: "Cumpleaños de usuario",
    introHtml: `Hoy cumple años <b>${escapeHtml(name)}</b>.`,
    bodyHtml: `
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
