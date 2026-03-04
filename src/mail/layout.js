import { BRAND_NAME, BRAND_URL } from "./core.js";
import { escapeHtml } from "./helpers.js";

/**
 * Layout visual unificado inspirado en los mockups:
 * - fondo gris claro
 * - contenido centrado
 * - cuerpo en bloque limpio
 */
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
                <td align="center" style="padding:0 0 8px;">
                  <div style="font-family:Arial,Helvetica,sans-serif; font-size:13px; line-height:18px; color:#111111; font-weight:800; letter-spacing:.2px;">
                    ${
                      BRAND_URL
                        ? `<a href="${BRAND_URL}" style="color:#111111; text-decoration:none;">${escapeHtml(
                            BRAND_NAME
                          )}</a>`
                        : escapeHtml(BRAND_NAME)
                    }
                  </div>
                </td>
              </tr>

              <tr>
                <td style="background:#e9e9e9; padding:0 0 12px;">
                  <div style="font-family:Arial,Helvetica,sans-serif; color:#111111; text-align:center;">
                    ${String(bodyHtml || "")}
                  </div>
                </td>
              </tr>

              <tr>
                <td align="center" style="padding:8px 14px 0;">
                  <div style="font-family:Arial,Helvetica,sans-serif; font-size:12px; line-height:18px; color:#5f5f5f;">
                    ${_footer}
                  </div>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  </body>
</html>`;
}

export function renderStatusIconCircle(symbol = "✓") {
  const safe = escapeHtml(symbol);
  return `
    <div style="width:58px; height:58px; border-radius:999px; background:#000; color:#fff; margin:0 auto 14px; text-align:center; line-height:58px; font-size:38px; font-weight:900; font-family:Arial,Helvetica,sans-serif;">
      ${safe}
    </div>
  `;
}

export function renderHeroTitle(text = "") {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif; font-size:22px; line-height:26px; color:#111; font-weight:900; text-align:center; margin:0 auto 18px; max-width:420px;">
      ${escapeHtml(text)}
    </div>
  `;
}

export function renderBodyCopy(html = "") {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:21px; color:#111; text-align:center; max-width:430px; margin:0 auto;">
      ${String(html || "")}
    </div>
  `;
}

export function renderTurnCards(items = []) {
  const rows = (Array.isArray(items) ? items : [])
    .map(
      (it) => `
      <div style="border:1px solid #dfff00; border-radius:8px; padding:10px 12px; margin:0 0 10px; text-align:left;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
          <tr>
            <td style="font-family:Arial,Helvetica,sans-serif; font-size:16px; line-height:18px; font-weight:900; color:#e9ff00;">
              ${escapeHtml(it?.date || "-")}
            </td>
            <td align="right" style="font-family:Arial,Helvetica,sans-serif; font-size:16px; line-height:18px; font-weight:900; color:#e9ff00;">
              ${escapeHtml(it?.time || "-")}
            </td>
          </tr>
          <tr>
            <td colspan="2" style="padding-top:4px; font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:18px; font-weight:700; color:#ffffff;">
              ${escapeHtml(it?.service || "-")}
            </td>
          </tr>
        </table>
      </div>
    `
    )
    .join("");

  return `
    <div style="background:#060606; border-radius:8px; padding:18px; margin:0 auto 18px; max-width:480px;">
      ${
        rows ||
        `<div style="font-family:Arial,Helvetica,sans-serif; font-size:14px; line-height:18px; color:#ffffff;">Sin turnos para mostrar.</div>`
      }
    </div>
  `;
}