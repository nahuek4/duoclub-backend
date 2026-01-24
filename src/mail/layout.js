import { BRAND_NAME, BRAND_URL } from "./core.js";
import { escapeHtml } from "./helpers.js";

export function buildEmailLayout({ title, preheader, bodyHtml, footerNote }) {
  const _title = escapeHtml(title || BRAND_NAME);
  const _pre = escapeHtml(preheader || "");
  const _footer = escapeHtml(
    footerNote ||
      "Si no reconocés esta acción, respondé a este correo y lo revisamos."
  );

  const preheaderHtml = _pre
    ? `<div style="display:none; font-size:1px; color:#fff; line-height:1px; max-height:0px; max-width:0px; opacity:0; overflow:hidden;">
         ${_pre}
       </div>`
    : "";

  return `
  <!doctype html>
  <html>
    <head>
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
      <title>${_title}</title>
    </head>
    <body style="margin:0; padding:0; background:#f5f6f8;">
      ${preheaderHtml}

      <div style="padding:24px 12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
          <tr>
            <td align="center">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:620px; border-collapse:collapse;">
                <tr>
                  <td style="padding:6px 6px 14px;">
                    <div style="font-family: Arial, sans-serif; font-weight:800; letter-spacing:.2px; color:#111; font-size:18px;">
                      ${
                        BRAND_URL
                          ? `<a href="${BRAND_URL}" style="color:#111; text-decoration:none;">${BRAND_NAME}</a>`
                          : BRAND_NAME
                      }
                    </div>
                  </td>
                </tr>

                <tr>
                  <td style="background:#ffffff; border:1px solid #e7e7ea; border-radius:16px; overflow:hidden;">
                    <div style="padding:22px 20px; font-family: Arial, sans-serif; color:#111; line-height:1.45;">
                      ${bodyHtml || ""}
                    </div>
                  </td>
                </tr>

                <tr>
                  <td style="padding:12px 6px 0;">
                    <div style="font-family: Arial, sans-serif; color:#666; font-size:12px; line-height:1.4;">
                      ${_footer}
                    </div>
                    <div style="font-family: Arial, sans-serif; color:#999; font-size:12px; margin-top:8px;">
                      © ${new Date().getFullYear()} ${BRAND_NAME}
                    </div>
                  </td>
                </tr>

              </table>
            </td>
          </tr>
        </table>
      </div>
    </body>
  </html>
  `;
}
