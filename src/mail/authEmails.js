// backend/src/mail/authEmails.js
import { ADMIN_EMAIL, BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { escapeHtml } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";
import {
  buildExactMail,
  panelOpen,
  panelClose,
  panelRow,
  renderExactBodyText,
  renderExactButtons,
  renderLinksFallback,
  renderPrimaryButton,
} from "./ui.js";

/* =========================================================
   Helpers
========================================================= */

function buildAuthEmail({ title, icon = "✓", innerHtml, preheader }) {
  const exact = buildExactMail({
    brandName: BRAND_NAME,
    title,
    preheader: preheader || title,
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

function safeName(user = {}) {
  return String(user?.name || "").trim() || "Hola";
}

function safeFullName(user = {}) {
  return (
    `${user?.name || ""} ${user?.lastName || ""}`.trim() ||
    user?.fullName ||
    user?.email ||
    "Usuario"
  );
}

function buildPanel(rows = []) {
  const items = (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .join("");

  return `
    ${panelOpen()}
      ${items}
    ${panelClose()}
  `;
}

/* =========================================================
   1) VERIFY EMAIL
========================================================= */

export async function sendVerifyEmail(user, verifyUrl) {
  if (!user?.email || !verifyUrl) return;

  const uName = safeName(user);

  const text = [
    `Hola ${uName},`,
    "",
    `Gracias por registrarte en ${BRAND_NAME}.`,
    "",
    "Para continuar, verificá tu email desde este enlace:",
    verifyUrl,
    "",
    "Este link vence en 24 horas.",
    "",
    "Si vos no creaste esta cuenta, podés ignorar este mensaje.",
  ].join("\n");

  const panel = buildPanel([
    panelRow("Estado", `<span style="color:#ffffff;">Pendiente de verificación</span>`),
    panelRow("Vence", `<span style="color:#ffffff;">24 horas</span>`),
  ]);

  const innerHtml = `
    ${renderExactBodyText(
      `Hola <b>${escapeHtml(uName)}</b>,<br/>Para continuar, verificá tu email.`,
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 14,
      }
    )}

    ${panel}

    ${renderPrimaryButton("Verificar email", verifyUrl)}

    ${renderLinksFallback([{ href: verifyUrl }])}

    ${renderExactBodyText(
      "Si vos no creaste esta cuenta, podés ignorar este email.",
      {
        fontSize: 12,
        lineHeight: 17,
        weight: 600,
        maxWidth: 320,
        marginTop: 10,
        marginBottom: 0,
      }
    )}
  `;

  const html = buildAuthEmail({
    title: "Verificación de email",
    icon: "✓",
    preheader: "Verificá tu email para continuar",
    innerHtml,
  });

  await sendMail(
    user.email,
    `Verificá tu email - ${BRAND_NAME}`,
    text,
    html
  );
}

/* =========================================================
   2) USER -> REGISTRO RECIBIDO
========================================================= */

export async function sendUserRegistrationReceivedEmail(user) {
  if (!user?.email) return;

  const uName = safeName(user);

  const text = [
    `Hola ${uName},`,
    "",
    `Recibimos tu registro en ${BRAND_NAME} correctamente.`,
    "Tu cuenta se encuentra pendiente de aprobación.",
    "",
    "Antes de continuar:",
    "- Verificá tu correo electrónico, si todavía no lo hiciste.",
    "",
    "Una vez que el equipo apruebe tu cuenta, te vamos a avisar por mail.",
    "",
    BRAND_URL ? `Acceso: ${BRAND_URL}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const panel = buildPanel([
    panelRow(
      "Antes de continuar",
      `<span style="color:#ffffff;">Verificá tu correo electrónico, si todavía no lo hiciste.</span>`
    ),
  ]);

  const innerHtml = `
    ${renderExactBodyText(
      `Hola <b>${escapeHtml(uName)}</b>,<br/>Recibimos tu registro en <b>${escapeHtml(
        BRAND_NAME
      )}</b> correctamente.<br/>Tu cuenta se encuentra <b>pendiente de aprobación</b>.`,
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 14,
      }
    )}

    ${panel}

    ${
      BRAND_URL
        ? renderPrimaryButton("Verificar email", BRAND_URL)
        : ""
    }

    ${renderExactBodyText(
      "Una vez que el equipo apruebe tu cuenta, te lo vamos a avisar por mail.",
      {
        fontSize: 13,
        lineHeight: 18,
        weight: 700,
        maxWidth: 320,
        marginTop: 2,
        marginBottom: 10,
      }
    )}

    ${
      BRAND_URL
        ? renderExactBodyText(
            `¿Tuviste un problema con el botón?<br/><a href="${escapeHtml(
              BRAND_URL
            )}" style="color:#2b59ff; text-decoration:underline;">Podés acceder igual desde este enlace</a>`,
            {
              fontSize: 11,
              lineHeight: 16,
              weight: 600,
              maxWidth: 320,
              marginTop: 8,
              marginBottom: 0,
            }
          )
        : ""
    }
  `;

  const html = buildAuthEmail({
    title: "Registro recibido",
    icon: "✓",
    preheader: "Registro realizado correctamente",
    innerHtml,
  });

  await sendMail(
    user.email,
    `Registro recibido - ${BRAND_NAME}`,
    text,
    html
  );
}

/* =========================================================
   3) ADMIN -> NUEVO REGISTRO
========================================================= */

export async function sendAdminNewRegistrationEmail({
  user,
  approveUrl,
  rejectUrl,
}) {
  if (!ADMIN_EMAIL || !user?.email) return;

  const fullName = safeFullName(user);

  const text = [
    `${BRAND_NAME} - Nuevo registro`,
    "",
    `Nombre: ${fullName}`,
    `Email: ${user.email}`,
    user?.phone ? `Teléfono: ${user.phone}` : "",
    user?._id ? `ID: ${user._id}` : "",
    `Email verificado: ${user?.emailVerified ? "SI" : "NO"}`,
    "",
    `Aprobar: ${approveUrl}`,
    `Rechazar: ${rejectUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const panel = buildPanel([
    panelRow("Nombre", `<span style="color:#ffffff;">${escapeHtml(fullName)}</span>`),
    panelRow("Email", `<span style="color:#ffffff;">${escapeHtml(user.email || "-")}</span>`),
    panelRow("Teléfono", `<span style="color:#ffffff;">${escapeHtml(user.phone || "-")}</span>`),
    panelRow("ID", `<span style="color:#ffffff;">${escapeHtml(String(user._id || "-"))}</span>`),
    panelRow(
      "Email verificado",
      `<span style="color:#ffffff;">${user?.emailVerified ? "SI" : "NO"}</span>`
    ),
    panelRow("Estado", `<span style="color:#ffffff;">Pendiente</span>`),
  ]);

  const innerHtml = `
    ${renderExactBodyText(
      `Se registró un nuevo usuario en <b>${escapeHtml(BRAND_NAME)}</b>.`,
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 14,
      }
    )}

    ${panel}

    ${renderExactButtons([
      { label: "Aprobar", href: approveUrl, variant: "primary" },
      { label: "Rechazar", href: rejectUrl, variant: "danger" },
    ])}

    ${renderLinksFallback([{ href: approveUrl }, { href: rejectUrl }])}
  `;

  const html = buildAuthEmail({
    title: "Nuevo registro",
    icon: "✓",
    preheader: "Nuevo usuario pendiente de aprobación",
    innerHtml,
  });

  await sendMail(
    ADMIN_EMAIL,
    `Nuevo registro - ${BRAND_NAME}`,
    text,
    html
  );
}

/* =========================================================
   4) USER -> APROBADO / RECHAZADO
========================================================= */

export async function sendUserApprovalResultEmail(user, status) {
  if (!user?.email) return;

  const uName = safeName(user);
  const isApproved = status === "approved";

  const title = isApproved ? "Cuenta aprobada" : "Cuenta rechazada";
  const preheader = isApproved
    ? "Tu cuenta fue aprobada"
    : "Tu cuenta fue rechazada";

  const text = [
    `Hola ${uName},`,
    "",
    isApproved
      ? `Tu cuenta de ${BRAND_NAME} fue aprobada. Ya podés ingresar y comenzar a usar la plataforma.`
      : `Tu cuenta de ${BRAND_NAME} no pudo ser aprobada.`,
    "",
    isApproved && BRAND_URL ? `Ingresar: ${BRAND_URL}` : "",
    !isApproved
      ? "Si creés que esto es un error, respondé este mail o comunicate con el staff."
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const panel = buildPanel([
    panelRow(
      "Estado",
      `<span style="color:#ffffff;">${isApproved ? "Aprobada" : "Rechazada"}</span>`
    ),
    isApproved && BRAND_URL
      ? panelRow("Acceso", `<span style="color:#ffffff;">Disponible</span>`)
      : "",
  ]);

  const innerHtml = `
    ${renderExactBodyText(
      `Hola <b>${escapeHtml(uName)}</b>,<br/>${
        isApproved
          ? `Tu cuenta de <b>${escapeHtml(
              BRAND_NAME
            )}</b> fue aprobada.<br/>Ya podés ingresar y comenzar a usar la plataforma.`
          : `Tu cuenta de <b>${escapeHtml(
              BRAND_NAME
            )}</b> no pudo ser aprobada.`
      }`,
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 14,
      }
    )}

    ${panel}

    ${
      isApproved && BRAND_URL
        ? renderPrimaryButton(`Ingresar a ${BRAND_NAME}`, BRAND_URL)
        : ""
    }

    ${
      !isApproved
        ? renderExactBodyText(
            "Si creés que esto es un error, respondé este mail o comunicate con el staff.",
            {
              fontSize: 12,
              lineHeight: 17,
              weight: 600,
              maxWidth: 320,
              marginTop: 8,
              marginBottom: 0,
            }
          )
        : ""
    }
  `;

  const html = buildAuthEmail({
    title,
    icon: isApproved ? "✓" : "✕",
    preheader,
    innerHtml,
  });

  await sendMail(
    user.email,
    `${title} - ${BRAND_NAME}`,
    text,
    html
  );
}