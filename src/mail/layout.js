// backend/src/mail/layout.js
import { BRAND_NAME } from "./core.js";
import { EMAIL_FONT, escapeHtml } from "./helpers.js";

const IMG_BASE = "https://api.duoclub.ar/images";
const MAIL_BG_URL = `${IMG_BASE}/fondoMailing.png`;
const MAIL_BG_STYLE = `background-color:#000000; background-image:url('${MAIL_BG_URL}'); background-repeat:repeat-y; background-position:top center; background-size:430px auto;`;

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
  <body background="${MAIL_BG_URL}" style="margin:0; padding:0; ${MAIL_BG_STYLE}">
    ${preheaderHtml}

    <div style="margin:0; padding:32px 0; ${MAIL_BG_STYLE}">
      <table
        role="presentation"
        cellpadding="0"
        cellspacing="0"
        width="100%"
        background="${MAIL_BG_URL}" style="border-collapse:collapse; ${MAIL_BG_STYLE}"
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
                    ${String(bodyHtml || "")}
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
                    color:#ffffff;
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