// backend/src/mail.js
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

// ✅ ahora soporta HTML (mantiene compatibilidad con llamadas viejas)
export async function sendMail(to, subject, text, html) {
  const tx = getTransporter();

  if (!tx) {
    console.log("[MAIL MOCK]", { to, subject, text, html });
    return;
  }

  const from = process.env.MAIL_FROM || process.env.SMTP_USER;

  const payload = { from, to, subject };

  // mandamos ambos si existen (mejor deliverability + fallback)
  if (text) payload.text = text;
  if (html) payload.html = html;

  await tx.sendMail(payload);
}

/** ✅ Verificación de email (HTML + texto) */
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

/** Bienvenida al crear usuario (admin flow) */
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

/** Turno agendado */
export async function sendAppointmentBookedEmail(user, ap, serviceName) {
  if (!user?.email) return;
  const lines = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Tu turno fue reservado con éxito.",
    "",
    `Día: ${ap.date}`,
    `Horario: ${ap.time}`,
    serviceName ? `Servicio: ${serviceName}` : "",
    "",
    "Si no podés asistir, recordá cancelarlo con anticipación desde tu perfil.",
  ];
  await sendMail(user.email, "Tu turno fue reservado", lines.filter(Boolean).join("\n"));
}

/** Turno cancelado */
export async function sendAppointmentCancelledEmail(user, ap, serviceName) {
  if (!user?.email) return;
  const lines = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Tu turno fue cancelado.",
    "",
    `Día: ${ap.date}`,
    `Horario: ${ap.time}`,
    serviceName ? `Servicio: ${serviceName}` : "",
    "",
    "Si fue un error, podés volver a reservar desde la agenda.",
  ];
  await sendMail(user.email, "Tu turno fue cancelado", lines.filter(Boolean).join("\n"));
}

/** Recordatorio 24 hs antes */
export async function sendAppointmentReminderEmail(user, ap, serviceName) {
  if (!user?.email) return;
  const lines = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Te recordamos que tenés un turno agendado en las próximas 24 horas.",
    "",
    `Día: ${ap.date}`,
    `Horario: ${ap.time}`,
    serviceName ? `Servicio: ${serviceName}` : "",
    "",
    "Te esperamos. Si no podés asistir, cancelá el turno para liberar el espacio.",
  ];
  await sendMail(user.email, "Recordatorio de turno", lines.filter(Boolean).join("\n"));
}

/** Aviso de apto vencido */
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

/* =========================================================
   ✅ NUEVO: Email al admin por orden nueva
   - CASH: se manda al crear la orden
   - MP: se manda SOLO cuando llega approved al webhook
========================================================= */

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
