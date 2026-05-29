// backend/src/mail/layout.js
import { BRAND_NAME } from "./core.js";
import { EMAIL_FONT, escapeHtml } from "./helpers.js";

const MAIL_BG_URL = "https://api.duoclub.ar/images/fondoMailing.png";

const OUTER_BG_STYLE = `background-color:#000000; background-image:url('${MAIL_BG_URL}'); background-repeat:repeat; background-position:top center; background-size:360px auto;`;

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
  <body style="margin:0; padding:0; background-color:#000000;">
    ${preheaderHtml}

    <table
      role="presentation"
      cellpadding="0"
      cellspacing="0"
      border="0"
      width="100%"
      background="${MAIL_BG_URL}"
      style="width:100%; min-width:100%; border-collapse:collapse; ${OUTER_BG_STYLE}"
    >
      <tr>
        <td
          align="center"
          valign="top"
          background="${MAIL_BG_URL}"
          style="padding:32px 12px; ${OUTER_BG_STYLE}"
        >
          <!--[if gte mso 9]>
          <v:background xmlns:v="urn:schemas-microsoft-com:vml" fill="t">
            <v:fill type="tile" src="${MAIL_BG_URL}" color="#000000" />
          </v:background>
          <![endif]-->

          <table
            role="presentation"
            cellpadding="0"
            cellspacing="0"
            border="0"
            width="100%"
            style="width:100%; max-width:560px; border-collapse:collapse;"
          >
            <tr>
              <td style="background:#ffffff; padding:8px 0 16px; border-radius:0;">
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
              <td align="center" style="padding:12px 14px 0;">
                <div style="
                  font-family:${EMAIL_FONT};
                  font-size:12px;
                  line-height:18px;
                  color:#ffffff;
                  text-shadow:0 1px 2px rgba(0,0,0,.75);
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
  </body>
</html>`;
}
