// backend/src/mail/ui.js
import { EMAIL_FONT, escapeHtml } from "./helpers.js";

/* =========================================================
   UI kit mail — estilo DUO (1:1 turnos)
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

  return `
    <div style="
      font-size:${fontSize}px;
      line-height:${lineHeight}px;
      font-weight:${weight};
      max-width:${maxWidth}px;
      margin:${marginTop}px auto ${marginBottom}px;
      font-family:${EMAIL_FONT};
      color:#111111;
      white-space:pre-line;
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

export function renderExactButtons(buttons = []) {
  const safe = (Array.isArray(buttons) ? buttons : []).filter(
    (b) => b?.label && b?.href
  );
  if (!safe.length) return "";

  const mapVariant = (variant) => {
    if (variant === "danger") return { bg: "#dc3545", fg: "#ffffff" };
    if (variant === "outline")
      return { bg: "#ffffff", fg: "#111111", border: "#111111" };
    return { bg: "#111111", fg: "#ffffff" };
  };

  const btns = safe
    .map((b) => {
      const c = mapVariant(b.variant);
      const border = c.border ? `border:1px solid ${c.border};` : "border:0;";
      return `
        <a
          class="btn"
          href="${escapeHtml(b.href)}"
          style="
            display:inline-block;
            text-decoration:none;
            padding:12px 16px;
            border-radius:12px;
            font-family:${EMAIL_FONT};
            font-weight:800;
            background:${c.bg};
            color:${c.fg};
            ${border}
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

/** Builder base para cualquier mail DUO */
export function buildExactMail({ brandName, title, preheader, icon = "✓", innerHtml }) {
  const bodyHtml = renderExactUserShell(`
    ${renderExactStatusIcon(icon)}
    ${renderExactTitle(title, 285)}
    ${innerHtml}
  `);

  return { bodyHtml, preheader: preheader || title, title: `${brandName} · ${title}` };
}