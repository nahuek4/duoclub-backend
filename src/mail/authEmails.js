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
  renderAdminMetaPanel,
  renderAdminDetailPanel,
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

function renderMailAccountApprovedIcon(size = 28) {
  const safeSize = Number(size) || 28;
  return `<img src="${IMG_BASE}/iconoCuentaAprobada.png" alt="Cuenta aprobada" width="${safeSize}" height="${safeSize}" style="display:block; width:${safeSize}px; height:${safeSize}px; border:0; outline:none; text-decoration:none;" />`;
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
                  style="display:inline-block; text-decoration:none; border:0; outline:none;; color:#ffffff;"
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

function buildVerifyVisualEmail({
  title,
  preheader,
  name,
  verifyHref,
}) {
  const safeHref = verifyHref || BRAND_URL || "#";

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
          .duo-verify-wrap {
            max-width: 100% !important;
          }
          .duo-verify-card {
            border-radius: 0 0 22px 22px !important;
          }
          .duo-verify-content {
            padding: 30px 26px 34px !important;
          }
          .duo-verify-logo {
            padding-bottom: 34px !important;
          }
          .duo-verify-heading {
            font-size: 22px !important;
            line-height: 26px !important;
          }
          .duo-verify-copy {
            font-size: 14px !important;
            line-height: 21px !important;
          }
          .duo-verify-box {
            padding: 22px 18px 24px !important;
          }
          .duo-verify-box-copy,
          .duo-verify-box-note,
          .duo-verify-link-note {
            font-size: 14px !important;
            line-height: 20px !important;
          }
          .duo-verify-fallback {
            font-size: 11px !important;
            line-height: 17px !important;
          }
          .duo-verify-footer {
            padding: 36px 32px 38px !important;
            border-radius: 0 0 22px 22px !important;
          }
          .duo-footer-brand {
            font-size: 22px !important;
            line-height: 22px !important;
            letter-spacing: 6px !important;
          }
          .duo-footer-info {
            font-size: 9px !important;
            line-height: 13px !important;
          }
        }
      </style>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr>
          <td align="center" style="padding:0;">
            <table
              role="presentation"
              cellpadding="0"
              cellspacing="0"
              width="100%"
              class="duo-verify-wrap"
              style="max-width:430px; border-collapse:separate; border-spacing:0;"
            >
              <tr>
                <td
                  class="duo-verify-card"
                  style="
                    background:#FBFBFB;
                    border-radius:0 0 28px 28px;
                    overflow:hidden;
                    font-family:Arial, Helvetica, sans-serif;
                    color:#111111;
                  "
                >
                  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                    <tr>
                      <td
                        class="duo-verify-content"
                        style="
                          background:#FBFBFB;
                          padding:34px 36px 36px;
                          font-family:Arial, Helvetica, sans-serif;
                          color:#111111;
                        "
                      >
                        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                          <tr>
                            <td class="duo-verify-logo" align="center" style="padding:0 0 36px;">
                              <div
                                style="
                                  font-family:Arial, Helvetica, sans-serif;
                                  font-size:34px;
                                  line-height:34px;
                                  font-weight:700;
                                  color:#0A0A0A;
                                  letter-spacing:-3px;
                                "
                              >${renderMailHeaderLogo()}</div>
                            </td>
                          </tr>

                          <tr>
                            <td style="padding:0 0 14px;">
                              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
                                <tr>
                                  <td valign="middle" style="width:24px; padding:0 10px 0 0;">
                                    <div
                                      style="
                                        width:19px;
                                        height:19px;
                                        border:2px solid #111111;
                                        border-radius:999px;
                                        font-size:11px;
                                        line-height:17px;
                                        text-align:center;
                                        font-weight:700;
                                        color:#111111;
                                      "
                                    >@</div>
                                  </td>
                                  <td
                                    class="duo-verify-heading"
                                    valign="middle"
                                    style="
                                      font-family:Arial, Helvetica, sans-serif;
                                      font-size:24px;
                                      line-height:28px;
                                      font-weight:700;
                                      color:#111111;
                                      letter-spacing:-0.6px;
                                    "
                                  >Verificá tu email</td>
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
                            <td
                              class="duo-verify-copy"
                              style="
                                font-family:Arial, Helvetica, sans-serif;
                                font-size:14px;
                                line-height:20px;
                                font-weight:400;
                                color:#111111;
                                text-align:left;
                                padding:0 0 30px;
                              "
                            >
                              Hola <b>${escapeHtml(name)}</b>,<br />
                              Gracias por registrarte en <b>${escapeHtml(BRAND_NAME)}</b>.<br />
                              Para continuar, necesitás verificar tu correo electrónico.
                            </td>
                          </tr>

                          <tr>
                            <td style="padding:0 0 24px;">
                              <table
                                role="presentation"
                                cellpadding="0"
                                cellspacing="0"
                                width="100%"
                                class="duo-verify-box"
                                style="
                                  border-collapse:separate;
                                  border-spacing:0;
                                  width:100%;
                                  border:1.5px solid #111111;
                                  border-radius:10px;
                                  background:#FBFBFB;
                                "
                              >
                                <tr>
                                  <td style="padding:22px 22px 24px; text-align:center;">
                                    <div
                                      class="duo-verify-box-copy"
                                      style="
                                        font-family:Arial, Helvetica, sans-serif;
                                        font-size:14px;
                                        line-height:20px;
                                        font-weight:500;
                                        color:#111111;
                                        text-align:center;
                                      "
                                    >
                                      Hacé clic en el botón para <b>verificar tu email</b> y continuar con el alta de tu cuenta.
                                    </div>

                                    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin:20px auto 16px;">
                                      <tr>
                                        <td
                                          align="center"
                                          style="
                                            background:#EEFF00;
                                            border-radius:999px;
                                            box-shadow:0 10px 14px rgba(0,0,0,0.18);
                                          "
                                        >
                                          <a
                                            href="${escapeHtml(safeHref)}"
                                            style="
                                              display:inline-block;
                                              padding:13px 21px;
                                              font-family:Arial, Helvetica, sans-serif;
                                              font-size:15px;
                                              line-height:16px;
                                              font-weight:700;
                                              color:#111111;
                                              text-decoration:none;
                                            "
                                          >Verificar email</a>
                                        </td>
                                      </tr>
                                    </table>

                                    <div
                                      class="duo-verify-box-note"
                                      style="
                                        font-family:Arial, Helvetica, sans-serif;
                                        font-size:14px;
                                        line-height:20px;
                                        font-weight:500;
                                        color:#111111;
                                        text-align:center;
                                      "
                                    >
                                      Este link vence en <b>24 horas</b>.
                                    </div>
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>

                          <tr>
                            <td
                              class="duo-verify-link-note"
                              style="
                                font-family:Arial, Helvetica, sans-serif;
                                font-size:12px;
                                line-height:18px;
                                font-weight:600;
                                color:#111111;
                                text-align:left;
                                padding:0 0 18px;
                              "
                            >
                              Si vos no creaste esta cuenta, podés ignorar este email.
                            </td>
                          </tr>

                          <tr>
                            <td
                              class="duo-verify-fallback"
                              style="
                                font-family:Arial, Helvetica, sans-serif;
                                font-size:11px;
                                line-height:16px;
                                font-weight:600;
                                color:#111111;
                                text-align:center;
                              "
                            >
                              ¿Tuviste un problema con el botón?<br />
                              <a href="${escapeHtml(safeHref)}" style="color:#2b59ff; text-decoration:underline;">Podés acceder igual desde este enlace</a>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>

                    <tr>
                      <td
                        class="duo-verify-footer"
                        style="
                          background:#0A0A0A;
                          padding:40px 48px 42px;
                          border-radius:0 0 28px 28px;
                          font-family:Arial, Helvetica, sans-serif;
                        "
                      >
                        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                          <tr>
                            <td
                              valign="middle"
                              style="
                                width:42%;
                                color:#ffffff;
                                font-family:Arial, Helvetica, sans-serif;
                              "
                            >
                              <div
                                class="duo-footer-brand"
                                style="
                                  font-size:23px;
                                  line-height:23px;
                                  font-weight:700;
                                  letter-spacing:7px;
                                "
                              >DUO</div>
                              <div
                                style="
                                  font-size:4px;
                                  line-height:7px;
                                  font-weight:700;
                                  letter-spacing:1.8px;
                                  margin-top:4px;
                                  opacity:0.95;
                                "
                              ></div>
                            </td>
                            <td
                              valign="middle"
                              align="right"
                              class="duo-footer-info"
                              style="
                                width:58%;
                                color:#ffffff;
                                font-family:Arial, Helvetica, sans-serif;
                                font-size:9px;
                                line-height:13px;
                                font-weight:500;
                                letter-spacing:0.2px;
                              "
                            >
                              <div style="font-weight:700; letter-spacing:2.8px; color:#ffffff; text-decoration:none;"><span style="color:#ffffff; text-decoration:none;">DUOCLUB.AR</span></div>
                              <div style="color:#ffffff; text-decoration:none;"><span style="color:#ffffff; text-decoration:none;">+54 249 420 7343</span></div>
                              <div style="color:#ffffff; text-decoration:none;"><span style="color:#ffffff; text-decoration:none;">Av. Santamaría 54, Tandil.</span></div>
                              <div style="padding-top:6px; font-size:10px; line-height:10px; letter-spacing:4px;">${renderMailFooterIcons()}</div>
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
}

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

  const html = buildVerifyVisualEmail({
    title: "Verificación de email",
    preheader: "Verificá tu email para continuar",
    name: uName,
    verifyHref: verifyUrl,
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

function buildRegistrationReceivedVisualEmail({
  title,
  preheader,
  name,
  verifyHref = "",
}) {
  const safeHref = verifyHref || BRAND_URL || "#";

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${title}`,
    preheader,
    footerNote: "",
    bodyHtml: `
      <style>
        @media only screen and (max-width: 560px) {
          .duo-reg-wrap {
            max-width: 100% !important;
          }
          .duo-reg-card {
            border-radius: 0 0 22px 22px !important;
          }
          .duo-reg-content {
            padding: 30px 26px 34px !important;
          }
          .duo-reg-logo {
            padding-bottom: 34px !important;
          }
          .duo-reg-heading {
            font-size: 22px !important;
            line-height: 26px !important;
          }
          .duo-reg-copy {
            font-size: 14px !important;
            line-height: 21px !important;
          }
          .duo-reg-box {
            padding: 22px 18px 24px !important;
          }
          .duo-reg-box-copy,
          .duo-reg-box-note {
            font-size: 14px !important;
            line-height: 20px !important;
          }
          .duo-reg-footer-link {
            font-size: 11px !important;
            line-height: 17px !important;
          }
          .duo-reg-footer {
            padding: 36px 32px 38px !important;
            border-radius: 0 0 22px 22px !important;
          }
          .duo-footer-brand {
            font-size: 22px !important;
            line-height: 22px !important;
            letter-spacing: 6px !important;
          }
          .duo-footer-info {
            font-size: 9px !important;
            line-height: 13px !important;
          }
        }
      </style>

      <table
        role="presentation"
        cellpadding="0"
        cellspacing="0"
        width="100%"
        style="border-collapse:collapse;"
      >
        <tr>
          <td align="center" style="padding:0;">
            <table
              role="presentation"
              cellpadding="0"
              cellspacing="0"
              width="100%"
              class="duo-reg-wrap"
              style="max-width:430px; border-collapse:separate; border-spacing:0;"
            >
              <tr>
                <td
                  class="duo-reg-card"
                  style="
                    background:#FBFBFB;
                    border-radius:0 0 28px 28px;
                    overflow:hidden;
                    font-family:Arial, Helvetica, sans-serif;
                    color:#111111;
                  "
                >
                  <table
                    role="presentation"
                    cellpadding="0"
                    cellspacing="0"
                    width="100%"
                    style="border-collapse:collapse; width:100%;"
                  >
                    <tr>
                      <td
                        class="duo-reg-content"
                        style="
                          background:#FBFBFB;
                          padding:34px 36px 36px;
                          font-family:Arial, Helvetica, sans-serif;
                          color:#111111;
                        "
                      >
                        <table
                          role="presentation"
                          cellpadding="0"
                          cellspacing="0"
                          width="100%"
                          style="border-collapse:collapse; width:100%;"
                        >
                          <tr>
                            <td
                              class="duo-reg-logo"
                              align="center"
                              style="padding:0 0 36px;"
                            >
                              <div
                                style="
                                  font-family:Arial, Helvetica, sans-serif;
                                  font-size:34px;
                                  line-height:34px;
                                  font-weight:700;
                                  color:#0A0A0A;
                                  letter-spacing:-3px;
                                "
                              >${renderMailHeaderLogo()}</div>
                            </td>
                          </tr>

                          <tr>
                            <td style="padding:0 0 14px;">
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
                                    style="width:24px; padding:0 10px 0 0;"
                                  >
                                    ${renderMailAccountApprovedIcon(28)}
                                  </td>
                                  <td
                                    class="duo-reg-heading"
                                    valign="middle"
                                    style="
                                      font-family:Arial, Helvetica, sans-serif;
                                      font-size:24px;
                                      line-height:28px;
                                      font-weight:700;
                                      color:#111111;
                                      letter-spacing:-0.6px;
                                    "
                                  >Registro recibido</td>
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
                            <td
                              class="duo-reg-copy"
                              style="
                                font-family:Arial, Helvetica, sans-serif;
                                font-size:14px;
                                line-height:20px;
                                font-weight:400;
                                color:#111111;
                                text-align:left;
                                padding:0 0 30px;
                              "
                            >
                              Hola <b>${escapeHtml(name)}</b>,<br />
                              Recibimos tu registro en <b>${escapeHtml(BRAND_NAME)}</b> correctamente.<br />
                              <b>y se encuentra pendiente de aprobación.</b>
                            </td>
                          </tr>

                          <tr>
                            <td style="padding:0 0 24px;">
                              <table
                                role="presentation"
                                cellpadding="0"
                                cellspacing="0"
                                width="100%"
                                class="duo-reg-box"
                                style="
                                  border-collapse:separate;
                                  border-spacing:0;
                                  width:100%;
                                  border:1.5px solid #111111;
                                  border-radius:10px;
                                  background:#FBFBFB;
                                "
                              >
                                <tr>
                                  <td style="padding:22px 22px 24px; text-align:center;">
                                    <div
                                      class="duo-reg-box-copy"
                                      style="
                                        font-family:Arial, Helvetica, sans-serif;
                                        font-size:14px;
                                        line-height:20px;
                                        font-weight:500;
                                        color:#111111;
                                        text-align:center;
                                      "
                                    >
                                      Antes de continuar: <b>Verificá tu correo electrónico</b> desde este mismo mail.
                                    </div>

                                    <table
                                      role="presentation"
                                      cellpadding="0"
                                      cellspacing="0"
                                      style="border-collapse:collapse; margin:20px auto 18px;"
                                    >
                                      <tr>
                                        <td
                                          align="center"
                                          style="
                                            background:#EEFF00;
                                            border-radius:999px;
                                            box-shadow:0 10px 14px rgba(0,0,0,0.18);
                                          "
                                        >
                                          <a
                                            href="${escapeHtml(safeHref)}"
                                            style="
                                              display:inline-block;
                                              padding:13px 21px;
                                              font-family:Arial, Helvetica, sans-serif;
                                              font-size:15px;
                                              line-height:16px;
                                              font-weight:700;
                                              color:#111111;
                                              text-decoration:none;
                                            "
                                          >Verificar email</a>
                                        </td>
                                      </tr>
                                    </table>

                                    <div
                                      class="duo-reg-box-note"
                                      style="
                                        font-family:Arial, Helvetica, sans-serif;
                                        font-size:14px;
                                        line-height:20px;
                                        font-weight:500;
                                        color:#111111;
                                        text-align:center;
                                      "
                                    >
                                      Una vez que el equipo apruebe tu cuenta,<br />
                                      <b>te lo vamos a avisar por mail.</b>
                                    </div>
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>

                          <tr>
                            <td
                              class="duo-reg-footer-link"
                              style="
                                font-family:Arial, Helvetica, sans-serif;
                                font-size:11px;
                                line-height:16px;
                                font-weight:600;
                                color:#111111;
                                text-align:center;
                              "
                            >
                              ¿Tuviste un problema con el botón?<br />
                              <a
                                href="${escapeHtml(safeHref)}"
                                style="color:#2b59ff; text-decoration:underline;"
                              >Podés acceder igual desde este enlace</a>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>

                    <tr>
                      <td
                        class="duo-reg-footer"
                        style="
                          background:#0A0A0A;
                          padding:40px 48px 42px;
                          border-radius:0 0 28px 28px;
                          font-family:Arial, Helvetica, sans-serif;
                        "
                      >
                        <table
                          role="presentation"
                          cellpadding="0"
                          cellspacing="0"
                          width="100%"
                          style="border-collapse:collapse; width:100%;"
                        >
                          <tr>
                            <td
                              valign="middle"
                              style="
                                width:42%;
                                color:#ffffff;
                                font-family:Arial, Helvetica, sans-serif;
                              "
                            >
                              <div
                                class="duo-footer-brand"
                                style="
                                  font-size:23px;
                                  line-height:23px;
                                  font-weight:700;
                                  letter-spacing:7px;
                                "
                              >DUO</div>
                              <div
                                style="
                                  font-size:4px;
                                  line-height:7px;
                                  font-weight:700;
                                  letter-spacing:1.8px;
                                  margin-top:4px;
                                  opacity:0.95;
                                "
                              ></div>
                            </td>
                            <td
                              valign="middle"
                              align="right"
                              class="duo-footer-info"
                              style="
                                width:58%;
                                color:#ffffff;
                                font-family:Arial, Helvetica, sans-serif;
                                font-size:9px;
                                line-height:13px;
                                font-weight:500;
                                letter-spacing:0.2px;
                              "
                            >
                              <div style="font-weight:700; letter-spacing:2.8px; color:#ffffff; text-decoration:none;"><span style="color:#ffffff; text-decoration:none;">DUOCLUB.AR</span></div>
                              <div style="color:#ffffff; text-decoration:none;"><span style="color:#ffffff; text-decoration:none;">+54 249 420 7343</span></div>
                              <div style="color:#ffffff; text-decoration:none;"><span style="color:#ffffff; text-decoration:none;">Av. Santamaría 54, Tandil.</span></div>
                              <div style="padding-top:6px; font-size:10px; line-height:10px; letter-spacing:4px;">${renderMailFooterIcons()}</div>
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
}

export async function sendUserRegistrationReceivedEmail(user, verifyUrl = BRAND_URL) {
  if (!user?.email) return;

  const uName = safeName(user);
  const verifyHref = verifyUrl || BRAND_URL || "#";

  const text = [
    `Hola ${uName},`,
    "",
    `Recibimos tu registro en ${BRAND_NAME} correctamente y se encuentra pendiente de aprobación.`,
    "",
    "Antes de continuar: verificá tu correo electrónico desde este mismo mail.",
    verifyHref ? `Verificar email: ${verifyHref}` : "",
    "",
    "Una vez que el equipo apruebe tu cuenta, te lo vamos a avisar por mail.",
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildRegistrationReceivedVisualEmail({
    title: "Registro recibido",
    preheader: "Registro recibido: verificá tu email para continuar",
    name: uName,
    verifyHref,
  });

  await sendMail(
    user.email,
    `Registro recibido · Verificá tu email - ${BRAND_NAME}`,
    text,
    html
  );
}

/* =========================================================
   3) ADMIN -> NUEVO REGISTRO
========================================================= */

function buildAdminRegistrationVisualEmail({
  title,
  preheader,
  name,
  email,
  phone,
  userId,
  emailVerified,
  approveUrl = "",
  rejectUrl = "",
}) {
  const approveHref = approveUrl || "#";
  const rejectHref = rejectUrl || "#";

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${title}`,
    preheader,
    footerNote: "",
    bodyHtml: `
      <style>
        @media only screen and (max-width: 560px) {
          .duo-admin-reg-wrap { max-width: 100% !important; }
          .duo-admin-reg-card { border-radius: 0 0 22px 22px !important; }
          .duo-admin-reg-content { padding: 30px 26px 34px !important; }
          .duo-admin-reg-heading { font-size: 22px !important; line-height: 26px !important; }
          .duo-admin-reg-copy { font-size: 14px !important; line-height: 21px !important; }
          .duo-admin-reg-footer { padding: 36px 32px 38px !important; border-radius: 0 0 22px 22px !important; }
          .duo-footer-brand { font-size: 22px !important; line-height: 22px !important; letter-spacing: 6px !important; }
          .duo-footer-info { font-size: 9px !important; line-height: 13px !important; }
        }
      </style>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr><td align="center" style="padding:0;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="duo-admin-reg-wrap" style="max-width:430px; border-collapse:separate; border-spacing:0;">
            <tr><td class="duo-admin-reg-card" style="background:#FBFBFB; border-radius:0 0 28px 28px; overflow:hidden; font-family:Arial, Helvetica, sans-serif; color:#111111;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                <tr>
                  <td class="duo-admin-reg-content" style="padding:34px 28px 34px; background:#FBFBFB; color:#111111;">
                    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                      <tr><td align="center" style="padding:0 0 36px;"><div style="font-size:34px; line-height:34px; font-weight:700; color:#0A0A0A; letter-spacing:-3px;">${renderMailHeaderLogo()}</div></td></tr>
                      <tr>
                        <td style="padding:0 0 14px;">
                          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
                            <tr>
                              <td valign="middle" style="width:24px; padding:0 10px 0 0;"><div style="width:19px; height:19px; border:2px solid #111111; border-radius:999px; font-size:11px; line-height:17px; text-align:center; font-weight:700; color:#111111;">+</div></td>
                              <td class="duo-admin-reg-heading" valign="middle" style="font-size:24px; line-height:28px; font-weight:700; color:#111111; letter-spacing:-0.6px;">Nuevo registro</td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                      <tr><td style="padding:0 0 16px;"><div style="height:1px; background:#c9c9c9; width:100%;"></div></td></tr>
                      <tr><td class="duo-admin-reg-copy" style="font-size:14px; line-height:20px; font-weight:400; color:#111111; text-align:left; padding:0 0 20px;">Se registró un nuevo usuario en <b>${escapeHtml(BRAND_NAME)}</b>.<br />Revisá sus datos y aprobá o rechazá el acceso.</td></tr>
                      <tr><td style="padding:0 0 16px;">${renderAdminMetaPanel([{ label: "Nombre", value: name }, { label: "Email", value: email }])}</td></tr>
                      <tr><td style="padding:0 0 20px;">${renderAdminDetailPanel([{ label: "Teléfono", value: phone }, { label: "ID", value: userId }, { label: "Email verificado", value: emailVerified }, { label: "Estado", value: "Pendiente" }])}</td></tr>
                      <tr><td style="padding:0 0 8px;">${renderExactButtons([
                        approveUrl ? { label: "Aprobar", href: approveHref, variant: "primary" } : null,
                        rejectUrl ? { label: "Rechazar", href: rejectHref, variant: "danger" } : null,
                      ].filter(Boolean))}</td></tr>
                      <tr><td style="padding:0 0 0;">${renderLinksFallback([approveUrl, rejectUrl].filter(Boolean).map((href) => ({ href })))}</td></tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td class="duo-admin-reg-footer" style="background:#0A0A0A; padding:40px 48px 42px; border-radius:0 0 28px 28px; font-family:Arial, Helvetica, sans-serif;">
                    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                      <tr>
                        <td valign="middle" style="width:42%; color:#ffffff;"><div class="duo-footer-brand" style="font-size:23px; line-height:23px; font-weight:700; letter-spacing:7px;">${renderMailFooterBrand()}</div><div style="font-size:4px; line-height:7px; font-weight:700; letter-spacing:1.8px; margin-top:4px; opacity:0.95;"></div></td>
                        <td valign="middle" align="right" class="duo-footer-info" style="width:58%; color:#ffffff; font-size:9px; line-height:13px; font-weight:500; letter-spacing:0.2px;"><div style="font-weight:700; letter-spacing:2.8px; color:#ffffff; text-decoration:none;"><span style="color:#ffffff; text-decoration:none;">DUOCLUB.AR</span></div><div style="color:#ffffff; text-decoration:none;"><span style="color:#ffffff; text-decoration:none;">+54 249 420 7343</span></div><div style="color:#ffffff; text-decoration:none;"><span style="color:#ffffff; text-decoration:none;">Av. Santamaría 54, Tandil.</span></div><div style="padding-top:6px; font-size:10px; line-height:10px; letter-spacing:4px;">${renderMailFooterIcons()}</div></td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td></tr>
          </table>
        </td></tr>
      </table>
    `,
  });
}

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

  const html = buildAdminRegistrationVisualEmail({
    title: "Nuevo registro",
    preheader: "Nuevo usuario pendiente de aprobación",
    name: fullName,
    email: user.email || "-",
    phone: user.phone || "-",
    userId: String(user._id || "-"),
    emailVerified: user?.emailVerified ? "SI" : "NO",
    approveUrl,
    rejectUrl,
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

function buildAccountResultVisualEmail({
  title,
  preheader,
  heading,
  name,
  messageHtml,
  ctaLabel = "",
  ctaHref = "",
  noteHtml = "",
}) {
  return buildEmailLayout({
    title: `${BRAND_NAME} · ${title}`,
    preheader,
    footerNote: "",
    bodyHtml: `
      <style>
        @media only screen and (max-width: 560px) {
          .duo-account-wrap {
            max-width: 100% !important;
          }
          .duo-account-card {
            border-radius: 0 0 22px 22px !important;
          }
          .duo-account-content {
            padding: 30px 28px 54px !important;
          }
          .duo-account-logo {
            padding: 0 0 58px !important;
          }
          .duo-account-heading {
            font-size: 22px !important;
            line-height: 26px !important;
          }
          .duo-account-copy {
            font-size: 14px !important;
            line-height: 20px !important;
          }
          .duo-account-button-row {
            padding-top: 44px !important;
          }
          .duo-account-footer {
            padding: 36px 44px 38px !important;
            border-radius: 0 0 22px 22px !important;
          }
          .duo-footer-brand {
            font-size: 22px !important;
            line-height: 22px !important;
            letter-spacing: 6px !important;
          }
          .duo-footer-info {
            font-size: 9px !important;
            line-height: 13px !important;
          }
        }
      </style>

      <table
        role="presentation"
        cellpadding="0"
        cellspacing="0"
        width="100%"
        style="border-collapse:collapse;"
      >
        <tr>
          <td align="center" style="padding:0;">
            <table
              role="presentation"
              cellpadding="0"
              cellspacing="0"
              width="100%"
              class="duo-account-wrap"
              style="max-width:430px; border-collapse:separate; border-spacing:0;"
            >
              <tr>
                <td
                  class="duo-account-card"
                  style="
                    background:#FBFBFB;
                    border-radius:0 0 28px 28px;
                    overflow:hidden;
                    font-family:Arial, Helvetica, sans-serif;
                    color:#111111;
                  "
                >
                  <table
                    role="presentation"
                    cellpadding="0"
                    cellspacing="0"
                    width="100%"
                    style="border-collapse:collapse; width:100%;"
                  >
                    <tr>
                      <td
                        class="duo-account-content"
                        style="
                          background:#FBFBFB;
                          padding:34px 56px 58px;
                          font-family:Arial, Helvetica, sans-serif;
                          color:#111111;
                        "
                      >
                        <table
                          role="presentation"
                          cellpadding="0"
                          cellspacing="0"
                          width="100%"
                          style="border-collapse:collapse; width:100%;"
                        >
                          <tr>
                            <td
                              class="duo-account-logo"
                              align="center"
                              style="padding:0 0 62px;"
                            >
                              <div
                                style="
                                  font-family:Arial, Helvetica, sans-serif;
                                  font-size:34px;
                                  line-height:34px;
                                  font-weight:700;
                                  color:#0A0A0A;
                                  letter-spacing:-3px;
                                "
                              >${renderMailHeaderLogo()}</div>
                            </td>
                          </tr>

                          <tr>
                            <td style="padding:0 0 18px;">
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
                                    style="width:24px; padding:0 10px 0 0;"
                                  >
                                    ${
                                      ctaHref
                                        ? renderMailAccountApprovedIcon(28)
                                        : `<div style="width:19px; height:19px; border:2px solid #111111; border-radius:999px; font-size:11px; line-height:17px; text-align:center; font-weight:700; color:#111111;">!</div>`
                                    }
                                  </td>
                                  <td
                                    class="duo-account-heading"
                                    valign="middle"
                                    style="
                                      font-family:Arial, Helvetica, sans-serif;
                                      font-size:24px;
                                      line-height:28px;
                                      font-weight:700;
                                      color:#111111;
                                      letter-spacing:-0.6px;
                                    "
                                  >${escapeHtml(heading)}</td>
                                </tr>
                              </table>
                            </td>
                          </tr>

                          <tr>
                            <td style="padding:0 0 14px;">
                              <div style="height:1px; background:#c9c9c9; width:100%;"></div>
                            </td>
                          </tr>

                          <tr>
                            <td
                              class="duo-account-copy"
                              style="
                                font-family:Arial, Helvetica, sans-serif;
                                font-size:14px;
                                line-height:20px;
                                font-weight:400;
                                color:#111111;
                                padding:0;
                                text-align:left;
                              "
                            >
                              Hola <b>${escapeHtml(name)}</b>,<br />
                              ${messageHtml}
                            </td>
                          </tr>

                          ${
                            ctaLabel && ctaHref
                              ? `
                          <tr>
                            <td
                              class="duo-account-button-row"
                              align="center"
                              style="padding:50px 0 0;"
                            >
                              <table
                                role="presentation"
                                cellpadding="0"
                                cellspacing="0"
                                style="border-collapse:collapse; margin:0 auto;"
                              >
                                <tr>
                                  <td
                                    align="center"
                                    style="
                                      background:#EEFF00;
                                      border-radius:999px;
                                      box-shadow:0 12px 16px rgba(0,0,0,0.18);
                                    "
                                  >
                                    <a
                                      href="${escapeHtml(ctaHref)}"
                                      style="
                                        display:inline-block;
                                        padding:14px 22px;
                                        font-family:Arial, Helvetica, sans-serif;
                                        font-size:15px;
                                        line-height:16px;
                                        font-weight:700;
                                        color:#111111;
                                        text-decoration:none;
                                      "
                                    >${escapeHtml(ctaLabel)}</a>
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                              `
                              : ""
                          }

                          ${
                            noteHtml
                              ? `
                          <tr>
                            <td
                              style="
                                padding:34px 0 0;
                                font-family:Arial, Helvetica, sans-serif;
                                font-size:12px;
                                line-height:18px;
                                font-weight:600;
                                color:#111111;
                                text-align:left;
                              "
                            >${noteHtml}</td>
                          </tr>
                              `
                              : ""
                          }
                        </table>
                      </td>
                    </tr>

                    <tr>
                      <td
                        class="duo-account-footer"
                        style="
                          background:#0A0A0A;
                          padding:40px 48px 42px;
                          border-radius:0 0 28px 28px;
                          font-family:Arial, Helvetica, sans-serif;
                        "
                      >
                        <table
                          role="presentation"
                          cellpadding="0"
                          cellspacing="0"
                          width="100%"
                          style="border-collapse:collapse; width:100%;"
                        >
                          <tr>
                            <td
                              valign="middle"
                              style="
                                width:42%;
                                color:#ffffff;
                                font-family:Arial, Helvetica, sans-serif;
                              "
                            >
                              <div
                                class="duo-footer-brand"
                                style="
                                  font-size:23px;
                                  line-height:23px;
                                  font-weight:700;
                                  letter-spacing:7px;
                                "
                              >DUO</div>
                              <div
                                style="
                                  font-size:4px;
                                  line-height:7px;
                                  font-weight:700;
                                  letter-spacing:1.8px;
                                  margin-top:4px;
                                  opacity:0.95;
                                "
                              ></div>
                            </td>
                            <td
                              valign="middle"
                              align="right"
                              class="duo-footer-info"
                              style="
                                width:58%;
                                color:#ffffff;
                                font-family:Arial, Helvetica, sans-serif;
                                font-size:9px;
                                line-height:13px;
                                font-weight:500;
                                letter-spacing:0.2px;
                              "
                            >
                              <div style="font-weight:700; letter-spacing:2.8px; color:#ffffff; text-decoration:none;"><span style="color:#ffffff; text-decoration:none;">DUOCLUB.AR</span></div>
                              <div style="color:#ffffff; text-decoration:none;"><span style="color:#ffffff; text-decoration:none;">+54 249 420 7343</span></div>
                              <div style="color:#ffffff; text-decoration:none;"><span style="color:#ffffff; text-decoration:none;">Av. Santamaría 54, Tandil.</span></div>
                              <div style="padding-top:6px; font-size:10px; line-height:10px; letter-spacing:4px;">${renderMailFooterIcons()}</div>
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
}

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

  const html = isApproved
    ? buildAccountResultVisualEmail({
        title,
        preheader,
        heading: "Cuenta aprobada",
        name: uName,
        messageHtml: `Tu cuenta de <b>${escapeHtml(
          BRAND_NAME
        )}</b> ya fue aprobada!<br />Ya podés ingresar y comenzar a usar la plataforma.`,
        ctaLabel: `Ingresar a ${BRAND_NAME}`,
        ctaHref: BRAND_URL || "#",
      })
    : buildAccountResultVisualEmail({
        title,
        preheader,
        heading: "Cuenta rechazada",
        name: uName,
        messageHtml: `Tu cuenta de <b>${escapeHtml(
          BRAND_NAME
        )}</b> no pudo ser aprobada.`,
        noteHtml:
          "Si creés que esto es un error, respondé este mail o comunicate con el staff.",
      });

  await sendMail(user.email, `${title} - ${BRAND_NAME}`, text, html);
}
