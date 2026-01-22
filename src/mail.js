// backend/src/utils/mailer.js (o donde lo tengas)
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const {
    SMTP_HOST,
    SMTP_PORT,
    SMTP_USER,
    SMTP_PASS,
    SMTP_SECURE,
  } = process.env || {};

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log("[MAIL] SMTP no configurado. Se hará log en consola.");
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: String(SMTP_SECURE) === "true",
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });

  return transporter;
}

// ===============================
// Envío base
// ===============================
export async function sendMail(to, subject, text, html) {
  const tx = getTransporter();

  if (!tx) {
    console.log("[MAIL MOCK]", { to, subject, text, html });
    return;
  }

  const from = process.env.MAIL_FROM || process.env.SMTP_USER;

  const payload = { from, to, subject };

  if (text) payload.text = text;
  if (html) payload.html = html;

  await tx.sendMail(payload);
}

// =========================================================
// Helpers
// =========================================================
function safe(v) {
  return v == null ? "" : String(v);
}

function formatARS(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "-";
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(num);
}

function fmtDateEsAR(dateStr) {
  // dateStr: "YYYY-MM-DD"
  if (!dateStr) return "-";
  const s = String(dateStr);
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return s;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("es-AR", { weekday: "long", day: "2-digit", month: "long" });
}

function fmtDateShort(dateStr) {
  if (!dateStr) return "-";
  const s = String(dateStr);
  if (s.length >= 10 && s[4] === "-" && s[7] === "-") {
    return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  }
  return s;
}

function fmtTime(timeStr) {
  if (!timeStr) return "-";
  return String(timeStr).slice(0, 5);
}

function getBrand() {
  return {
    name: process.env.BRAND_NAME || "DUO",
    supportEmail: process.env.BRAND_SUPPORT_EMAIL || "hola@duoclub.ar",
    supportPhone: process.env.BRAND_SUPPORT_PHONE || "+54 9 249 420 7343",
    address: process.env.BRAND_ADDRESS || "Av. Santamaría 54, Tandil.",
    siteUrl: process.env.PUBLIC_WEB_URL || process.env.APP_URL || "",
    cancelHours: Number(process.env.CANCEL_HOURS || 12),
    scheduleText: process.env.BRAND_SCHEDULE || "Lun–Vie 07:00–21:00 · Sáb 08:00–13:00",
  };
}

function emailShell({ title, preheader, contentHtml }) {
  const brand = getBrand();
  const logo = process.env.BRAND_LOGO_URL || ""; // opcional

  const safeTitle = safe(title);
  const safePre = safe(preheader);

  return `
  <!doctype html>
  <html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safeTitle}</title>
  </head>
  <body style="margin:0; padding:0; background:#f5f7fb;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0; color:transparent;">
      ${safePre}
    </div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f5f7fb; padding:24px 0;">
      <tr>
        <td align="center" style="padding:0 14px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 8px 24px rgba(17,24,39,.08);">
            <!-- Header -->
            <tr>
              <td style="padding:18px 20px; background:linear-gradient(135deg,#0b0b0c 0%, #111827 70%, #0b0b0c 100%); color:#fff;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <div style="font-family:Arial,sans-serif; font-size:14px; opacity:.9;">${brand.name}</div>
                      <div style="font-family:Arial,sans-serif; font-size:20px; font-weight:800; margin-top:2px;">
                        ${safeTitle}
                      </div>
                    </td>
                    <td align="right" style="vertical-align:middle;">
                      ${
                        logo
                          ? `<img src="${logo}" alt="${brand.name}" width="40" height="40" style="border-radius:10px; display:block;" />`
                          : `<div style="width:40px;height:40px;border-radius:10px;background:rgba(255,255,255,.12);"></div>`
                      }
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Body -->
            <tr>
              <td style="padding:18px 20px; font-family:Arial,sans-serif; color:#111827; line-height:1.45;">
                ${contentHtml}
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:16px 20px; background:#f9fafb; font-family:Arial,sans-serif; color:#6b7280; font-size:12px; line-height:1.45;">
                <div><b>Contacto:</b> ${brand.supportEmail} · ${brand.supportPhone}</div>
                <div><b>Dirección:</b> ${brand.address}</div>
                <div><b>Horario:</b> ${brand.scheduleText}</div>
                ${
                  brand.siteUrl
                    ? `<div style="margin-top:8px;">Sitio: <a href="${brand.siteUrl}" style="color:#111827;">${brand.siteUrl}</a></div>`
                    : ""
                }
              </td>
            </tr>
          </table>

          <div style="max-width:620px; font-family:Arial,sans-serif; font-size:11px; color:#9ca3af; margin-top:10px;">
            Si no solicitaste esta acción, podés ignorar este email.
          </div>
        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
}

function pill(text) {
  return `<span style="display:inline-block; padding:6px 10px; border-radius:999px; background:#111827; color:#fff; font-size:12px; font-weight:700;">${safe(text)}</span>`;
}

function cardRow(label, value) {
  return `
    <tr>
      <td style="padding:10px 12px; border-bottom:1px solid #eef2f7; color:#6b7280; width:35%; font-size:13px;">
        ${safe(label)}
      </td>
      <td style="padding:10px 12px; border-bottom:1px solid #eef2f7; color:#111827; font-weight:700; font-size:13px;">
        ${safe(value) || "—"}
      </td>
    </tr>
  `;
}

function infoCard(rowsHtml) {
  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0"
      style="border:1px solid #e5e7eb; border-radius:14px; overflow:hidden; margin:14px 0;">
      ${rowsHtml}
    </table>
  `;
}

function buttonLink(href, label) {
  if (!href) return "";
  return `
    <div style="margin:14px 0 4px;">
      <a href="${href}"
        style="display:inline-block; background:#111827; color:#fff; text-decoration:none; padding:12px 16px; border-radius:12px; font-weight:800;">
        ${safe(label)}
      </a>
    </div>
  `;
}

// ===============================
// Emails existentes (no tocados)
// ===============================
export async function sendVerifyEmail(user, verifyUrl) {
  if (!user?.email) return;

  const textLines = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Gracias por registrarte en DUO.",
    "",
    "Para continuar, verificá tu email en este link (si no abre, copiá y pegá en el navegador):",
    "",
    verifyUrl,
    "",
    "Este link vence en 24 horas.",
    "",
    "Si vos no creaste esta cuenta, podés ignorar este email.",
  ];

  const html = `
  <div style="font-family: Arial, sans-serif; line-height: 1.4; color:#111;">
    <h2 style="margin:0 0 12px;">Verificación de email</h2>
    <p>Hola ${user.name || ""},</p>
    <p>Gracias por registrarte en <b>DUO</b>.</p>
    <p>Para continuar, hacé click en el botón:</p>
    <p style="margin:18px 0;">
      <a href="${verifyUrl}"
         style="background:#111; color:#fff; padding:12px 16px; border-radius:8px; text-decoration:none; display:inline-block;">
        Verificar email
      </a>
    </p>
    <p style="font-size:12px; color:#444;">
      Si el botón no funciona, copiá y pegá este link en el navegador:
    </p>
    <p style="font-size:12px; word-break:break-all;">
      <a href="${verifyUrl}">${verifyUrl}</a>
    </p>
    <p style="font-size:12px; color:#444;">Este link vence en 24 horas.</p>
  </div>
  `;

  await sendMail(user.email, "Verificá tu email - DUO", textLines.join("\n"), html);
}

export async function sendUserWelcomeEmail(user, tempPassword) {
  if (!user?.email) return;
  const lines = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Te creamos un usuario en la plataforma de DUO.",
    "",
    "Estos son tus datos de acceso:",
    `Email: ${user.email}`,
    `Contraseña temporal: ${tempPassword}`,
    "",
    "Cuando ingreses por primera vez, el sistema te pedirá que cambies la contraseña.",
    "",
    "Cualquier duda, respondé a este correo.",
  ];
  await sendMail(user.email, "Tu usuario en DUO está listo", lines.join("\n"));
}

// =========================================================
// ✅ TURNO RESERVADO (PLANTILLA COPADA)
// =========================================================
export async function sendAppointmentBookedEmail(user, ap, serviceName) {
  if (!user?.email) return;

  const brand = getBrand();
  const name = (user?.name || user?.fullName || "").trim() || "Hola";

  const dateLong = fmtDateEsAR(ap?.date);
  const dateShort = fmtDateShort(ap?.date);
  const time = fmtTime(ap?.time);
  const svc = serviceName || ap?.service || "Turno";
  const notes = safe(ap?.notes || "");

  // Link opcional a perfil/agenda
  const profileUrl =
    brand.siteUrl ? `${String(brand.siteUrl).replace(/\/$/, "")}/perfil` : "";

  const subject = `✅ Turno reservado — ${dateShort} ${time}hs`;

  const text = [
    `Hola ${name},`,
    "",
    "¡Tu turno fue reservado con éxito!",
    "",
    `Servicio: ${svc}`,
    `Día: ${dateShort}`,
    `Horario: ${time} hs`,
    "",
    `Cancelación: recordá hacerlo con ${brand.cancelHours}hs o más para que se devuelva la sesión (si aplica).`,
    profileUrl ? `Gestioná tus turnos desde: ${profileUrl}` : "",
  ].filter(Boolean).join("\n");

  const contentHtml = `
    <p style="margin:0 0 10px;">Hola <b>${safe(name)}</b>,</p>
    <p style="margin:0 0 12px;">${pill("Turno confirmado")} Ya quedó agendado en nuestro sistema.</p>

    ${infoCard([
      cardRow("Servicio", svc),
      cardRow("Día", `${dateLong} (${dateShort})`),
      cardRow("Horario", `${time} hs`),
      notes ? cardRow("Notas", notes) : "",
    ].filter(Boolean).join(""))}

    <div style="margin-top:10px; padding:12px; border-radius:14px; background:#f3f4f6; border:1px solid #e5e7eb;">
      <div style="font-weight:800; margin-bottom:6px;">Recordatorio</div>
      <div style="color:#374151; font-size:13px;">
        Si no podés asistir, cancelá con <b>${brand.cancelHours}hs</b> o más de anticipación desde tu perfil para evitar inconvenientes.
      </div>
    </div>

    ${buttonLink(profileUrl, "Ver / gestionar mis turnos")}

    <div style="margin-top:14px; font-size:12px; color:#6b7280;">
      ¿Necesitás ayuda? Respondé a este mail o escribinos a <b>${brand.supportEmail}</b>.
    </div>
  `;

  const html = emailShell({
    title: "Reserva confirmada",
    preheader: `Tu turno: ${dateShort} a las ${time}hs · ${svc}`,
    contentHtml,
  });

  await sendMail(user.email, subject, text, html);
}

// =========================================================
// ✅ TURNO RESERVADO (BATCH MULTI) - para tu ClientBooking.jsx
// =========================================================
export async function sendAppointmentBookedBatchEmail(user, items = []) {
  if (!user?.email) return;

  const brand = getBrand();
  const name = (user?.name || user?.fullName || "").trim() || "Hola";

  const clean = Array.isArray(items) ? items : [];
  const sorted = clean
    .map((it) => ({
      service: it?.service || it?.serviceName || "-",
      date: safe(it?.date),
      time: fmtTime(it?.time),
    }))
    .filter((x) => x.date && x.time)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  const count = sorted.length;
  if (!count) return;

  const subject = `✅ Reservaste ${count} turno${count === 1 ? "" : "s"} — ${fmtDateShort(sorted[0].date)}`;

  const profileUrl =
    brand.siteUrl ? `${String(brand.siteUrl).replace(/\/$/, "")}/perfil` : "";

  const text = [
    `Hola ${name},`,
    "",
    `¡Reserva confirmada! Reservaste ${count} turno${count === 1 ? "" : "s"}:`,
    "",
    ...sorted.map((x) => `• ${fmtDateShort(x.date)} ${x.time}hs — ${x.service}`),
    "",
    `Cancelación: recordá hacerlo con ${brand.cancelHours}hs o más para que se devuelva la sesión (si aplica).`,
    profileUrl ? `Gestioná tus turnos desde: ${profileUrl}` : "",
  ].filter(Boolean).join("\n");

  const listHtml = `
    <div style="margin-top:10px; display:grid; gap:10px;">
      ${sorted.map((x) => `
        <div style="border:1px solid #e5e7eb; border-radius:14px; padding:12px; background:#fff;">
          <div style="font-weight:900; color:#111827;">${fmtDateShort(x.date)} · ${x.time} hs</div>
          <div style="color:#374151; margin-top:4px;">${safe(x.service)}</div>
          <div style="color:#6b7280; font-size:12px; margin-top:4px;">${fmtDateEsAR(x.date)}</div>
        </div>
      `).join("")}
    </div>
  `;

  const contentHtml = `
    <p style="margin:0 0 10px;">Hola <b>${safe(name)}</b>,</p>
    <p style="margin:0 0 12px;">${pill("Reserva confirmada")} Reservaste <b>${count}</b> turno${count === 1 ? "" : "s"}:</p>

    ${listHtml}

    <div style="margin-top:10px; padding:12px; border-radius:14px; background:#f3f4f6; border:1px solid #e5e7eb;">
      <div style="font-weight:800; margin-bottom:6px;">Recordatorio</div>
      <div style="color:#374151; font-size:13px;">
        Si no podés asistir, cancelá con <b>${brand.cancelHours}hs</b> o más de anticipación desde tu perfil.
      </div>
    </div>

    ${buttonLink(profileUrl, "Ver / gestionar mis turnos")}
  `;

  const html = emailShell({
    title: "Reserva confirmada",
    preheader: `Reservaste ${count} turno${count === 1 ? "" : "s"} en ${brand.name}`,
    contentHtml,
  });

  await sendMail(user.email, subject, text, html);
}

// =========================================================
// TURNO CANCELADO (puede quedar simple o también “copado”)
// =========================================================
export async function sendAppointmentCancelledEmail(user, ap, serviceName) {
  if (!user?.email) return;

  const brand = getBrand();
  const name = (user?.name || user?.fullName || "").trim() || "Hola";
  const dateShort = fmtDateShort(ap?.date);
  const time = fmtTime(ap?.time);
  const svc = serviceName || ap?.service || "Turno";

  const subject = `⚠️ Turno cancelado — ${dateShort} ${time}hs`;

  const text = [
    `Hola ${name},`,
    "",
    "Tu turno fue cancelado.",
    "",
    `Servicio: ${svc}`,
    `Día: ${dateShort}`,
    `Horario: ${time} hs`,
    "",
    "Si fue un error, podés volver a reservar desde la agenda.",
  ].join("\n");

  const contentHtml = `
    <p style="margin:0 0 10px;">Hola <b>${safe(name)}</b>,</p>
    <p style="margin:0 0 12px;">${pill("Turno cancelado")} Se canceló el siguiente turno:</p>

    ${infoCard([
      cardRow("Servicio", svc),
      cardRow("Día", `${fmtDateEsAR(ap?.date)} (${dateShort})`),
      cardRow("Horario", `${time} hs`),
    ].join(""))}

    <div style="margin-top:12px; color:#6b7280; font-size:12px;">
      Si fue un error, podés reservar nuevamente desde la agenda.
    </div>
  `;

  const html = emailShell({
    title: "Cancelación registrada",
    preheader: `Se canceló tu turno del ${dateShort} ${time}hs`,
    contentHtml,
  });

  await sendMail(user.email, subject, text, html);
}

export async function sendAppointmentReminderEmail(user, ap, serviceName) {
  if (!user?.email) return;

  const brand = getBrand();
  const name = (user?.name || user?.fullName || "").trim() || "Hola";
  const dateShort = fmtDateShort(ap?.date);
  const time = fmtTime(ap?.time);
  const svc = serviceName || ap?.service || "Turno";

  const subject = `⏰ Recordatorio de turno — ${dateShort} ${time}hs`;

  const text = [
    `Hola ${name},`,
    "",
    "Te recordamos que tenés un turno agendado en las próximas 24 horas.",
    "",
    `Servicio: ${svc}`,
    `Día: ${dateShort}`,
    `Horario: ${time} hs`,
    "",
    "Te esperamos. Si no podés asistir, cancelá el turno para liberar el espacio.",
  ].join("\n");

  const contentHtml = `
    <p style="margin:0 0 10px;">Hola <b>${safe(name)}</b>,</p>
    <p style="margin:0 0 12px;">${pill("Recordatorio")} Tenés un turno en las próximas 24 horas:</p>

    ${infoCard([
      cardRow("Servicio", svc),
      cardRow("Día", `${fmtDateEsAR(ap?.date)} (${dateShort})`),
      cardRow("Horario", `${time} hs`),
    ].join(""))}

    <div style="margin-top:10px; color:#374151; font-size:13px;">
      Si no podés asistir, por favor cancelá con anticipación para liberar el espacio.
    </div>
  `;

  const html = emailShell({
    title: "Recordatorio de turno",
    preheader: `Turno: ${dateShort} ${time}hs · ${svc}`,
    contentHtml,
  });

  await sendMail(user.email, subject, text, html);
}

export async function sendAptoExpiredEmail(user) {
  if (!user?.email) return;
  const lines = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Detectamos que todavía no subiste tu apto médico o ya pasaron más de 20 días desde tu alta.",
    "",
    "Por normativa interna, no podrás reservar nuevos turnos hasta que subas un apto válido.",
    "",
    "Podés subirlo desde tu perfil dentro de la plataforma.",
  ];
  await sendMail(user.email, "Es necesario actualizar tu apto médico", lines.join("\n"));
}

// =========================================================
// ORDENES → ADMIN
// =========================================================
export async function sendAdminNewOrderEmail(order, user) {
  const to = process.env.ADMIN_ORDERS_EMAIL || "duoclub.ar@gmail.com";
  if (!to) return;

  const pay = safe(order?.payMethod).toUpperCase() === "MP" ? "MercadoPago" : "Efectivo";
  const status = safe(order?.status || "").toUpperCase();
  const orderId = safe(order?._id);
  const createdAt = order?.createdAt
    ? new Date(order.createdAt).toLocaleString("es-AR")
    : "-";

  const customerName =
    `${safe(user?.name)} ${safe(user?.lastName)}`.trim() ||
    safe(order?.customerName) ||
    "-";

  const customerEmail =
    safe(user?.email) ||
    safe(order?.customerEmail) ||
    "-";

  const items = Array.isArray(order?.items) ? order.items : [];

  const lines = items.map((it, idx) => {
    const kind = safe(it.kind).toUpperCase();
    const qty = Math.max(1, Number(it.qty || 1));

    const title =
      kind === "MEMBERSHIP"
        ? (safe(it.action).toUpperCase() === "EXTEND" ? "DUO+ · Extender 1 mes" : "DUO+ mensual")
        : (safe(it.serviceTitle) || safe(it.label) || safe(it.serviceKey) || "Créditos");

    const credits = kind === "CREDITS" && it.credits ? ` (${it.credits} sesiones)` : "";
    const price = formatARS(it.price ?? it.priceUI ?? it.basePrice ?? 0);

    return `${idx + 1}. ${title}${credits} x${qty} — ${price}`;
  });

  const total = formatARS(order?.totalFinal ?? order?.total ?? order?.price ?? 0);

  const subject = `🛒 Nueva orden DUO (${pay})${status ? ` - ${status}` : ""} — ${customerName}`;

  const text = [
    "Nueva orden recibida",
    "",
    `Orden: ${orderId}`,
    `Fecha: ${createdAt}`,
    `Pago: ${pay}`,
    status ? `Estado: ${status}` : "",
    "",
    `Cliente: ${customerName}`,
    `Email: ${customerEmail}`,
    "",
    "Items:",
    ...(lines.length ? lines : ["(sin items)"]),
    "",
    `Total: ${total}`,
  ].filter(Boolean).join("\n");

  const html = `
  <div style="font-family: Arial, sans-serif; color:#111; line-height:1.35;">
    <h2 style="margin:0 0 10px;">Nueva orden recibida</h2>

    <div style="padding:12px; border:1px solid #ddd; border-radius:10px; margin:12px 0;">
      <div><b>Orden:</b> ${orderId || "-"}</div>
      <div><b>Fecha:</b> ${createdAt}</div>
      <div><b>Pago:</b> ${pay}</div>
      ${status ? `<div><b>Estado:</b> ${status}</div>` : ""}
    </div>

    <div style="padding:12px; border:1px solid #ddd; border-radius:10px; margin:12px 0;">
      <div><b>Cliente:</b> ${customerName || "-"}</div>
      <div><b>Email:</b> ${customerEmail || "-"}</div>
    </div>

    <div style="padding:12px; border:1px solid #ddd; border-radius:10px; margin:12px 0;">
      <div style="font-weight:700; margin-bottom:8px;">Items</div>
      <ul style="margin:0; padding-left:18px;">
        ${
          lines.length
            ? lines.map((l) => `<li style="margin:6px 0;">${safe(l)}</li>`).join("")
            : "<li>(sin items)</li>"
        }
      </ul>
    </div>

    <div style="text-align:right; font-size:16px; margin-top:10px;">
      <b>Total:</b> ${total}
    </div>
  </div>
  `;

  await sendMail(to, subject, text, html);
}

// =========================================================
// ✅ ADMISION → ADMIN (STEP 2 COMPLETADO)
// =========================================================
export async function sendAdminAdmissionStep2Email(admission, step1, step2) {
  const to = process.env.ADMIN_ORDERS_EMAIL || "duoclub.ar@gmail.com";
  if (!to) return;

  const admId = safe(admission?._id);
  const publicId = safe(admission?.publicId);
  const createdAt = admission?.createdAt
    ? new Date(admission.createdAt).toLocaleString("es-AR")
    : "-";

  const fullName =
    `${safe(admission?.name)} ${safe(admission?.lastName)}`.trim() ||
    `${safe(step1?.name)} ${safe(step1?.lastName)}`.trim() ||
    "-";

  const email =
    safe(admission?.email) ||
    safe(step1?.email) ||
    "-";

  const phone =
    safe(admission?.phone) ||
    safe(step1?.phone) ||
    "-";

  const subject = `📝 Admisión completada — ${fullName}${publicId ? ` (#${publicId})` : ""}`;

  const text = [
    "Nueva admisión completada",
    "",
    `ID: ${admId}`,
    publicId ? `PublicID: ${publicId}` : "",
    `Fecha: ${createdAt}`,
    "",
    `Nombre: ${fullName}`,
    `Email: ${email}`,
    `Tel: ${phone}`,
    "",
    "=== PASO 2 (resumen) ===",
    `Necesita rehabilitación: ${safe(step2?.needsRehab)}`,
    `Síntomas: ${safe(step2?.symptoms)}`,
    `Fecha lesión/síntomas: ${safe(step2?.symptomDate)}`,
    `Consulta médica: ${safe(step2?.medicalConsult)} ${safe(step2?.medicalConsultWhen)}`,
    `Estudios: ${safe(step2?.diagnosticStudy)} ${safe(step2?.diagnosticStudyOther)}`,
    `Cómo sucedió: ${safe(step2?.howHappened)}`,
    `Dolor diario: ${safe(step2?.dailyDiscomfort)}`,
    `Movilidad: ${safe(step2?.mobilityIssue)}`,
    `Medicación: ${safe(step2?.takesMedication)} ${safe(step2?.medicationDetail)}`,
    "",
    "=== DEPORTE ===",
    `Practica competitivo: ${safe(step2?.practicesCompetitiveSport)}`,
    `Nivel: ${safe(step2?.competitionLevel)}`,
    `Deporte: ${safe(step2?.sportName)}`,
    `Puesto: ${safe(step2?.sportPosition)}`,
    "",
    "=== PLAN ===",
    `Objetivo: ${safe(step2?.immediateGoal)}`,
    `Entrena solo: ${safe(step2?.trainAlone)}`,
    `Cantidad grupo: ${safe(step2?.groupCount)}`,
    `Horario ideal: ${safe(step2?.idealSchedule)}`,
    `Días preferidos: ${safe(step2?.preferredDays)}`,
    `Sesiones semanales: ${safe(step2?.weeklySessions)}`,
    `Modalidad: ${safe(step2?.modality)}`,
  ].filter(Boolean).join("\n");

  const html = `
  <div style="font-family: Arial, sans-serif; color:#111; line-height:1.35;">
    <h2>📝 Nueva admisión completada</h2>

    <div style="padding:12px; border:1px solid #ddd; border-radius:10px; margin:12px 0;">
      <div><b>ID:</b> ${admId || "-"}</div>
      ${publicId ? `<div><b>PublicID:</b> ${publicId}</div>` : ""}
      <div><b>Fecha:</b> ${createdAt}</div>
    </div>

    <div style="padding:12px; border:1px solid #ddd; border-radius:10px; margin:12px 0;">
      <div><b>Nombre:</b> ${fullName || "-"}</div>
      <div><b>Email:</b> ${email || "-"}</div>
      <div><b>Tel:</b> ${phone || "-"}</div>
    </div>

    <h3>Rehabilitación</h3>
    <ul>
      <li><b>Necesita:</b> ${safe(step2?.needsRehab)}</li>
      <li><b>Síntomas:</b> ${safe(step2?.symptoms)}</li>
      <li><b>Fecha:</b> ${safe(step2?.symptomDate)}</li>
      <li><b>Consulta médica:</b> ${safe(step2?.medicalConsult)} ${safe(step2?.medicalConsultWhen)}</li>
      <li><b>Estudios:</b> ${safe(step2?.diagnosticStudy)} ${safe(step2?.diagnosticStudyOther)}</li>
      <li><b>Cómo sucedió:</b> ${safe(step2?.howHappened)}</li>
      <li><b>Dolor diario:</b> ${safe(step2?.dailyDiscomfort)}</li>
      <li><b>Movilidad:</b> ${safe(step2?.mobilityIssue)}</li>
      <li><b>Medicación:</b> ${safe(step2?.takesMedication)} ${safe(step2?.medicationDetail)}</li>
    </ul>

    <h3>Deporte</h3>
    <ul>
      <li><b>Competitivo:</b> ${safe(step2?.practicesCompetitiveSport)}</li>
      <li><b>Nivel:</b> ${safe(step2?.competitionLevel)}</li>
      <li><b>Deporte:</b> ${safe(step2?.sportName)}</li>
      <li><b>Puesto:</b> ${safe(step2?.sportPosition)}</li>
    </ul>

    <h3>Plan</h3>
    <ul>
      <li><b>Objetivo:</b> ${safe(step2?.immediateGoal)}</li>
      <li><b>Entrena solo:</b> ${safe(step2?.trainAlone)}</li>
      <li><b>Grupo:</b> ${safe(step2?.groupCount)}</li>
      <li><b>Horario:</b> ${safe(step2?.idealSchedule)}</li>
      <li><b>Días:</b> ${safe(step2?.preferredDays)}</li>
      <li><b>Sesiones:</b> ${safe(step2?.weeklySessions)}</li>
      <li><b>Modalidad:</b> ${safe(step2?.modality)}</li>
    </ul>
  </div>
  `;

  await sendMail(to, subject, text, html);
}
