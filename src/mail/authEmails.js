// backend/src/mail/authEmails.js
import { ADMIN_EMAIL, BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { escapeHtml, kvRow } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";

/* =========================================================
   AUTH EMAILS
========================================================= */

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

/* =========================================================
   ✅ NUEVO: Usuario -> registro recibido (pendiente)
========================================================= */
export async function sendUserRegistrationReceivedEmail(user) {
  if (!user?.email) return;

  const lines = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    `Recibimos tu registro en ${BRAND_NAME}.`,
    "Para poder ingresar:",
    "1) Verificá tu email (si todavía no lo hiciste).",
    "2) Esperá la aprobación del staff.",
    "",
    "Te avisamos por este medio cuando tu cuenta esté aprobada.",
    "",
    BRAND_URL ? `Sitio: ${BRAND_URL}` : "",
  ].filter(Boolean);

  const bodyHtml = `
    <div style="font-size:18px; font-weight:800; margin-bottom:10px;">Registro recibido</div>
    <div style="color:#333; margin-bottom:10px;">Hola <b>${escapeHtml(user.name || "")}</b>,</div>

    <div style="color:#333; margin-bottom:10px;">
      Recibimos tu registro en <b>${escapeHtml(BRAND_NAME)}</b>.
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:10px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Estado", "Pendiente de aprobación")}
        ${kvRow("Próximo paso", "Verificar email (si aún no lo hiciste)")}
      </table>
    </div>

    <div style="margin-top:12px; font-size:13px; color:#333;">
      Te avisamos por mail cuando el staff apruebe tu cuenta.
    </div>

    ${
      BRAND_URL
        ? `<div style="margin-top:16px;">
            <a href="${BRAND_URL}" style="background:#111; color:#fff; padding:12px 16px; border-radius:10px; text-decoration:none; display:inline-block;">
              Ir a DUO
            </a>
          </div>`
        : ""
    }
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Registro recibido`,
    preheader: "Registro realizado correctamente",
    bodyHtml,
  });

  await sendMail(
    user.email,
    `Registro recibido - ${BRAND_NAME}`,
    lines.join("\n"),
    html
  );
}

/* =========================================================
   ✅ NUEVO: Admin -> nuevo registro + botones
========================================================= */
export async function sendAdminNewRegistrationEmail({ user, approveUrl, rejectUrl }) {
  if (!ADMIN_EMAIL) return;
  if (!user?.email) return;

  const fullName =
    `${user?.name || ""} ${user?.lastName || ""}`.trim() ||
    user?.email ||
    "Usuario";

  const lines = [
    `${BRAND_NAME} - Nuevo registro`,
    "",
    `Nombre: ${fullName}`,
    `Email: ${user.email}`,
    user?.phone ? `Teléfono: ${user.phone}` : "",
    user?._id ? `ID: ${user._id}` : "",
    "",
    "Acciones:",
    `Aprobar: ${approveUrl}`,
    `Rechazar: ${rejectUrl}`,
  ].filter(Boolean);

  const bodyHtml = `
    <div style="font-size:18px; font-weight:800; margin-bottom:10px;">Nuevo registro</div>

    <div style="color:#333; margin-bottom:12px;">
      Se registró un nuevo usuario en <b>${escapeHtml(BRAND_NAME)}</b>.
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:10px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Nombre", escapeHtml(fullName))}
        ${kvRow("Email", escapeHtml(user.email || "-"))}
        ${kvRow("Teléfono", escapeHtml(user.phone || "-"))}
        ${kvRow("ID", escapeHtml(String(user._id || "-")))}
        ${kvRow("Email verificado", user?.emailVerified ? "SI" : "NO")}
        ${kvRow("Estado", "Pendiente")}
      </table>
    </div>

    <div style="margin:18px 0 6px; font-weight:700;">Acciones</div>

    <div style="margin:12px 0; display:flex; gap:10px; flex-wrap:wrap;">
      <a href="${approveUrl}" style="background:#111; color:#fff; padding:12px 16px; border-radius:10px; text-decoration:none; display:inline-block;">
        Aprobar
      </a>
      <a href="${rejectUrl}" style="background:#dc3545; color:#fff; padding:12px 16px; border-radius:10px; text-decoration:none; display:inline-block;">
        Rechazar
      </a>
    </div>

    <div style="font-size:12px; color:#666; margin-top:10px;">
      Si los botones no funcionan, usá estos links:
      <div style="word-break:break-all; margin-top:6px;">
        <div><a href="${approveUrl}">${approveUrl}</a></div>
        <div><a href="${rejectUrl}">${rejectUrl}</a></div>
      </div>
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Nuevo registro`,
    preheader: "Nuevo usuario pendiente de aprobación",
    bodyHtml,
  });

  await sendMail(
    ADMIN_EMAIL,
    `Nuevo registro - ${BRAND_NAME}`,
    lines.join("\n"),
    html
  );
}

/* =========================================================
   ✅ NUEVO: Usuario -> aprobado / rechazado (+ link DUO)
========================================================= */
export async function sendUserApprovalResultEmail(user, status) {
  if (!user?.email) return;

  const isApproved = status === "approved";
  const title = isApproved ? "Cuenta aprobada" : "Cuenta rechazada";
  const pre = isApproved ? "Tu cuenta fue aprobada" : "Tu cuenta fue rechazada";

  const lines = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    isApproved
      ? `¡Listo! El staff aprobó tu cuenta en ${BRAND_NAME}. Ya podés ingresar.`
      : `Tu cuenta en ${BRAND_NAME} fue rechazada. Si creés que es un error, contactá al administrador.`,
    "",
    BRAND_URL ? `Ingresar: ${BRAND_URL}` : "",
  ].filter(Boolean);

  const bodyHtml = `
    <div style="font-size:18px; font-weight:800; margin-bottom:10px;">${escapeHtml(title)}</div>
    <div style="color:#333; margin-bottom:12px;">Hola <b>${escapeHtml(user.name || "")}</b>,</div>

    <div style="color:#333; margin-bottom:12px;">
      ${
        isApproved
          ? `¡Listo! El staff aprobó tu cuenta en <b>${escapeHtml(BRAND_NAME)}</b>. Ya podés ingresar.`
          : `Tu cuenta en <b>${escapeHtml(BRAND_NAME)}</b> fue rechazada. Si creés que es un error, contactá al administrador.`
      }
    </div>

    ${
      isApproved && BRAND_URL
        ? `<div style="margin:16px 0;">
            <a href="${BRAND_URL}" style="background:#111; color:#fff; padding:12px 16px; border-radius:10px; text-decoration:none; display:inline-block;">
              Ingresar a DUO
            </a>
          </div>`
        : ""
    }
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · ${title}`,
    preheader: pre,
    bodyHtml,
  });

  await sendMail(
    user.email,
    `${title} - ${BRAND_NAME}`,
    lines.join("\n"),
    html
  );
}
