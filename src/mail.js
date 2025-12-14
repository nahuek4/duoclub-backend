// backend/src/mail.js
import nodemailer from "nodemailer";

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } =
    process.env || {};

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

async function sendMail(to, subject, text) {
  const tx = getTransporter();
  if (!tx) {
    console.log("[MAIL MOCK]", { to, subject, text });
    return;
  }
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;
  await tx.sendMail({ from, to, subject, text });
}

/** ✅ Verificación de email */
export async function sendVerifyEmail(user, verifyUrl) {
  if (!user?.email) return;
  const lines = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Gracias por registrarte en DUO.",
    "",
    "Para validar tu email, ingresá a este link:",
    verifyUrl,
    "",
    "Si vos no creaste esta cuenta, ignorá este correo.",
  ];
  await sendMail(user.email, "Verificá tu email en DUO", lines.join("\n"));
}

/** Bienvenida al crear usuario (admin) */
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

/** ✅ Aprobación / Rechazo (opcional pero recomendado) */
export async function sendAccountApprovedEmail(user) {
  if (!user?.email) return;
  const lines = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Tu cuenta fue aprobada.",
    "Ya podés iniciar sesión en DUO.",
  ];
  await sendMail(user.email, "Tu cuenta fue aprobada", lines.join("\n"));
}

export async function sendAccountRejectedEmail(user) {
  if (!user?.email) return;
  const lines = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Tu cuenta fue rechazada por el administrador.",
    "Si creés que es un error, respondé este correo.",
  ];
  await sendMail(user.email, "Tu cuenta fue rechazada", lines.join("\n"));
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
  await sendMail(
    user.email,
    "Tu turno fue reservado",
    lines.filter(Boolean).join("\n")
  );
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
  await sendMail(
    user.email,
    "Tu turno fue cancelado",
    lines.filter(Boolean).join("\n")
  );
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
  await sendMail(
    user.email,
    "Recordatorio de turno",
    lines.filter(Boolean).join("\n")
  );
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
  await sendMail(
    user.email,
    "Es necesario actualizar tu apto médico",
    lines.join("\n")
  );
}
