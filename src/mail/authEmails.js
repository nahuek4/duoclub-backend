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
    panelRow(
      "Estado",
      `<span style="color:#ffffff;">Pendiente de verificación</span>`
    ),
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
      "Estado",
      `<span style="color:#ffffff;">Pendiente de aprobación</span>`
    ),
    panelRow(
      "Importante",
      `<span style="color:#ffffff;">Verificá tu correo electrónico si todavía no lo hiciste.</span>`
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
        ? renderPrimaryButton(`Ingresar a ${BRAND_NAME}`, BRAND_URL)
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
        marginBottom: 0,
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
    approveUrl ? `Aprobar: ${approveUrl}` : "",
    rejectUrl ? `Rechazar: ${rejectUrl}` : "",
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

    ${renderExactButtons(
      [
        approveUrl
          ? { label: "Aprobar", href: approveUrl, variant: "primary" }
          : null,
        rejectUrl
          ? { label: "Rechazar", href: rejectUrl, variant: "danger" }
          : null,
      ].filter(Boolean)
    )}

    ${renderLinksFallback(
      [approveUrl, rejectUrl]
        .filter(Boolean)
        .map((href) => ({ href }))
    )}
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

  if (isApproved) {
    const html = buildEmailLayout({
      title: `${BRAND_NAME} · Cuenta aprobada`,
      preheader,
      footerNote: "",
      bodyHtml: `
        <style>
          @media only screen and (max-width: 560px) {
            .duo-mail-outer {
              padding: 0 !important;
            }
            .duo-mail-card {
              border-radius: 0 !important;
            }
            .duo-mail-content {
              padding: 26px 26px 0 !important;
            }
            .duo-mail-logo {
              padding-top: 4px !important;
              padding-bottom: 18px !important;
            }
            .duo-mail-title {
              font-size: 33px !important;
              line-height: 34px !important;
            }
            .duo-mail-copy {
              font-size: 15px !important;
              line-height: 21px !important;
            }
            .duo-mail-button-cell {
              padding-left: 26px !important;
              padding-right: 26px !important;
            }
            .duo-mail-footer {
              padding: 22px 26px !important;
            }
          }
        </style>

        <table
          role="presentation"
          cellpadding="0"
          cellspacing="0"
          width="100%"
          class="duo-mail-outer"
          style="border-collapse:collapse;"
        >
          <tr>
            <td align="center" style="padding:0;">
              <table
                role="presentation"
                cellpadding="0"
                cellspacing="0"
                width="100%"
                style="max-width:560px; border-collapse:collapse;"
              >
                <tr>
                  <td
                    class="duo-mail-card"
                    style="
                      background:#f3f3f3;
                      border-radius:0;
                      overflow:hidden;
                    "
                  >
                    <table
                      role="presentation"
                      cellpadding="0"
                      cellspacing="0"
                      width="100%"
                      style="border-collapse:collapse;"
                    >
                      <tr>
                        <td
                          class="duo-mail-content"
                          style="
                            padding:24px 34px 0;
                            background:#f3f3f3;
                            font-family:Arial, Helvetica, sans-serif;
                            color:#111111;
                          "
                        >
                          <table
                            role="presentation"
                            cellpadding="0"
                            cellspacing="0"
                            width="100%"
                            style="border-collapse:collapse;"
                          >
                            <tr>
                              <td
                                class="duo-mail-logo"
                                align="center"
                                style="padding:2px 0 20px;"
                              >
                                <div
                                  style="
                                    font-size:42px;
                                    line-height:42px;
                                    font-weight:900;
                                    color:#111111;
                                    letter-spacing:-2px;
                                    font-family:Arial, Helvetica, sans-serif;
                                  "
                                >
                                  ᗡ◖
                                </div>
                              </td>
                            </tr>

                            <tr>
                              <td
                                class="duo-mail-title"
                                style="
                                  font-size:35px;
                                  line-height:36px;
                                  font-weight:900;
                                  color:#111111;
                                  letter-spacing:-1px;
                                  padding:0 0 14px;
                                  font-family:Arial, Helvetica, sans-serif;
                                "
                              >
                                Cuenta aprobada
                              </td>
                            </tr>

                            <tr>
                              <td style="padding:0 0 14px;">
                                <div
                                  style="
                                    height:1px;
                                    background:#cfcfcf;
                                    width:100%;
                                  "
                                ></div>
                              </td>
                            </tr>

                            <tr>
                              <td
                                class="duo-mail-copy"
                                style="
                                  font-size:14px;
                                  line-height:20px;
                                  font-weight:400;
                                  color:#111111;
                                  padding:0 0 22px;
                                  font-family:Arial, Helvetica, sans-serif;
                                "
                              >
                                Hola ${escapeHtml(uName)},<br /><br />
                                Tu cuenta de ${escapeHtml(
                                  BRAND_NAME
                                )} ya fue aprobada!<br />
                                Ya podés ingresar y comenzar a usar la plataforma.
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>

                      <tr>
                        <td
                          class="duo-mail-button-cell"
                          style="
                            background:#f3f3f3;
                            padding:0 34px 28px;
                            font-family:Arial, Helvetica, sans-serif;
                          "
                        >
                          <table
                            role="presentation"
                            cellpadding="0"
                            cellspacing="0"
                            style="border-collapse:collapse;"
                          >
                            <tr>
                              <td
                                align="center"
                                style="
                                  background:#dfff00;
                                  border-radius:999px;
                                "
                              >
                                <a
                                  href="${escapeHtml(BRAND_URL || "#")}"
                                  style="
                                    display:inline-block;
                                    padding:13px 24px;
                                    font-size:14px;
                                    line-height:14px;
                                    font-weight:700;
                                    color:#111111;
                                    text-decoration:none;
                                    font-family:Arial, Helvetica, sans-serif;
                                  "
                                >
                                  Ingresar a ${escapeHtml(BRAND_NAME)}
                                </a>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>

                      <tr>
                        <td
                          class="duo-mail-footer"
                          style="
                            background:#0a0a0a;
                            padding:24px 34px;
                            font-family:Arial, Helvetica, sans-serif;
                          "
                        >
                          <table
                            role="presentation"
                            cellpadding="0"
                            cellspacing="0"
                            width="100%"
                            style="border-collapse:collapse;"
                          >
                            <tr>
                              <td
                                valign="middle"
                                style="
                                  color:#ffffff;
                                  font-size:28px;
                                  line-height:28px;
                                  font-weight:900;
                                  letter-spacing:2px;
                                  font-family:Arial, Helvetica, sans-serif;
                                "
                              >
                                DUO
                              </td>

                              <td
                                valign="middle"
                                align="right"
                                style="
                                  color:#ffffff;
                                  font-size:11px;
                                  line-height:16px;
                                  font-weight:500;
                                  font-family:Arial, Helvetica, sans-serif;
                                "
                              >
                                DUOCLUB.AR<br />
                                INFO@DUOCLUB.AR<br />
                                Av. Santa Fe 2567, Tandil<br />
                                +54 9 249 123 4567
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
      `,
    });

    await sendMail(
      user.email,
      `${title} - ${BRAND_NAME}`,
      text,
      html
    );

    return;
  }

  const panel = buildPanel([
    panelRow(
      "Estado",
      `<span style="color:#ffffff;">Rechazada</span>`
    ),
  ]);

  const innerHtml = `
    ${renderExactBodyText(
      `Hola <b>${escapeHtml(uName)}</b>,<br/>Tu cuenta de <b>${escapeHtml(
        BRAND_NAME
      )}</b> no pudo ser aprobada.`,
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 14,
      }
    )}

    ${panel}

    ${renderExactBodyText(
      "Si creés que esto es un error, respondé este mail o comunicate con el staff.",
      {
        fontSize: 12,
        lineHeight: 17,
        weight: 600,
        maxWidth: 320,
        marginTop: 8,
        marginBottom: 0,
      }
    )}
  `;

  const html = buildAuthEmail({
    title,
    icon: "✕",
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