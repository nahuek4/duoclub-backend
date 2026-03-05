// backend/src/mail/creditsEmails.js
import { ADMIN_EMAIL, BRAND_NAME, sendMail } from "./core.js";
import { EMAIL_FONT, escapeHtml } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";

/* =========================================================
   HELPERS
========================================================= */

function cleanStr(v, fallback = "-") {
  const s = String(v ?? "").trim();
  return s ? s : fallback;
}

function fullNameOf(user = {}) {
  const full =
    `${cleanStr(user?.name, "")} ${cleanStr(user?.lastName, "")}`.trim() ||
    cleanStr(user?.fullName, "") ||
    cleanStr(user?.email, "") ||
    "Usuario";

  return full;
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
  const k = String(key || "").toUpperCase();
  if (k === "EP") return "Entrenamiento Personal";
  if (k === "RF") return "Reeducación Funcional";
  if (k === "RA") return "Rehabilitación Activa";
  if (k === "NUT") return "Nutrición";
  return k || "-";
}

function formatChange(it) {
  if (!it) return "-";

  if (it.mode === "delta") {
    const n = Number(it.value || 0);
    const sign = n > 0 ? "+" : "";
    return `${sign}${n}`;
  }

  return `Fijado en ${Number(it.value || 0)}`;
}

function itemsTextLines(items = []) {
  if (!items.length) return ["-"];
  return items.map(
    (it) => `• ${it.serviceKey} (${serviceLabel(it.serviceKey)}): ${formatChange(it)}`
  );
}

/* =========================================================
   UI (MISMO LOOK QUE TURNOS)
========================================================= */

function renderExactUserShell(innerHtml) {
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

function renderExactStatusIcon(symbol = "✓") {
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

function renderExactTitle(text, maxWidth = 300) {
  return `
    <div
      class="mail-title"
      style="
        font-size:19px;
        line-height:20px;
        font-weight:900;
        margin:0 auto 18px;
        max-width:${maxWidth}px;
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

function renderExactBodyText(html, opts = {}) {
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

function renderPanelOpen() {
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
function renderPanelClose() {
  return `</div>`;
}

function renderRowCard({ titleLeft, titleRight = "", subtitle = "" }) {
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

function renderCreditsChangesPanel(items = []) {
  const list = Array.isArray(items) ? items : [];
  const rows = list.length
    ? list
        .map((it) => {
          const left = `${it.serviceKey} · ${serviceLabel(it.serviceKey)}`;
          const right = formatChange(it);
          return renderRowCard({
            titleLeft: left,
            titleRight: right,
            subtitle: "", // opcional
          });
        })
        .join("")
    : renderExactBodyText("Sin cambios para mostrar.", {
        fontSize: 14,
        lineHeight: 18,
        weight: 700,
        maxWidth: 320,
        marginBottom: 0,
      });

  return `${renderPanelOpen()}${rows}${renderPanelClose()}`;
}

function renderAdminMetaPanel({ fullName, email, phone, actorName }) {
  const parts = [
    renderExactBodyText(
      `
      <div style="text-align:left;">
        <div style="font-family:${EMAIL_FONT}; font-size:12px; line-height:14px; font-weight:900; color:#e4ff00; text-transform:uppercase; letter-spacing:0.2px; margin-bottom:6px;">
          Usuario
        </div>
        <div style="font-family:${EMAIL_FONT}; font-size:14px; line-height:18px; font-weight:700; color:#ffffff; word-break:break-word;">
          ${escapeHtml(fullName)}
        </div>

        <div style="height:10px;"></div>

        <div style="font-family:${EMAIL_FONT}; font-size:12px; line-height:14px; font-weight:900; color:#e4ff00; text-transform:uppercase; letter-spacing:0.2px; margin-bottom:6px;">
          Email
        </div>
        <div style="font-family:${EMAIL_FONT}; font-size:14px; line-height:18px; font-weight:700; color:#ffffff; word-break:break-word;">
          ${escapeHtml(email)}
        </div>

        <div style="height:10px;"></div>

        <div style="font-family:${EMAIL_FONT}; font-size:12px; line-height:14px; font-weight:900; color:#e4ff00; text-transform:uppercase; letter-spacing:0.2px; margin-bottom:6px;">
          Teléfono
        </div>
        <div style="font-family:${EMAIL_FONT}; font-size:14px; line-height:18px; font-weight:700; color:#ffffff; word-break:break-word;">
          ${escapeHtml(phone)}
        </div>

        ${
          actorName
            ? `
          <div style="height:10px;"></div>

          <div style="font-family:${EMAIL_FONT}; font-size:12px; line-height:14px; font-weight:900; color:#e4ff00; text-transform:uppercase; letter-spacing:0.2px; margin-bottom:6px;">
            Gestionado por
          </div>
          <div style="font-family:${EMAIL_FONT}; font-size:14px; line-height:18px; font-weight:700; color:#ffffff; word-break:break-word;">
            ${escapeHtml(actorName)}
          </div>
          `
            : ""
        }
      </div>
      `,
      { fontSize: 14, lineHeight: 18, weight: 700, maxWidth: 999, marginBottom: 0 }
    ),
  ].join("");

  return `${renderPanelOpen()}${parts}${renderPanelClose()}`;
}

function buildExactCreditsUserHtml({ fullName, items = [], actorName = "" }) {
  const innerHtml = `
    ${renderExactStatusIcon("✓")}
    ${renderExactTitle("Sesiones actualizadas", 285)}
    ${renderExactBodyText(
      `Hola <b>${escapeHtml(fullName)}</b>, se actualizaron tus sesiones/créditos.`,
      { fontSize: 14, lineHeight: 19, weight: 700, maxWidth: 320, marginBottom: 16 }
    )}
    ${renderCreditsChangesPanel(items)}
    ${
      actorName
        ? renderExactBodyText(
            `Gestionado por: <b>${escapeHtml(actorName)}</b>`,
            { fontSize: 12, lineHeight: 17, weight: 700, maxWidth: 320, marginTop: 0, marginBottom: 0 }
          )
        : ""
    }
  `;

  return buildEmailLayout({
    title: `${BRAND_NAME} · Sesiones actualizadas`,
    preheader: "Actualizamos tus sesiones",
    bodyHtml: renderExactUserShell(innerHtml),
    footerNote: "",
  });
}

function buildExactCreditsAdminHtml({
  fullName,
  email,
  phone,
  items = [],
  actorName = "",
}) {
  const innerHtml = `
    ${renderExactStatusIcon("✓")}
    ${renderExactTitle("Créditos actualizados", 285)}
    ${renderAdminMetaPanel({ fullName, email, phone, actorName })}
    ${renderCreditsChangesPanel(items)}
  `;

  return buildEmailLayout({
    title: `${BRAND_NAME} · Créditos actualizados`,
    preheader: `Se actualizaron créditos de ${fullName}`,
    bodyHtml: renderExactUserShell(innerHtml),
    footerNote: "",
  });
}

/* =========================================================
   USER MAIL
========================================================= */

export async function sendUserCreditsAssignedEmail({
  user = null,
  items = [],
  actorName = "",
} = {}) {
  const to = cleanStr(user?.email, "").trim();
  if (!to) return;

  const fullName = fullNameOf(user);
  const safeItems = normalizeItems(items);
  if (!safeItems.length) return;

  const subject = `🎟️ Actualizamos tus sesiones - ${BRAND_NAME}`;

  const text = [
    `Hola ${fullName},`,
    "",
    "Te informamos que se actualizaron tus sesiones/créditos.",
    "",
    ...itemsTextLines(safeItems),
    "",
    actorName ? `Gestionado por: ${actorName}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildExactCreditsUserHtml({
    fullName,
    items: safeItems,
    actorName,
  });

  await sendMail(to, subject, text, html);
}

/* =========================================================
   ADMIN MAIL
========================================================= */

export async function sendAdminCreditsAssignedEmail({
  user = null,
  items = [],
  actorName = "",
} = {}) {
  const to = cleanStr(ADMIN_EMAIL, "").trim();
  if (!to) return;

  const fullName = fullNameOf(user);
  const userEmail = cleanStr(user?.email);
  const userPhone = cleanStr(user?.phone);
  const safeItems = normalizeItems(items);
  if (!safeItems.length) return;

  const subject = `🧾 Créditos actualizados — ${fullName}`;

  const text = [
    "Se actualizaron sesiones/créditos de un usuario.",
    "",
    `Usuario: ${fullName}`,
    `Email: ${userEmail}`,
    `Teléfono: ${userPhone}`,
    "",
    ...itemsTextLines(safeItems),
    "",
    actorName ? `Gestionado por: ${actorName}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildExactCreditsAdminHtml({
    fullName,
    email: userEmail,
    phone: userPhone,
    items: safeItems,
    actorName,
  });

  await sendMail(to, subject, text, html);
}