// backend/src/mail/authEmails.js
import { ADMIN_EMAIL, BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { EMAIL_FONT, escapeHtml, kvRow } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";

/* =========================================================
   ✅ AUTH EMAILS — MISMO ESTILO EXACTO (1:1 con turnos)
========================================================= */

/* =========================================================
   SHELL / UI helpers (idénticos a turnos)
========================================================= */

function renderExactUserShell(innerHtml) {
  return `
    <style>
      @media only screen and (max-width: 560px) {
        .mail-shell { padding:16px 8px 22px !important; }
        .mail-title { font-size:18px !important; line-height:19px !important; margin:0 auto 16px !important; }
        .panel { padding:12px !important; }
        .btn { padding:12px 14px !important; }
        .btn-wrap { gap:10px !important; }
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

function renderExactPanel(innerHtml) {
  return `
    <div
      class="panel"
      style="
        background:#0a0a0a;
        border-radius:6px;
        padding:14px;
        margin:0 auto 18px;
        max-width:100%;
        text-align:left;
      "
    >
      ${innerHtml}
    </div>
  `;
}

/** Row style del panel negro (label amarillo + value blanco) */
function panelRow(label, value) {
  return `
    <div style="margin:0 0 10px;">
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
      ">${value}</div>
    </div>
  `;
}

function renderExactButtons(buttons = []) {
  // buttons: [{label, href, variant}]
  const safe = (Array.isArray(buttons) ? buttons : []).filter(
    (b) => b?.label && b?.href
  );
  if (!safe.length) return "";

  const mapVariant = (variant) => {
    if (variant === "danger") return { bg: "#dc3545", fg: "#ffffff" };
    if (variant === "outline") return { bg: "#ffffff", fg: "#111111", border: "#111111" };
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

function renderLinksFallback(links = []) {
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
    { fontSize: 12, lineHeight: 17, weight: 600, maxWidth: 330, marginTop: 10, marginBottom: 0 }
  );
}

/* =========================================================
   EMAIL BUILDERS (misma estructura)
========================================================= */

function buildExactAuthEmail({ title, icon = "✓", innerHtml, preheader }) {
  const bodyHtml = renderExactUserShell(`
    ${renderExactStatusIcon(icon)}
    ${renderExactTitle(title, 285)}
    ${innerHtml}
  `);

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${title}`,
    preheader: preheader || title,
    bodyHtml,
    footerNote: "",
  });
}

/* =========================================================
   1) VERIFY EMAIL
========================================================= */

export async function sendVerifyEmail(user, verifyUrl) {
  if (!user?.email) return;

  const uName = user?.name || "";

  const textLines = [
    `Hola ${uName}`.trim() + ",",
    "",
    `Gracias por registrarte en ${BRAND_NAME}.`,
    "",
    "Para continuar, verificá tu email en este link (si no abre, copiá y pegá en el navegador):",
    "",
    verifyUrl,
    "",
    "Este link vence en 24 horas.",
    "",
    "Si vos no creaste esta cuenta, podés ignorar este email.",
  ];

  const panel = renderExactPanel(`
    ${panelRow("Estado", `<span style="color:#ffffff;">Pendiente de verificación</span>`)}
    ${panelRow("Vence", `<span style="color:#ffffff;">24 horas</span>`)}
  `);

  const innerHtml = `
    ${renderExactBodyText(
      `Hola <b>${escapeHtml(uName)}</b>,<br/>Para continuar, verificá tu email.`,
      { fontSize: 14, lineHeight: 19, weight: 700, maxWidth: 320, marginBottom: 14 }
    )}
    ${panel}
    ${renderExactButtons([
      { label: "Verificar email", href: verifyUrl, variant: "primary" },
    ])}
    ${renderLinksFallback([{ href: verifyUrl }])}
    ${renderExactBodyText(
      "Si vos no creaste esta cuenta, podés ignorar este email.",
      { fontSize: 12, lineHeight: 17, weight: 600, maxWidth: 320, marginTop: 10, marginBottom: 0 }
    )}
  `;

  const html = buildExactAuthEmail({
    title: "Verificación de email",
    icon: "✓",
    preheader: "Verificá tu email para continuar",
    innerHtml,
  });

  await sendMail(user.email, `Verificá tu email - ${BRAND_NAME}`, textLines.join("\n"), html);
}

/* =========================================================
   2) USER -> REGISTRO RECIBIDO (pendiente)
========================================================= */

export async function sendUserRegistrationReceivedEmail(user) {
  if (!user?.email) return;

  const uName = user?.name || "";

  const lines = [
    `Hola ${uName}`.trim() + ",",
    "",
    `Recibimos tu registro en ${BRAND_NAME}.`,
    "Para poder ingresar:",
    "1) Verificá tu email (si todavía no lo hiciste).",
    "2) Esperá la aprobación del staff.",
    "",
    "Te avisamos por este medio cuando tu cuenta esté aprobada.",
    "",
    BRAND_URL ? `Sitio: ${BRAND_URL}` : "",
  ].filter(Boolean);

  const panel = renderExactPanel(`
    ${panelRow("Estado", `<span style="color:#ffffff;">Pendiente de aprobación</span>`)}
    ${panelRow("Próximo paso", `<span style="color:#ffffff;">Verificar email (si aún no lo hiciste)</span>`)}
  `);

  const innerHtml = `
    ${renderExactBodyText(
      `Hola <b>${escapeHtml(uName)}</b>,<br/>Recibimos tu registro en <b>${escapeHtml(BRAND_NAME)}</b>.`,
      { fontSize: 14, lineHeight: 19, weight: 700, maxWidth: 320, marginBottom: 14 }
    )}
    ${panel}
    ${renderExactBodyText(
      "Te avisamos por mail cuando el staff apruebe tu cuenta.",
      { fontSize: 13, lineHeight: 18, weight: 700, maxWidth: 320, marginBottom: 14 }
    )}
    ${
      BRAND_URL
        ? renderExactButtons([{ label: `Ir a ${BRAND_NAME}`, href: BRAND_URL, variant: "primary" }])
        : ""
    }
  `;

  const html = buildExactAuthEmail({
    title: "Registro recibido",
    icon: "✓",
    preheader: "Registro realizado correctamente",
    innerHtml,
  });

  await sendMail(user.email, `Registro recibido - ${BRAND_NAME}`, lines.join("\n"), html);
}

/* =========================================================
   3) ADMIN -> NUEVO REGISTRO + botones
========================================================= */

export async function sendAdminNewRegistrationEmail({ user, approveUrl, rejectUrl }) {
  if (!ADMIN_EMAIL) return;
  if (!user?.email) return;

  const fullName =
    `${user?.name || ""} ${user?.lastName || ""}`.trim() || user?.email || "Usuario";

  const lines = [
    `${BRAND_NAME} - Nuevo registro`,
    "",
    `Nombre: ${fullName}`,
    `Email: ${user.email}`,
    user?.phone ? `Teléfono: ${user.phone}` : "",
    user?._id ? `ID: ${user._id}` : "",
    "",
    "Acciones:",
    `Aprobar: ${approveUrl}`,
    `Rechazar: ${rejectUrl}`,
  ].filter(Boolean);

  const panel = renderExactPanel(`
    ${panelRow("Nombre", `<span style="color:#ffffff;">${escapeHtml(fullName)}</span>`)}
    ${panelRow("Email", `<span style="color:#ffffff;">${escapeHtml(user.email || "-")}</span>`)}
    ${panelRow("Teléfono", `<span style="color:#ffffff;">${escapeHtml(user.phone || "-")}</span>`)}
    ${panelRow("ID", `<span style="color:#ffffff;">${escapeHtml(String(user._id || "-"))}</span>`)}
    ${panelRow("Email verificado", `<span style="color:#ffffff;">${user?.emailVerified ? "SI" : "NO"}</span>`)}
    ${panelRow("Estado", `<span style="color:#ffffff;">Pendiente</span>`)}
  `);

  const innerHtml = `
    ${renderExactBodyText(
      `Se registró un nuevo usuario en <b>${escapeHtml(BRAND_NAME)}</b>.`,
      { fontSize: 14, lineHeight: 19, weight: 700, maxWidth: 320, marginBottom: 14 }
    )}
    ${panel}
    ${renderExactButtons([
      { label: "Aprobar", href: approveUrl, variant: "primary" },
      { label: "Rechazar", href: rejectUrl, variant: "danger" },
    ])}
    ${renderLinksFallback([{ href: approveUrl }, { href: rejectUrl }])}
  `;

  const html = buildExactAuthEmail({
    title: "Nuevo registro",
    icon: "✓",
    preheader: "Nuevo usuario pendiente de aprobación",
    innerHtml,
  });

  await sendMail(ADMIN_EMAIL, `Nuevo registro - ${BRAND_NAME}`, lines.join("\n"), html);
}

/* =========================================================
   4) USER -> APROBADO / RECHAZADO (+ link)
========================================================= */

export async function sendUserApprovalResultEmail(user, status) {
  if (!user?.email) return;

  const uName = user?.name || "";
  const isApproved = status === "approved";

  const title = isApproved ? "Cuenta aprobada" : "Cuenta rechazada";
  const pre = isApproved ? "Tu cuenta fue aprobada" : "Tu cuenta fue rechazada";
  const icon = isApproved ? "✓" : "✕";

  const lines = [
    `Hola ${uName}`.trim() + ",",
    "",
    isApproved
      ? `¡Listo! El staff aprobó tu cuenta en ${BRAND_NAME}. Ya podés ingresar.`
      : `Tu cuenta en ${BRAND_NAME} fue rechazada. Si creés que es un error, contactá al administrador.`,
    "",
    BRAND_URL ? `Ingresar: ${BRAND_URL}` : "",
  ].filter(Boolean);

  const panel = renderExactPanel(`
    ${panelRow("Estado", `<span style="color:#ffffff;">${isApproved ? "Aprobada" : "Rechazada"}</span>`)}
    ${
      isApproved && BRAND_URL
        ? panelRow("Acceso", `<span style="color:#ffffff;">Disponible</span>`)
        : ""
    }
  `);

  const innerHtml = `
    ${renderExactBodyText(
      `Hola <b>${escapeHtml(uName)}</b>,<br/>${
        isApproved
          ? `¡Listo! El staff aprobó tu cuenta en <b>${escapeHtml(BRAND_NAME)}</b>. Ya podés ingresar.`
          : `Tu cuenta en <b>${escapeHtml(BRAND_NAME)}</b> fue rechazada. Si creés que es un error, contactá al administrador.`
      }`,
      { fontSize: 14, lineHeight: 19, weight: 700, maxWidth: 320, marginBottom: 14 }
    )}
    ${panel}
    ${
      isApproved && BRAND_URL
        ? renderExactButtons([{ label: `Ingresar a ${BRAND_NAME}`, href: BRAND_URL, variant: "primary" }])
        : ""
    }
  `;

  const html = buildExactAuthEmail({
    title,
    icon,
    preheader: pre,
    innerHtml,
  });

  await sendMail(user.email, `${title} - ${BRAND_NAME}`, lines.join("\n"), html);
}