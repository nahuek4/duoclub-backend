// backend/src/mail/ui.js
import { EMAIL_FONT, escapeHtml } from "./helpers.js";

/* =========================================================
   UI kit mail — estilo DUO unificado
========================================================= */

export function renderExactUserShell(innerHtml) {
  return `
    <style>
      @media only screen and (max-width: 560px) {
        .mail-shell { padding:16px 8px 22px !important; }
        .mail-title { font-size:18px !important; line-height:19px !important; margin:0 auto 16px !important; }
        .panel { padding:12px !important; }
        .row-card { padding:9px 10px !important; }
        .row-k { font-size:14px !important; line-height:16px !important; }
        .row-v { font-size:13px !important; line-height:15px !important; }
        .status-icon { width:54px !important; height:54px !important; line-height:54px !important; font-size:34px !important; }
        .btn { padding:12px 14px !important; }
        .btn-wrap { gap:10px !important; }
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
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:430px; border-collapse:separate;">
            <tr>
              <td
                class="mail-shell"
                bgcolor="#ffffff"
                style="
                  background:#ffffff;
                  border-radius:14px;
                  padding:18px 10px 26px;
                  text-align:center;
                  font-family:${EMAIL_FONT};
                  color:#111111;
                "
              >
                ${innerHtml}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

export function renderExactStatusIcon(symbol = "✓") {
  return `
    <div
      class="status-icon"
      style="
        width:58px;
        height:58px;
        margin:0 auto 0;
        border-radius:999px;
        background:#0a0a0a;
        color:#ffffff;
        font-size:38px;
        line-height:58px;
        font-weight:900;
        font-family:${EMAIL_FONT};
        text-align:center;
      "
    >${escapeHtml(symbol)}</div>
  `;
}

export function renderExactTitle(text, maxWidth = 300) {
  return `
    <div
      class="mail-title"
      style="
        font-size:19px;
        line-height:20px;
        font-weight:900;
        margin:0 auto 18px;
        max-width:${Number(maxWidth) || 300}px;
        font-family:${EMAIL_FONT};
        color:#111111;
        white-space:pre-line;
        letter-spacing:-0.2px;
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
        background:#0a0a0a;
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
        font-weight:900;
        color:#e4ff00;
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
        border:1px solid #e4ff00;
        border-radius:8px;
        padding:10px 12px;
        margin:0 0 11px;
        text-align:left;
        background:#0b0b0b;
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
              font-weight:900;
              color:#e4ff00;
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
              font-weight:900;
              color:#e4ff00;
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
          font-weight:900;
          background:#e4ff00;
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
      return { bg: "#e4ff00", fg: "#111111", border: "#e4ff00", radius: "999px" };
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
            font-weight:800;
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
            font-weight:900;
            color:#e4ff00;
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
        background:#0a0a0a;
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
            font-weight:900;
            color:#e4ff00;
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
        background:#0a0a0a;
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
    ${renderExactStatusIcon(icon)}
    ${renderExactTitle(title, 285)}
    ${innerHtml}
  `);

  return {
    bodyHtml,
    preheader: preheader || title,
    title: `${brandName} · ${title}`,
  };
}