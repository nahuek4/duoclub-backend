// backend/src/mail/fixedScheduleRenewalEmails.js
import { BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { escapeHtml } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";
import { renderUnifiedMailFooter } from "./ui.js";

const IMG_BASE = "https://api.duoclub.ar/images";
const FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
const TZ = "America/Argentina/Buenos_Aires";

export async function sendFixedScheduleRenewalEmail({
  user,
  serviceName,
  periodKey,
  appointments = [],
}) {
  const email = String(user?.email || "").trim();

  if (!email || /@[^@]*\.invalid$/i.test(email)) {
    return { skipped: true, reason: "MISSING_OR_TEST_EMAIL" };
  }

  const period = new Intl.DateTimeFormat("es-AR", {
    month: "long",
    year: "numeric",
    timeZone: TZ,
  }).format(new Date(`${periodKey}-01T12:00:00-03:00`));

  const name = String(user?.name || "").trim() || "Usuario";
  const service = String(serviceName || "").trim();
  const url = `${String(BRAND_URL).replace(/\/+$/, "")}/agenda`;
  const subject = `${BRAND_NAME} · Se renovaron tus turnos fijos`;

  const rows = [...appointments]
    .sort((a, b) =>
      `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)
    )
    .map((ap) => {
      const [year, month, day] = ap.date.split("-");
      return `${day}/${month}/${year} · ${ap.time} hs`;
    });

  const text = [
    `Hola ${name},`,
    "",
    `Se renovaron tus turnos fijos de ${service} para ${period}.`,
    "",
    ...rows,
    "",
    `Podés consultar tus turnos en ${url}.`,
    "Si necesitás hacer un cambio, comunicate con DUO.",
  ].join("\n");

  const html = buildEmailLayout({
    title: subject,
    preheader: `Tus turnos de ${service} para ${period} ya están disponibles.`,
    footerNote: "Este correo confirma la renovación de tus horarios fijos.",
    bodyHtml: `
      <style>
        .sub-wrap b,
        .sub-wrap strong {
          font-weight:700 !important;
        }

        a[x-apple-data-detectors],
        .sub-footer-info a,
        .sub-footer-info a:link,
        .sub-footer-info a:visited,
        .sub-footer-info span {
          color:#ffffff !important;
          text-decoration:none !important;
        }

        @media only screen and (max-width:560px) {
          .sub-wrap {
            width:100%!important;
            max-width:390px!important;
          }
          .sub-body {
            padding:22px 18px 26px!important;
          }
          .sub-title {
            font-size:27px!important;
            line-height:31px!important;
          }
        }
      </style>

      <table role="presentation" cellpadding="0" cellspacing="0"
        width="100%" style="border-collapse:collapse;">
        <tr>
          <td align="center">

            <table class="sub-wrap" role="presentation"
              cellpadding="0" cellspacing="0" width="100%"
              style="max-width:410px;border-collapse:separate;
                border-spacing:0;background:#FBFBFB;
                border-radius:28px;overflow:hidden;">

              <tr>
                <td style="background:#0A0A0A;padding:20px 22px 22px;">

                  <table role="presentation" cellpadding="0"
                    cellspacing="0" width="100%">
                    <tr>
                      <td valign="top">
                        <img src="${IMG_BASE}/iconocheck.png"
                          width="40" height="40" alt=""
                          style="display:block;width:40px;
                            height:40px;border:0;" />
                      </td>
                      <td valign="top" align="right">
                        <img src="${IMG_BASE}/logo.png"
                          width="34" alt="${escapeHtml(BRAND_NAME)}"
                          style="display:block;width:34px;
                            height:auto;border:0;" />
                      </td>
                    </tr>
                  </table>

                  <div class="sub-title"
                    style="margin-top:16px;font-family:${FONT};
                      font-size:30px;line-height:34px;font-weight:750;
                      letter-spacing:-1px;color:#fff;">
                    Se renovaron<br />tus turnos fijos.
                  </div>

                  <div style="margin-top:7px;font-family:${FONT};
                    font-size:14px;line-height:20px;color:#D7D7D7;">
                    ${escapeHtml(service)} · ${escapeHtml(period)}
                  </div>

                </td>
              </tr>

              <tr>
                <td class="sub-body"
                  style="padding:24px 22px 28px;
                    font-family:${FONT};color:#111;">

                  <div style="font-size:16px;line-height:24px;
                    margin-bottom:18px;">
                    Hola <b>${escapeHtml(name)}</b>,<br />
                    tus turnos fijos se renovaron correctamente
                    y ya están disponibles para este período.
                  </div>

                  <table role="presentation" cellpadding="0"
                    cellspacing="0" width="100%"
                    style="border-collapse:separate;border-spacing:0;
                      background:#F1F1EE;border-radius:16px;">
                    <tr>
                      <td style="padding:16px;font-family:${FONT};">

                        <div style="font-size:10px;line-height:13px;
                          font-weight:700;letter-spacing:.7px;
                          text-transform:uppercase;color:#777;
                          margin-bottom:10px;">
                          Tus turnos del mes
                        </div>

                        ${rows.map((row) => `
                          <div style="padding:6px 0;font-size:14px;
                            line-height:20px;font-weight:700;color:#111;">
                            ${escapeHtml(row)}
                          </div>
                        `).join("")}

                      </td>
                    </tr>
                  </table>

                  <div style="margin-top:18px;font-size:13px;
                    line-height:20px;color:#666;">
                    Si necesitás hacer un cambio, comunicate con DUO.
                  </div>

                  <div style="text-align:center;margin-top:22px;">
                    <a href="${escapeHtml(url)}"
                      style="display:inline-block;background:#EEFF00;
                        color:#111;text-decoration:none;
                        border-radius:999px;padding:14px 22px;
                        font-size:14px;line-height:18px;font-weight:700;">
                      Ver mis turnos
                    </a>
                  </div>

                </td>
              </tr>

              ${renderUnifiedMailFooter({ className: "sub-footer" })}

            </table>

          </td>
        </tr>
      </table>
    `,
  });

  await sendMail(email, subject, text, html);
  return { sent: true };
}