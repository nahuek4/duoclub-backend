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
