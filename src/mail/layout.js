// backend/src/mail/layout.js
import { BRAND_NAME } from "./core.js";
import { EMAIL_FONT, escapeHtml } from "./helpers.js";

const MAIL_BG_URL = "https://api.duoclub.ar/images/fondoMailing.png";

const MAIL_BG_CLASSES = [
  "mail-shell",
  "duo-verify-content",
  "duo-reg-content",
  "duo-account-content",
  "duo-admin-content",
  "duo-admin-reg-content",
  "duo-pay-content",
];

function addNotificationBackground(bodyHtml = "") {
  let html = String(bodyHtml || "");

  for (const className of MAIL_BG_CLASSES) {
    const tdWithStyle = new RegExp(
      `(<td\\b(?=[^>]*class=["'][^"']*${className}[^"']*["'])(?=[^>]*style=["'])([^>]*style=["'])([^"']*)(["'][^>]*>)`,
      "gi"
    );

    html = html.replace(tdWithStyle, (_match, start, styleAttr, styleValue, end) => {
      if (String(styleValue || "").includes(MAIL_BG_URL)) {
        return `${start}${styleAttr}${styleValue}${end}`;
      }

      const cleanStyle = String(styleValue || "").trim().replace(/;*\\s*$/, "");
      const bgStyle = [
        cleanStyle,
        `background-image:url('${MAIL_BG_URL}')`,
        "background-repeat:repeat-y",
        "background-position:top center",
        "background-size:430px auto",
        "background-color:#ffffff",
      ]
        .filter(Boolean)
        .join("; ");

      return `${start}${styleAttr}${bgStyle};${end}`;
    });
  }

  return html;
}

export function buildEmailLayout({ title, preheader, bodyHtml, footerNote }) {
  const _title = escapeHtml(title || BRAND_NAME);
  const _pre = escapeHtml(preheader || "");
  const _footer = escapeHtml(
    footerNote ||
      "Si no reconocés esta acción, respondé a este correo y lo revisamos."
  );

  const preheaderHtml = _pre
    ? `<div style="
        display:none;
        font-size:1px;
        color:#ffffff;
        line-height:1px;
        max-height:0;
        max-width:0;
        opacity:0;
        overflow:hidden;
      ">${_pre}</div>`
    : "";

  return `<!doctype html>
<html lang="es">
  <head>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${_title}</title>
  </head>
  <body style="margin:0; padding:0; background:#ffffff;">
    ${preheaderHtml}

    <div style="margin:0; padding:24px 0; background:#ffffff;">
      <table
        role="presentation"
        cellpadding="0"
        cellspacing="0"
        width="100%"
        style="border-collapse:collapse; background:#ffffff;"
      >
        <tr>
          <td align="center" style="padding:0 10px;">
            <table
              role="presentation"
              cellpadding="0"
              cellspacing="0"
              width="100%"
              style="max-width:560px; border-collapse:collapse;"
            >
              <tr>
                <td style="background:#ffffff; padding:8px 0 16px;">
                  <div style="
                    font-family:${EMAIL_FONT};
                    color:#111111;
                    text-align:center;
                  ">
                    ${addNotificationBackground(bodyHtml)}
                  </div>
                </td>
              </tr>

              ${
                footerNote === ""
                  ? ""
                  : `
              <tr>
                <td align="center" style="padding:8px 14px 0;">
                  <div style="
                    font-family:${EMAIL_FONT};
                    font-size:12px;
                    line-height:18px;
                    color:#5f5f5f;
                  ">
                    ${_footer}
                  </div>
                </td>
              </tr>
              `
              }
            </table>
          </td>
        </tr>
      </table>
    </div>
  </body>
</html>`;
}