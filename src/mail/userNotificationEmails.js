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
  renderRowCard,,
  renderUnifiedMailFooter
} from "./ui.js";


const IMG_BASE = "https://api.duoclub.ar/images";



function renderMailHeaderLogo(width = 34) {
  return `<img src="${IMG_BASE}/logo.png" alt="${escapeHtml(BRAND_NAME)}" width="${Number(width) || 34}" style="display:block; margin:0 auto; width:${Number(width) || 34}px; max-width:${Number(width) || 34}px; height:auto; border:0; outline:none; text-decoration:none;" />`;
}

function renderMailCheckIcon(size = 19) {
  return `<img src="${IMG_BASE}/iconocheck.png" alt="" width="${Number(size) || 19}" height="${Number(size) || 19}" style="display:block; width:${Number(size) || 19}px; height:${Number(size) || 19}px; border:0; outline:none; text-decoration:none;" />`;
}

const SERVICE_LABELS = {
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  SYN: "Synergy",
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
      a[x-apple-data-detectors],
      .duo-footer-info a,
      .duo-footer-info a:link,
      .duo-footer-info a:visited,
      .duo-exact-footer a,
      .duo-exact-footer a:link,
      .duo-exact-footer a:visited,
      .ap-footer a,
      .ap-footer a:link,
      .ap-footer a:visited,
      .duo-admin-footer a,
      .duo-admin-footer a:link,
      .duo-admin-footer a:visited,
      .duo-pay-footer a,
      .duo-pay-footer a:link,
      .duo-pay-footer a:visited {
        color:#ffffff !important;
        text-decoration:none !important;
      }
    
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
                    <tr><td style="padding:0 0 14px;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;"><tr><td valign="middle" style="width:24px; padding:0 10px 0 0;"><div style="width:19px; height:19px; border:2px solid #111111; border-radius:999px; font-size:11px; line-height:17px; text-align:center; font-weight:700; color:#111111;">🎂</div></td><td class="duo-admin-heading" valign="middle" style="font-size:24px; line-height:28px; font-weight:750; color:#111111; letter-spacing:-0.6px;">${escapeHtml(heading)}</td></tr></table></td></tr>
                    <tr><td style="padding:0 0 16px;"><div style="height:1px; background:#c9c9c9; width:100%;"></div></td></tr>
                    <tr><td class="duo-admin-copy" style="font-size:14px; line-height:20px; font-weight:400; color:#111111; text-align:left; padding:0 0 18px;">${introHtml}</td></tr>
                    <tr><td>${bodyHtml}</td></tr>
                  </table>
                </td></tr>
                ${renderUnifiedMailFooter({ className: "duo-admin-footer" })}
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


export async function sendCreditsExpiryReminderEmail(user = {}, summary = {}, meta = {}) {
  const to = String(user?.email || "").trim();
  if (!to) return;

  const name = firstNameOf(user);
  const monthLabel = cleanStr(meta?.monthLabel, "este mes");
  const lastUsableDate = formatDateAR(meta?.lastUsableAt || meta?.monthEnd);
  const expiryDate = formatDateAR(meta?.expiryAt);

  const visibleRows = Object.entries(SERVICE_LABELS)
    .map(([key, label]) => ({
      key,
      label,
      value: Math.max(0, Number(summary?.[key] || 0)),
    }))
    .filter((row) => row.value > 0);

  if (!visibleRows.length) return;

  const text = [
    `Hola ${name},`,
    "",
    `Te compartimos las sesiones que todavía tenés disponibles de ${monthLabel}.`,
    "",
    ...visibleRows.map(({ key, label, value }) => `${label} (${key}): ${value}`),
    "",
    `Podés utilizarlas hasta el ${lastUsableDate} inclusive.`,
    `Estas sesiones vencen el ${expiryDate} y no se trasladan al mes siguiente.`,
    "",
    BRAND_URL ? `Ingresar: ${BRAND_URL}` : "",
  ].filter(Boolean).join("\n");

  const html = buildNotificationEmail({
    title: "Tus sesiones están por vencer",
    preheader: "Revisá las sesiones disponibles antes del próximo mes",
    icon: "!",
    innerHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(name)}</b>,<br/>Estas son las sesiones que todavía tenés disponibles de <b>${escapeHtml(monthLabel)}</b>.`,
        { fontSize: 14, lineHeight: 19, weight: 700, maxWidth: 320, marginBottom: 14 }
      )}

      ${renderCreditsPanel(summary)}

      ${renderExactBodyText(
        `Podés utilizarlas hasta el <b>${escapeHtml(lastUsableDate)}</b> inclusive.<br/>Vencen el <b>${escapeHtml(expiryDate)}</b> y no se trasladan al mes siguiente.`,
        { fontSize: 13, lineHeight: 18, weight: 700, maxWidth: 320, marginTop: 0, marginBottom: 10 }
      )}

      ${BRAND_URL ? renderPrimaryButton(`Ingresar a ${BRAND_NAME}`, BRAND_URL) : ""}
    `,
  });

  await sendMail(to, `Tus sesiones están por vencer - ${BRAND_NAME}`, text, html);
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
