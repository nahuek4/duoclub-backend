// backend/src/mail/subscriptionEmails.js
import { BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { escapeHtml } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";
import { renderUnifiedMailFooter } from "./ui.js";

const TZ = "America/Argentina/Buenos_Aires";
const IMG_BASE = "https://api.duoclub.ar/images";


const SERVICE_LABELS = {
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  SYN: "Synergy",
  KD: "Kinefilaxia Deportiva",
  NUT: "Nutrición",
};

function clean(value) {
  return String(value || "").trim();
}

function moneyARS(value) {
  const n = Number(value || 0);
  try {
    return new Intl.NumberFormat("es-AR", {
      style: "currency",
      currency: "ARS",
      maximumFractionDigits: 0,
    }).format(Number.isFinite(n) ? n : 0);
  } catch {
    return `$ ${Math.round(Number.isFinite(n) ? n : 0).toLocaleString("es-AR")}`;
  }
}

function monthLabel(periodKey) {
  const [year, month] = clean(periodKey).split("-").map(Number);
  if (!year || !month) return clean(periodKey) || "este mes";

  try {
    return new Intl.DateTimeFormat("es-AR", {
      timeZone: TZ,
      month: "long",
      year: "numeric",
    }).format(new Date(`${year}-${String(month).padStart(2, "0")}-01T12:00:00-03:00`));
  } catch {
    return `${String(month).padStart(2, "0")}/${year}`;
  }
}

function dateAR(value) {
  if (!value) return "-";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "-";

  try {
    return new Intl.DateTimeFormat("es-AR", {
      timeZone: TZ,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(d);
  } catch {
    return d.toLocaleDateString("es-AR");
  }
}

function payMethodLabel(value) {
  return clean(value).toUpperCase() === "MP"
    ? "Mercado Pago"
    : "Efectivo / transferencia";
}

function serviceLabel(serviceKey, fallback = "") {
  const key = clean(serviceKey).toUpperCase();
  return SERVICE_LABELS[key] || clean(fallback) || key || "Servicio";
}

function firstName(user = {}) {
  return clean(user?.name) || "Usuario";
}

function miPlanUrl() {
  const root = clean(BRAND_URL || "https://duoclub.ar").replace(/\/+$/, "");
  return `${root}/agenda/mi-plan`;
}

function duoFont() {
  return `'Helvetica Neue', Helvetica, Arial, sans-serif`;
}

function infoCard(label, value) {
  return `
    <td width="50%" valign="top" style="padding:5px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
        style="border-collapse:separate;border-spacing:0;background:#F1F1EE;border-radius:16px;">
        <tr>
          <td style="padding:15px 14px 16px;font-family:${duoFont()};color:#111111;">
            <div style="font-size:10px;line-height:13px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:#777;margin-bottom:6px;">
              ${escapeHtml(label)}
            </div>
            <div style="font-size:16px;line-height:21px;font-weight:700;color:#111111;">
              ${escapeHtml(value)}
            </div>
          </td>
        </tr>
      </table>
    </td>
  `;
}

function buildRenewalEmailHtml({
  user,
  serviceKey,
  serviceName,
  periodKey,
  monthlySessions,
  amount,
  payMethod,
  dueAt,
  nextRenewalAt,
  billingStatus = "pending",
  extraSessionsNeeded = 0,
}) {
  const svc = serviceLabel(serviceKey, serviceName);
  const period = monthLabel(periodKey);
  const statusText =
    clean(billingStatus).toLowerCase() === "paid" ? "Pagado" : "Pago pendiente";

  const extra = Math.max(0, Number(extraSessionsNeeded || 0));

  return buildEmailLayout({
    title: `${BRAND_NAME} · Plan renovado`,
    preheader: `Tu plan de ${svc} se renovó para ${period}`,
    footerNote: "",
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

        @media only screen and (max-width:560px){
          .sub-wrap{width:100%!important;max-width:390px!important}
          .sub-body{padding:22px 18px 26px!important}
          .sub-title{font-size:27px!important;line-height:31px!important}
          .sub-grid td{display:block!important;width:100%!important}
        }
      </style>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr>
          <td align="center">
            <table class="sub-wrap" role="presentation" cellpadding="0" cellspacing="0" width="100%"
              style="max-width:410px;border-collapse:separate;border-spacing:0;background:#FBFBFB;border-radius:28px;overflow:hidden;">
              <tr>
                <td style="background:#0A0A0A;padding:20px 22px 22px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                    <tr>
                      <td valign="top">
                        <img src="${IMG_BASE}/iconocheck.png" width="40" height="40" alt=""
                          style="display:block;width:40px;height:40px;border:0;" />
                      </td>
                      <td valign="top" align="right">
                        <img src="${IMG_BASE}/logo.png" width="34" alt="${escapeHtml(BRAND_NAME)}"
                          style="display:block;width:34px;height:auto;border:0;" />
                      </td>
                    </tr>
                  </table>

                  <div class="sub-title" style="margin-top:16px;font-family:${duoFont()};font-size:30px;line-height:34px;font-weight:750;letter-spacing:-1px;color:#fff;">
                    Tu plan se renovó.
                  </div>
                  <div style="margin-top:7px;font-family:${duoFont()};font-size:14px;line-height:20px;color:#D7D7D7;">
                    ${escapeHtml(svc)} · ${escapeHtml(period)}
                  </div>
                </td>
              </tr>

              <tr>
                <td class="sub-body" style="padding:24px 22px 28px;font-family:${duoFont()};color:#111;">
                  <div style="font-size:16px;line-height:24px;margin-bottom:18px;">
                    Hola <b>${escapeHtml(firstName(user))}</b>,<br />
                    tu plan mensual se renovó correctamente y ya acreditamos
                    <b>${escapeHtml(String(monthlySessions))} ${Number(monthlySessions) === 1 ? "sesión" : "sesiones"}</b>
                    para este período.
                  </div>

                  <table class="sub-grid" role="presentation" cellpadding="0" cellspacing="0" width="100%"
                    style="border-collapse:separate;border-spacing:0;margin:0 -5px 8px;width:calc(100% + 10px);">
                    <tr>
                      ${infoCard("Plan actual", `${monthlySessions} ${Number(monthlySessions) === 1 ? "sesión" : "sesiones"}`)}
                      ${infoCard("Valor mensual", moneyARS(amount))}
                    </tr>
                    <tr>
                      ${infoCard("Forma de pago", payMethodLabel(payMethod))}
                      ${infoCard("Próxima renovación", dateAR(nextRenewalAt))}
                    </tr>
                  </table>

                  <table role="presentation" cellpadding="0" cellspacing="0" width="100%"
                    style="border-collapse:collapse;margin-top:15px;border-top:1px solid #deded8;">
                    <tr>
                      <td style="padding:15px 0 7px;font-size:13px;color:#666;">Período</td>
                      <td align="right" style="padding:15px 0 7px;font-size:13px;font-weight:700;color:#111;">
                        ${escapeHtml(period)}
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:7px 0;font-size:13px;color:#666;">Facturación</td>
                      <td align="right" style="padding:7px 0;font-size:13px;font-weight:700;color:#111;">
                        ${escapeHtml(statusText)}
                      </td>
                    </tr>
                    <tr>
                      <td style="padding:7px 0;font-size:13px;color:#666;">Vencimiento de pago</td>
                      <td align="right" style="padding:7px 0;font-size:13px;font-weight:700;color:#111;">
                        ${escapeHtml(dateAR(dueAt))}
                      </td>
                    </tr>
                  </table>

                  ${
                    extra > 0
                      ? `
                        <div style="margin-top:17px;padding:14px 15px;background:#111;color:#fff;border-radius:15px;font-size:13px;line-height:19px;">
                          <b style="color:#EEFF00;">Atención:</b>
                          este mes tus turnos fijos requieren
                          <b>${extra} ${extra === 1 ? "sesión adicional" : "sesiones adicionales"}</b>.
                          Podés completar la cobertura desde Mi Plan.
                        </div>
                      `
                      : ""
                  }

                  <div style="margin-top:18px;padding:14px 15px;background:#FFF7D6;border-radius:15px;font-size:12px;line-height:18px;color:#332900;">
                    Podés utilizar el plan desde el día 1. Si el pago continúa pendiente después del día 10,
                    el servicio se suspende temporalmente hasta regularizarlo.
                  </div>

                  <div style="text-align:center;margin-top:22px;">
                    <a href="${escapeHtml(miPlanUrl())}"
                      style="display:inline-block;background:#EEFF00;color:#111;text-decoration:none;border-radius:999px;padding:14px 22px;font-size:14px;line-height:18px;font-weight:700;">
                      Ver mi plan
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
}

export async function sendSubscriptionRenewalEmail({
  user,
  serviceKey,
  serviceName = "",
  periodKey,
  monthlySessions,
  amount,
  payMethod,
  dueAt,
  nextRenewalAt,
  billingStatus = "pending",
  extraSessionsNeeded = 0,
} = {}) {
  const to = clean(user?.email);
  if (!to) return { skipped: true, reason: "USER_WITHOUT_EMAIL" };

  // Los scripts de simulación del lifecycle usan dominios .invalid.
  // No intentamos entregar correo real en esos casos.
  if (/\.invalid$/i.test(to)) {
    return { skipped: true, reason: "TEST_EMAIL_DOMAIN" };
  }

  const svc = serviceLabel(serviceKey, serviceName);
  const period = monthLabel(periodKey);

  const subject = `Tu plan DUO se renovó · ${svc}`;

  const text = [
    `Hola ${firstName(user)},`,
    "",
    `Tu plan de ${svc} se renovó para ${period}.`,
    "",
    `Plan actual: ${monthlySessions} ${Number(monthlySessions) === 1 ? "sesión" : "sesiones"}`,
    `Valor mensual: ${moneyARS(amount)}`,
    `Forma de pago: ${payMethodLabel(payMethod)}`,
    `Período: ${period}`,
    `Próxima renovación: ${dateAR(nextRenewalAt)}`,
    `Estado del pago: ${clean(billingStatus).toLowerCase() === "paid" ? "Pagado" : "Pendiente"}`,
    `Vencimiento de pago: ${dateAR(dueAt)}`,
    "",
    `Ya acreditamos ${monthlySessions} ${Number(monthlySessions) === 1 ? "sesión" : "sesiones"} para este período.`,
    Number(extraSessionsNeeded || 0) > 0
      ? `Este mes necesitás ${Number(extraSessionsNeeded)} ${Number(extraSessionsNeeded) === 1 ? "sesión adicional" : "sesiones adicionales"} para cubrir todos tus turnos fijos.`
      : "",
    "",
    "Podés revisar el detalle desde Mi Plan:",
    miPlanUrl(),
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildRenewalEmailHtml({
    user,
    serviceKey,
    serviceName,
    periodKey,
    monthlySessions,
    amount,
    payMethod,
    dueAt,
    nextRenewalAt,
    billingStatus,
    extraSessionsNeeded,
  });

  await sendMail(to, subject, text, html);
  return { sent: true, to, subject };
}
