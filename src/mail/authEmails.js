import { BRAND_NAME, sendMail } from "./core.js";
import { escapeHtml, kvRow } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";

export async function sendVerifyEmail(user, verifyUrl) {
  if (!user?.email) return;

  const textLines = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    `Gracias por registrarte en ${BRAND_NAME}.`,
    "",
    "Para continuar, verificá tu email en este link (si no abre, copiá y pegá en el navegador):",
    "",
    verifyUrl,
    "",
    "Este link vence en 24 horas.",
    "",
    "Si vos no creaste esta cuenta, podés ignorar este email.",
  ];

  const bodyHtml = `
    <div style="font-size:18px; font-weight:800; margin-bottom:10px;">Verificación de email</div>
    <div style="color:#333; margin-bottom:12px;">Hola <b>${escapeHtml(
      user.name || ""
    )}</b>,</div>
    <div style="color:#333; margin-bottom:12px;">Para continuar, hacé click en el botón:</div>

    <div style="margin:16px 0;">
      <a href="${verifyUrl}" style="background:#111; color:#fff; padding:12px 16px; border-radius:10px; text-decoration:none; display:inline-block;">
        Verificar email
      </a>
    </div>

    <div style="font-size:12px; color:#555;">Si el botón no funciona, copiá y pegá este link:</div>
    <div style="font-size:12px; word-break:break-all; margin-top:6px;">
      <a href="${verifyUrl}">${verifyUrl}</a>
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Verificación de email`,
    preheader: "Verificá tu email para continuar",
    bodyHtml,
  });

  await sendMail(
    user.email,
    `Verificá tu email - ${BRAND_NAME}`,
    textLines.join("\n"),
    html
  );
}

export async function sendUserWelcomeEmail(user, tempPassword) {
  if (!user?.email) return;

  const lines = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    `Te creamos un usuario en la plataforma de ${BRAND_NAME}.`,
    "",
    "Estos son tus datos de acceso:",
    `Email: ${user.email}`,
    `Contraseña temporal: ${tempPassword}`,
    "",
    "Cuando ingreses por primera vez, el sistema te pedirá que cambies la contraseña.",
    "",
    "Cualquier duda, respondé a este correo.",
  ];

  const bodyHtml = `
    <div style="font-size:18px; font-weight:800; margin-bottom:10px;">Tu usuario está listo</div>
    <div style="color:#333; margin-bottom:12px;">Hola <b>${escapeHtml(
      user.name || ""
    )}</b>,</div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:10px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Email", user.email || "-")}
        ${kvRow("Contraseña temporal", tempPassword || "-")}
      </table>
    </div>

    <div style="margin-top:12px; font-size:12px; color:#666;">
      Al iniciar sesión por primera vez, el sistema te pedirá que cambies la contraseña.
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Usuario creado`,
    preheader: "Tu usuario ya está listo",
    bodyHtml,
  });

  await sendMail(
    user.email,
    `Tu usuario en ${BRAND_NAME} está listo`,
    lines.join("\n"),
    html
  );
}
