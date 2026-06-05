// backend/src/mail/ui.js
import { EMAIL_FONT, escapeHtml } from "./helpers.js";

const IMG_BASE = "https://api.duoclub.ar/images";

const SOCIAL_LINKS = {
  instagram: process.env.DUO_INSTAGRAM_URL || "https://www.instagram.com/duoclub.ar/",
  linkedin: process.env.DUO_LINKEDIN_URL || "https://www.linkedin.com/company/duo-club-ar/",
  spotify: process.env.DUO_SPOTIFY_URL || "https://open.spotify.com/",
};


const DUO_WATERMARK_BG = `background-color:#F4F4F4; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='360' height='420' viewBox='0 0 360 420'%3E%3Ctext x='-8' y='84' font-family='Arial, Helvetica, sans-serif' font-size='86' font-weight='700' fill='%23ffffff' fill-opacity='0.72'%3EDUO%3C/text%3E%3Ctext x='-8' y='214' font-family='Arial, Helvetica, sans-serif' font-size='86' font-weight='700' fill='%23ffffff' fill-opacity='0.72'%3EDUO%3C/text%3E%3Ctext x='-8' y='344' font-family='Arial, Helvetica, sans-serif' font-size='86' font-weight='700' fill='%23ffffff' fill-opacity='0.72'%3EDUO%3C/text%3E%3C/svg%3E"); background-repeat:repeat-y; background-position:center top; background-size:360px auto;`;

/* =========================================================
   UI kit mail — estilo DUO unificado
========================================================= */

export function renderMailFooterSocialIcons({ align = "right", size = 20, gap = 6 } = {}) {
  const safeSize = Number(size) || 20;
  const safeGap = Number(gap) || 6;
  const icons = [
    { file: "iconoig.png", alt: "Instagram", href: SOCIAL_LINKS.instagram },
    { file: "iconolnkd.png", alt: "LinkedIn", href: SOCIAL_LINKS.linkedin },
    { file: "iconospot.png", alt: "Spotify", href: SOCIAL_LINKS.spotify },
  ];

  return `
    <table
      role="presentation"
      cellpadding="0"
      cellspacing="0"
      ${align === "right" ? 'align="right"' : ''}
      style="border-collapse:collapse; margin-top:8px; ${align === "right" ? "margin-left:auto;" : ""}"
    >
      <tr>
        ${icons
          .map(
            (icon, idx) => `
              <td style="${idx > 0 ? `padding-left:${safeGap}px;` : ""}">
                <a
                  href="${escapeHtml(icon.href)}"
                  target="_blank"
                  rel="noopener noreferrer"
                  style="display:inline-block; text-decoration:none; border:0; outline:none;"
                >
                  <img
                    src="${IMG_BASE}/${icon.file}"
                    alt="${escapeHtml(icon.alt)}"
                    width="${safeSize}"
                    height="${safeSize}"
                    style="display:block; width:${safeSize}px; height:${safeSize}px; border:0; outline:none; text-decoration:none;"
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


export function renderExactUserShell(innerHtml) {
  return `
    <style>
      @media only screen and (max-width: 560px) {
        .mail-wrap { max-width:100% !important; }
        .mail-shell { padding:30px 26px 34px !important; border-radius:0 0 22px 22px !important; }
        .mail-logo { padding-bottom:34px !important; }
        .mail-heading { font-size:22px !important; line-height:26px !important; }
        .mail-title { font-size:22px !important; line-height:26px !important; }
        .panel { padding:12px !important; }
        .row-card { padding:9px 10px !important; }
        .row-k { font-size:14px !important; line-height:16px !important; }
        .row-v { font-size:13px !important; line-height:15px !important; }
        .status-icon { width:20px !important; height:20px !important; }
        .btn { padding:12px 16px !important; }
        .duo-exact-footer { padding:36px 32px 38px !important; border-radius:0 0 22px 22px !important; }
        .duo-footer-brand-img { width:92px !important; max-width:92px !important; }
        .duo-footer-info { font-size:9px !important; line-height:13px !important; }
        .admin-meta-stack,
        .admin-meta-stack tbody,
        .admin-meta-stack tr,
        .admin-meta-stack td {
          display:block !important;
          width:100% !important;
        }
        .admin-meta-cell {
          padding:0 0 12px 0 !important;
        }
        .admin-meta-cell:last-child {
          padding:0 !important;
        }
      }
    </style>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
      <tr>
        <td align="center" style="padding:0;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="mail-wrap" style="max-width:430px; border-collapse:separate; border-spacing:0;">
            <tr>
              <td style="background:#F4F4F4; border-radius:0 0 28px 28px; overflow:hidden; font-family:${EMAIL_FONT}; color:#111111;">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                  <tr>
                    <td
                      class="mail-shell"
                      bgcolor="#ffffff"
                      style="
                        ${DUO_WATERMARK_BG}
                        padding:34px 36px 36px;
                        text-align:left;
                        font-family:${EMAIL_FONT};
                        color:#111111;
                      "
                    >
                      ${innerHtml}
                    </td>
                  </tr>
                  <tr>
                    <td class="duo-exact-footer" style="background:#0A0A0A; padding:40px 48px 42px; border-radius:0 0 28px 28px; font-family:${EMAIL_FONT};">
                      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                        <tr>
                          <td valign="middle" style="width:42%; color:#ffffff; font-family:${EMAIL_FONT};">
                            <img src="${IMG_BASE}/duohealthclub.png" alt="DUO Health Club" width="92" class="duo-footer-brand-img" style="display:block; width:92px; max-width:92px; height:auto; border:0; outline:none; text-decoration:none; filter:invert(1);" />
                          </td>
                          <td valign="middle" align="right" class="duo-footer-info" style="width:58%; color:#ffffff; font-family:${EMAIL_FONT}; font-size:9px; line-height:13px; font-weight:500; letter-spacing:0.2px;">
                            <div style="font-weight:700; letter-spacing:2.8px;">DUOCLUB.AR</div>
                            <div>+54 249 420 7343</div>
                            <div>Av. Santamaría 54, Tandil.</div>
                            ${renderMailFooterSocialIcons({ align: "right", size: 20 })}
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

function renderExactHeaderLogo(width = 34) {
  return `
    <tr>
      <td class="mail-logo" align="center" style="padding:0 0 36px;">
        <img src="${IMG_BASE}/logo.png" alt="DUO" width="${Number(width) || 34}" style="display:block; margin:0 auto; width:${Number(width) || 34}px; max-width:${Number(width) || 34}px; height:auto; border:0; outline:none; text-decoration:none; filter:invert(1);" />
      </td>
    </tr>
  `;
}

export function renderExactStatusIcon(symbol = "✓") {
  const normalized = String(symbol || "").trim().toLowerCase();

  const iconMap = {
    "account-approved": {
      src: `${IMG_BASE}/iconoCuentaAprobada.png`,
      alt: "Cuenta aprobada",
      size: 28,
    },
    "cuenta-aprobada": {
      src: `${IMG_BASE}/iconoCuentaAprobada.png`,
      alt: "Cuenta aprobada",
      size: 28,
    },
    "alta-aprobada": {
      src: `${IMG_BASE}/iconoCuentaAprobada.png`,
      alt: "Alta aprobada",
      size: 28,
    },

    "sesiones-actualizadas": {
      src: `${IMG_BASE}/sesionesActualizas.png`,
      alt: "Sesiones actualizadas",
      size: 28,
    },
    "creditos-actualizados": {
      src: `${IMG_BASE}/sesionesActualizas.png`,
      alt: "Créditos actualizados",
      size: 28,
    },

    "pago-aprobado": {
      src: `${IMG_BASE}/pagoAprobado.png`,
      alt: "Pago aprobado",
      size: 28,
    },
    "payment-approved": {
      src: `${IMG_BASE}/pagoAprobado.png`,
      alt: "Pago aprobado",
      size: 28,
    },

    "pedido-aprobado": {
      src: `${IMG_BASE}/pedidoAprobado.png`,
      alt: "Pedido aprobado",
      size: 28,
    },
    "pedido-generado": {
      src: `${IMG_BASE}/pedidoAprobado.png`,
      alt: "Pedido generado",
      size: 28,
    },
    "order-approved": {
      src: `${IMG_BASE}/pedidoAprobado.png`,
      alt: "Pedido aprobado",
      size: 28,
    },
  };

  const selected = iconMap[normalized] || {
    src: `${IMG_BASE}/iconocheck.png`,
    alt: symbol,
    size: 19,
  };

  return `
    <img
      class="status-icon"
      src="${selected.src}"
      width="${selected.size}"
      height="${selected.size}"
      alt="${escapeHtml(selected.alt)}"
      style="display:block; width:${selected.size}px; height:${selected.size}px; border:0; outline:none; text-decoration:none;"
    />
  `;
}

export function renderExactTitle(text, maxWidth = 300) {
  return `
    <div
      class="mail-title"
      style="
        font-size:24px;
        line-height:28px;
        font-weight:700;
        margin:0;
        max-width:${Number(maxWidth) || 300}px;
        font-family:${EMAIL_FONT};
        color:#111111;
        white-space:pre-line;
        letter-spacing:-0.6px;
        text-align:left;
      "
    >
      ${escapeHtml(text)}
    </div>
  `;
}

export function renderExactBodyText(html, opts = {}) {
  const fontSize = opts?.fontSize || 14;
  const lineHeight = opts?.lineHeight || 19;
  const weight = opts?.weight || 700;
  const maxWidth = opts?.maxWidth || 320;
  const marginTop = opts?.marginTop ?? 0;
  const marginBottom = opts?.marginBottom ?? 0;
  const color = opts?.color || "#111111";
  const textAlign = opts?.textAlign || "center";

  return `
    <div style="
      font-size:${fontSize}px;
      line-height:${lineHeight}px;
      font-weight:${weight};
      max-width:${maxWidth}px;
      margin:${marginTop}px auto ${marginBottom}px;
      font-family:${EMAIL_FONT};
      color:${color};
      white-space:pre-line;
      text-align:${textAlign};
    ">
      ${html}
    </div>
  `;
}

export function panelOpen() {
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
  `;
}

export function panelClose() {
  return `</div>`;
}

export function panelRow(label, valueHtml) {
  return `
    <div style="margin:0 0 10px; text-align:left;">
      <div style="
        font-family:${EMAIL_FONT};
        font-size:12px;
        line-height:14px;
        font-weight:700;
        color:#E4FF00;
        text-transform:uppercase;
        letter-spacing:0.2px;
        margin-bottom:4px;
      ">${escapeHtml(label)}</div>
      <div style="
        font-family:${EMAIL_FONT};
        font-size:14px;
        line-height:18px;
        font-weight:700;
        color:#ffffff;
        word-break:break-word;
      ">${valueHtml}</div>
    </div>
  `;
}

export function renderRowCard({ titleLeft, titleRight = "", subtitle = "" }) {
  return `
    <div
      class="row-card"
      style="
        border:1px solid #E4FF00;
        border-radius:8px;
        padding:10px 12px;
        margin:0 0 11px;
        text-align:left;
        background:#0A0A0A;
      "
    >
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr>
          <td
            class="row-k"
            style="
              font-family:${EMAIL_FONT};
              font-size:15px;
              line-height:17px;
              font-weight:700;
              color:#E4FF00;
              padding:0;
            "
          >
            ${escapeHtml(titleLeft)}
          </td>
          <td
            align="right"
            class="row-k"
            style="
              font-family:${EMAIL_FONT};
              font-size:15px;
              line-height:17px;
              font-weight:700;
              color:#E4FF00;
              padding:0;
              white-space:nowrap;
            "
          >
            ${escapeHtml(titleRight)}
          </td>
        </tr>
        ${
          subtitle
            ? `
        <tr>
          <td
            colspan="2"
            class="row-v"
            style="
              padding-top:4px;
              font-family:${EMAIL_FONT};
              font-size:14px;
              line-height:16px;
              font-weight:700;
              color:#ffffff;
            "
          >
            ${subtitle}
          </td>
        </tr>`
            : ""
        }
      </table>
    </div>
  `;
}

export function renderPrimaryButton(label, href) {
  if (!label || !href) return "";

  return `
    <div style="margin:18px 0 6px; text-align:center;">
      <a
        class="btn"
        href="${escapeHtml(href)}"
        style="
          display:inline-block;
          text-decoration:none;
          padding:12px 18px;
          border-radius:999px;
          font-family:${EMAIL_FONT};
          font-size:14px;
          line-height:14px;
          font-weight:700;
          background:#E4FF00;
          color:#111111;
          border:0;
        "
      >${escapeHtml(label)}</a>
    </div>
  `;
}

export function renderExactButtons(buttons = []) {
  const safe = (Array.isArray(buttons) ? buttons : []).filter(
    (b) => b?.label && b?.href
  );
  if (!safe.length) return "";

  const mapVariant = (variant) => {
    if (variant === "primary")
      return { bg: "#E4FF00", fg: "#111111", border: "#E4FF00", radius: "999px" };
    if (variant === "danger")
      return { bg: "#dc3545", fg: "#ffffff", border: "#dc3545", radius: "12px" };
    if (variant === "outline")
      return { bg: "#ffffff", fg: "#111111", border: "#111111", radius: "12px" };

    return { bg: "#111111", fg: "#ffffff", border: "#111111", radius: "12px" };
  };

  const btns = safe
    .map((b) => {
      const c = mapVariant(b.variant);
      return `
        <a
          class="btn"
          href="${escapeHtml(b.href)}"
          style="
            display:inline-block;
            text-decoration:none;
            padding:12px 16px;
            border-radius:${c.radius};
            font-family:${EMAIL_FONT};
            font-size:14px;
            line-height:14px;
            font-weight:700;
            background:${c.bg};
            color:${c.fg};
            border:1px solid ${c.border};
          "
        >${escapeHtml(b.label)}</a>
      `;
    })
    .join("");

  return `
    <div class="btn-wrap" style="margin:16px 0 6px; display:flex; gap:12px; flex-wrap:wrap; justify-content:center;">
      ${btns}
    </div>
  `;
}

export function renderLinksFallback(links = []) {
  const safe = (Array.isArray(links) ? links : []).filter((x) => x?.href);
  if (!safe.length) return "";

  const items = safe
    .map(
      (x) => `
      <div style="word-break:break-all; margin-top:6px;">
        <a href="${escapeHtml(x.href)}" style="color:#111111; text-decoration:underline;">${escapeHtml(x.href)}</a>
      </div>`
    )
    .join("");

  return renderExactBodyText(
    `Si los botones no funcionan, copiá y pegá estos links:<br/>${items}`,
    {
      fontSize: 12,
      lineHeight: 17,
      weight: 600,
      maxWidth: 330,
      marginTop: 10,
      marginBottom: 0,
    }
  );
}

export function renderAdminMetaPanel(rows = []) {
  const validRows = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && r.label && r.value
  );

  if (!validRows.length) return "";

  const widthPct = Math.max(1, Math.floor(100 / validRows.length));

  const cells = validRows
    .map(
      (row, idx) => `
        <td
          valign="top"
          width="${widthPct}%"
          class="admin-meta-cell"
          style="
            width:${widthPct}%;
            padding:${idx === validRows.length - 1 ? "0 0 0 8px" : "0 8px 0 0"};
            text-align:left;
            vertical-align:top;
          "
        >
          <div style="
            font-family:${EMAIL_FONT};
            font-size:12px;
            line-height:14px;
            font-weight:700;
            color:#E4FF00;
            text-transform:uppercase;
            letter-spacing:0.2px;
            margin-bottom:6px;
          ">
            ${escapeHtml(row.label)}
          </div>

          <div style="
            font-family:${EMAIL_FONT};
            font-size:14px;
            line-height:18px;
            font-weight:700;
            color:#ffffff;
            word-break:break-word;
          ">
            ${escapeHtml(row.value)}
          </div>
        </td>
      `
    )
    .join("");

  return `
    <div
      class="admin-panel"
      style="
        background:#0A0A0A;
        border-radius:6px;
        padding:14px;
        margin:0 auto 22px;
        max-width:100%;
        text-align:left;
      "
    >
      <table
        role="presentation"
        cellpadding="0"
        cellspacing="0"
        width="100%"
        class="admin-meta-stack"
        style="border-collapse:collapse;"
      >
        <tr>
          ${cells}
        </tr>
      </table>
    </div>
  `;
}

export function renderAdminDetailPanel(rows = []) {
  const validRows = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && r.label && r.value
  );

  if (!validRows.length) return "";

  const items = validRows
    .map(
      (row, idx) => `
        <div style="margin:0 0 ${idx === validRows.length - 1 ? 0 : 10}px; text-align:left;">
          <div style="
            font-family:${EMAIL_FONT};
            font-size:12px;
            line-height:14px;
            font-weight:700;
            color:#E4FF00;
            text-transform:uppercase;
            letter-spacing:0.2px;
            margin-bottom:4px;
          ">
            ${escapeHtml(row.label)}
          </div>
          <div style="
            font-family:${EMAIL_FONT};
            font-size:14px;
            line-height:18px;
            font-weight:700;
            color:#ffffff;
            word-break:break-word;
          ">
            ${escapeHtml(row.value)}
          </div>
        </div>
      `
    )
    .join("");

  return `
    <div
      class="admin-panel"
      style="
        background:#0A0A0A;
        border-radius:6px;
        padding:14px;
        margin:0 auto 22px;
        max-width:100%;
        text-align:left;
      "
    >
      ${items}
    </div>
  `;
}

export function renderExactReminderBellIcon() {
  return `
    <div style="margin:0 auto 6px; text-align:center;">
      <svg
        class="reminder-bell"
        width="70"
        height="70"
        viewBox="0 0 96 96"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="Recordatorio"
        style="display:block; margin:0 auto;"
      >
        <path d="M18 26 C10 32,10 44,18 50" fill="none" stroke="#111" stroke-width="6" stroke-linecap="round"/>
        <path d="M26 20 C14 30,14 46,26 56" fill="none" stroke="#111" stroke-width="6" stroke-linecap="round"/>
        <path d="M78 26 C86 32,86 44,78 50" fill="none" stroke="#111" stroke-width="6" stroke-linecap="round"/>
        <path d="M70 20 C82 30,82 46,70 56" fill="none" stroke="#111" stroke-width="6" stroke-linecap="round"/>

        <path
          d="M48 16
             C35 16 26 26 26 40
             V56
             L20 62
             V66
             H76
             V62
             L70 56
             V40
             C70 26 61 16 48 16 Z"
          fill="none"
          stroke="#111"
          stroke-width="6"
          stroke-linejoin="round"
        />

        <path
          d="M40 70 C40 76 44 80 48 80 C52 80 56 76 56 70"
          fill="none"
          stroke="#111"
          stroke-width="6"
          stroke-linecap="round"
        />

        <circle cx="70" cy="66" r="14" fill="#fff" stroke="#111" stroke-width="6"/>
        <path d="M70 58 V66 L76 70" fill="none" stroke="#111" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </div>
  `;
}

/** Builder base para cualquier mail DUO */
export function buildExactMail({
  brandName,
  title,
  preheader,
  icon = "✓",
  innerHtml,
}) {
  const bodyHtml = renderExactUserShell(`
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
      ${renderExactHeaderLogo()}
      <tr>
        <td style="padding:0 0 14px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
            <tr>
              <td valign="middle" style="width:24px; padding:0 10px 0 0;">
                ${renderExactStatusIcon(icon)}
              </td>
              <td valign="middle" class="mail-heading">
                ${renderExactTitle(title, 285)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:0 0 16px;">
          <div style="height:1px; background:#c9c9c9; width:100%;"></div>
        </td>
      </tr>
      <tr>
        <td style="padding:0;">
          ${innerHtml}
        </td>
      </tr>
    </table>
  `);

  return {
    bodyHtml,
    preheader: preheader || title,
    title: `${brandName} · ${title}`,
  };
}
