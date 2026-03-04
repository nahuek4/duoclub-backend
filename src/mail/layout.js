import { BRAND_NAME } from "./core.js";
import { escapeHtml } from "./helpers.js";

const EMAIL_FONT =
  "'Helvetica Now Display', 'Helvetica Neue', Helvetica, Arial, sans-serif";

export function buildEmailLayout({ title, preheader, bodyHtml, footerNote }) {
  const _title = escapeHtml(title || BRAND_NAME);
  const _pre = escapeHtml(preheader || "");
  const _footer = escapeHtml(
    footerNote ||
      "Si no reconocés esta acción, respondé a este correo y lo revisamos."
  );

  const preheaderHtml = _pre
    ? `<div style="display:none; font-size:1px; color:#ffffff; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden;">${_pre}</div>`
    : "";

  return `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
    <title>${_title}</title>
  </head>
  <body style="margin:0; padding:0; background:#e9e9e9;">
    ${preheaderHtml}
    <div style="margin:0; padding:24px 0; background:#e9e9e9;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; background:#e9e9e9;">
        <tr>
          <td align="center" style="padding:0 10px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px; border-collapse:collapse;">
              <tr>
                <td style="background:#e9e9e9; padding:8px 0 16px;">
                  <div style="font-family:${EMAIL_FONT}; color:#111111; text-align:center;">
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
                  <div style="font-family:${EMAIL_FONT}; font-size:12px; line-height:18px; color:#5f5f5f;">
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