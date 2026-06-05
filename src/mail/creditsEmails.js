// backend/src/mail/creditsEmails.js
import { ADMIN_EMAIL, BRAND_NAME, sendMail } from "./core.js";
import { escapeHtml } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";
import {
  buildExactMail,
  renderExactBodyText,
  renderAdminMetaPanel,
  renderAdminDetailPanel,
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


/* =========================================================
   HELPERS
========================================================= */

function cleanStr(v, fallback = "-") {
  const s = String(v ?? "").trim();
  return s ? s : fallback;
}

function fullNameOf(user = {}) {
  const name = String(user?.name || "").trim();
  const lastName = String(user?.lastName || "").trim();
  const fullName = `${name} ${lastName}`.trim();

  return (
    fullName ||
    String(user?.fullName || "").trim() ||
    String(user?.email || "").trim() ||
    "Usuario"
  );
}

function normalizeItems(items = []) {
  const list = Array.isArray(items) ? items : [];

  return list
    .map((it) => {
      const serviceKey = String(it?.serviceKey || "")
        .trim()
        .toUpperCase();

      const hasDelta = it?.delta !== undefined && it?.delta !== null;
      const raw = hasDelta ? Number(it.delta) : Number(it.credits);

      if (!serviceKey || !Number.isFinite(raw) || raw === 0) return null;

      return {
        serviceKey,
        mode: hasDelta ? "delta" : "set",
        value: Math.trunc(raw),
      };
    })
    .filter(Boolean);
}

function serviceLabel(key) {
  const k = String(key || "").toUpperCase().trim();

  if (k === "EP") return "Entrenamiento Personal";
  if (k === "RF") return "Reeducación Funcional";
  if (k === "RA") return "Rehabilitación Activa";
  if (k === "NUT") return "Nutrición";
  if (k === "PE") return "Primera evaluación presencial";

  return k || "-";
}

function formatChange(it) {
  if (!it) return "-";

  if (it.mode === "delta") {
    const n = Number(it.value || 0);
    const sign = n > 0 ? "+" : "";
    return `${sign}${n}`;
  }

  return `Saldo fijado en ${Number(it.value || 0)}`;
}

function itemsTextLines(items = []) {
  if (!items.length) return ["-"];

  return items.map(
    (it) => `• ${serviceLabel(it.serviceKey)} (${it.serviceKey}): ${formatChange(it)}`
  );
}

function renderCreditsChangesPanel(items = []) {
  const list = Array.isArray(items) ? items : [];

  const rows = list.length
    ? list
        .map((it) => {
          const left = `${serviceLabel(it.serviceKey)} · ${it.serviceKey}`;
          const right = formatChange(it);

          return renderRowCard({
            titleLeft: left,
            titleRight: right,
            subtitle: "",
          });
        })
        .join("")
    : `
      <div
        style="
          font-size:14px;
          line-height:18px;
          font-weight:700;
          color:#ffffff;
          text-align:left;
        "
      >
        Sin cambios para mostrar.
      </div>
    `;

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
      ${rows}
    </div>
  `;
}

function buildCreditsEmail({
  title,
  preheader,
  icon = "✓",
  innerHtml,
}) {
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


function buildCreditsAdminVisualEmail({
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
                <tr>
                  <td class="duo-admin-content" style="padding:34px 28px 34px; background:#FBFBFB; color:#111111;">
                    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                      <tr><td align="center" style="padding:0 0 36px;">${renderMailHeaderLogo()}</td></tr>
                      <tr>
                        <td style="padding:0 0 14px;">
                          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
                            <tr>
                              <td valign="middle" style="width:24px; padding:0 10px 0 0;"><img src="https://api.duoclub.ar/images/sesionesActualizas.png" alt="Sesiones actualizadas" width="28" height="28" style="display:block; width:28px; height:28px; border:0; outline:none; text-decoration:none;" /></td>
                              <td class="duo-admin-heading" valign="middle" style="font-size:24px; line-height:28px; font-weight:700; color:#111111; letter-spacing:-0.6px;">${escapeHtml(heading)}</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      <tr><td style="padding:0 0 16px;"><div style="height:1px; background:#c9c9c9; width:100%;"></div></td></tr>
                      <tr><td class="duo-admin-copy" style="font-size:14px; line-height:20px; font-weight:400; color:#111111; text-align:left; padding:0 0 18px;">${introHtml}</td></tr>
                      <tr><td>${bodyHtml}</td></tr>
                    </table>
                  </td>
                </tr>
                <tr><td class="duo-admin-footer" style="background:#050505; padding:40px 48px 42px; border-radius:0 0 28px 28px; font-family:Arial, Helvetica, sans-serif;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;"><tr><td valign="middle" style="width:42%; color:#ffffff;">${renderMailFooterBrand()}</td><td valign="middle" align="right" class="duo-footer-info" style="width:58%; color:#ffffff; font-size:9px; line-height:13px; font-weight:500; letter-spacing:0.2px;"><div style="font-weight:700; letter-spacing:2.8px;">DUOCLUB.AR</div><div>+54 249 420 7343</div><div>Av. Santamaría 54, Tandil.</div><div style="padding-top:6px;">${renderMailFooterIcons()}</div></td></tr></table></td></tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
      </table>
    `,
  });
}

/* =========================================================
   USER — CAMBIO DE CRÉDITOS
========================================================= */

export async function sendCreditsChangedEmail(user = {}, items = [], meta = {}) {
  const to = String(user?.email || "").trim();
  if (!to) return;

  const normalized = normalizeItems(items);
  if (!normalized.length) return;

  const uName = fullNameOf(user);
  const reason = String(meta?.reason || "").trim();
  const actorName = String(meta?.actorName || "").trim();
  const actorLabel = actorName || "Staff DUO";

  const subject = `Tus créditos fueron actualizados - ${BRAND_NAME}`;

  const text = [
    `Hola ${uName},`,
    "",
    "Actualizamos el saldo de créditos de tu cuenta.",
    "",
    "Detalle de cambios:",
    ...itemsTextLines(normalized),
    "",
    reason ? `Motivo: ${reason}` : "",
    `Gestionado por: ${actorLabel}`,
    "",
    "Podés ingresar a tu cuenta para ver el saldo actualizado.",
  ]
    .filter(Boolean)
    .join("\n");

  const detailRows = [
    { label: "Gestionado por", value: actorLabel },
    ...(reason ? [{ label: "Motivo", value: reason }] : []),
  ];

  const html = buildCreditsEmail({
    title: "Créditos actualizados",
    preheader: "Actualizamos el saldo de créditos de tu cuenta",
    icon: "sesiones-actualizadas",
    innerHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(uName)}</b>,<br/>Actualizamos el saldo de créditos de tu cuenta.`,
        {
          fontSize: 14,
          lineHeight: 19,
          weight: 700,
          maxWidth: 320,
          marginBottom: 14,
        }
      )}

      ${renderCreditsChangesPanel(normalized)}

      ${renderAdminDetailPanel(detailRows)}

      ${renderExactBodyText(
        "Ingresá a DUO para revisar el detalle actualizado en tu cuenta.",
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

  await sendMail(to, subject, text, html);
}

/* =========================================================
   ADMIN — CAMBIO DE CRÉDITOS
========================================================= */

export async function sendAdminCreditsChangedEmail(
  user = {},
  items = [],
  meta = {}
) {
  const to = String(ADMIN_EMAIL || "").trim();
  if (!to) return;

  const normalized = normalizeItems(items);
  if (!normalized.length) return;

  const uName = fullNameOf(user);
  const uEmail = cleanStr(user?.email);
  const reason = String(meta?.reason || "").trim();
  const actorName = String(meta?.actorName || "").trim();
  const actorLabel = actorName || "Staff DUO";

  const subject = `Créditos actualizados — ${uName}`;

  const text = [
    "Se actualizó el saldo de créditos de un usuario.",
    "",
    `Usuario: ${uName}`,
    `Email: ${uEmail}`,
    "",
    "Detalle de cambios:",
    ...itemsTextLines(normalized),
    "",
    reason ? `Motivo: ${reason}` : "",
    `Gestionado por: ${actorLabel}`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildCreditsAdminVisualEmail({
    title: "Créditos actualizados",
    preheader: `Se actualizaron créditos de ${uName}`,
    heading: "Créditos actualizados",
    introHtml: `Se actualizó el saldo de créditos de <b>${escapeHtml(uName)}</b>.`,
    bodyHtml: `
      ${renderAdminMetaPanel([
        { label: "Usuario", value: uName },
        { label: "Email", value: uEmail },
      ])}

      ${renderCreditsChangesPanel(normalized)}

      ${renderAdminDetailPanel([
        { label: "Gestionado por", value: actorLabel },
        ...(reason ? [{ label: "Motivo", value: reason }] : []),
      ])}
    `,
  });

  await sendMail(to, subject, text, html);
}

/* =========================================================
   USER — CONSUMO DE CRÉDITO
========================================================= */

export async function sendCreditConsumedEmail(user = {}, payload = {}) {
  const to = String(user?.email || "").trim();
  if (!to) return;

  const uName = fullNameOf(user);
  const serviceKey = cleanStr(payload?.serviceKey, "").toUpperCase();
  const service = serviceLabel(serviceKey);
  const remaining = Number(payload?.remaining);
  const hasRemaining = Number.isFinite(remaining);

  const subject = `Se descontó un crédito de tu cuenta - ${BRAND_NAME}`;

  const text = [
    `Hola ${uName},`,
    "",
    "Se descontó un crédito de tu cuenta.",
    "",
    `Servicio: ${service}`,
    hasRemaining ? `Créditos restantes: ${remaining}` : "",
    "",
    "Podés ingresar a tu cuenta para revisar el saldo actualizado.",
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildCreditsEmail({
    title: "Crédito consumido",
    preheader: "Se descontó un crédito de tu cuenta",
    icon: "✓",
    innerHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(uName)}</b>,<br/>Se descontó un crédito de tu cuenta.`,
        {
          fontSize: 14,
          lineHeight: 19,
          weight: 700,
          maxWidth: 320,
          marginBottom: 14,
        }
      )}

      ${renderCreditsChangesPanel([
        {
          serviceKey,
          mode: "delta",
          value: -1,
        },
      ])}

      ${renderAdminDetailPanel([
        { label: "Servicio", value: service },
        ...(hasRemaining
          ? [{ label: "Créditos restantes", value: String(remaining) }]
          : []),
      ])}
    `,
  });

  await sendMail(to, subject, text, html);
}
/* =========================================================
   ADMIN — RESUMEN SEMANAL DE DEUDAS POR TURNOS FIJOS
========================================================= */
export async function sendAdminFixedScheduleDebtSummaryEmail(rows = [], meta = {}) {
  const to = String(ADMIN_EMAIL || "").trim();
  const list = Array.isArray(rows) ? rows : [];
  if (!to || !list.length) return;

  const serviceName = (key) => {
    const k = String(key || "").toUpperCase().trim();
    if (k === "EP") return "Entrenamiento Personal";
    if (k === "RA") return "Rehabilitación Activa";
    if (k === "RF") return "Reeducación Funcional";
    if (k === "KD") return "Kinefilaxia Deportiva";
    return k || "Servicio";
  };

  const rowLines = list.map((r) => {
    const debt = r?.debt || {};
    const parts = ["EP", "RA", "RF", "KD"]
      .map((k) => ({ key: k, value: Math.max(0, Number(debt?.[k] || 0)) }))
      .filter((x) => x.value > 0)
      .map((x) => `${x.key}: ${x.value}`)
      .join(" · ");
    return `• ${r?.name || "Usuario"} (${r?.email || "-"}) — ${parts}`;
  });

  const subject = `Resumen semanal de sesiones adeudadas - ${BRAND_NAME}`;
  const text = [
    "Resumen semanal de sesiones adeudadas por turnos fijos",
    meta?.monthKey ? `Mes: ${meta.monthKey}` : "",
    "",
    ...rowLines,
  ].filter(Boolean).join("\n");

  const cards = list.map((r) => {
    const debt = r?.debt || {};
    const detail = ["EP", "RA", "RF", "KD"]
      .map((k) => ({ key: k, value: Math.max(0, Number(debt?.[k] || 0)) }))
      .filter((x) => x.value > 0)
      .map((x) => `${serviceName(x.key)} (${x.key}): ${x.value}`)
      .join("<br/>");

    return renderRowCard({
      titleLeft: r?.name || "Usuario",
      titleRight: r?.email || "-",
      subtitle: `<span style="color:#ffffff;">${detail}</span>`,
    });
  }).join("");

  const html = buildCreditsAdminVisualEmail({
    title: "Sesiones adeudadas",
    preheader: "Resumen semanal de sesiones adeudadas por turnos fijos",
    heading: "Sesiones adeudadas",
    introHtml: `Resumen semanal de usuarios con deuda generada por <b>turnos fijos</b>.`,
    bodyHtml: `
      ${renderAdminMetaPanel([
        { label: "Mes", value: meta?.monthKey || "-" },
        { label: "Usuarios", value: String(list.length) },
      ])}
      <div class="panel" style="background:#0a0a0a; border-radius:6px; padding:14px; margin:0 auto 22px; max-width:100%; text-align:left;">
        ${cards}
      </div>
      ${renderExactBodyText(
        "Este mail es automático y sirve para que administración pueda hacer seguimiento de pagos pendientes.",
        { fontSize: 12, lineHeight: 17, weight: 600, maxWidth: 320, marginTop: 8, marginBottom: 0 }
      )}
    `,
  });

  await sendMail(to, subject, text, html);
}
