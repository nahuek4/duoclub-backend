// backend/src/mail.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } = process.env || {};

  // ✅ Modo mock (no rompe la app si falta SMTP)
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    console.log("[MAIL] SMTP no configurado. Se hará log en consola.");
    return null;
  }

  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: String(SMTP_SECURE) === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  transporter.verify().then(
    () => console.log("[MAIL] SMTP OK"),
    (e) => console.log("[MAIL] SMTP verify failed:", e?.message || e)
  );

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

/* =========================================================
   ✅ NUEVO: helpers de template "lindo" + seguridad HTML
========================================================= */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "duoclub.ar@gmail.com";
const BRAND_NAME = process.env.BRAND_NAME || "DUO";
const BRAND_URL = process.env.BRAND_URL || "https://duoclub.ar"; // opcional

function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function prettyDateAR(dateStr) {
  try {
    if (!dateStr) return "-";
    const [y, m, d] = String(dateStr).split("-").map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1);
    return dt.toLocaleDateString("es-AR", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "2-digit",
    });
  } catch {
    return String(dateStr || "-");
  }
}

function buildEmailLayout({ title, preheader, bodyHtml, footerNote }) {
  const _title = escapeHtml(title || BRAND_NAME);
  const _pre = escapeHtml(preheader || "");
  const _footer = escapeHtml(
    footerNote || "Si no reconocés esta acción, respondé a este correo y lo revisamos."
  );

  // preheader oculto (mejora en Gmail/iOS)
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

function kvRow(label, value) {
  return `
    <tr>
      <td style="padding:8px 10px; color:#555; font-size:13px; width:170px; border-bottom:1px solid #eee;">
        ${escapeHtml(label)}
      </td>
      <td style="padding:8px 10px; color:#111; font-size:13px; border-bottom:1px solid #eee;">
        ${escapeHtml(value)}
      </td>
    </tr>
  `;
}

function buildAppointmentCardHtml({ user, ap, serviceName, kind }) {
  const uName =
    `${user?.name || ""} ${user?.lastName || ""}`.trim() ||
    user?.fullName ||
    user?.email ||
    "Usuario";
  const whenDateLong = prettyDateAR(ap?.date);
  const time = ap?.time || "-";
  const svc = serviceName || ap?.service || "-";

  const title = kind === "cancelled" ? "Turno cancelado" : "Turno confirmado";
  const pillBg = kind === "cancelled" ? "#ffe9ea" : "#e9f7ef";
  const pillTx = kind === "cancelled" ? "#a00010" : "#0b6b2a";
  const pill = kind === "cancelled" ? "CANCELADO" : "CONFIRMADO";

  const body = `
    <div style="display:flex; gap:10px; align-items:center; margin-bottom:14px;">
      <div style="font-size:18px; font-weight:800;">${escapeHtml(title)}</div>
      <div style="margin-left:auto; background:${pillBg}; color:${pillTx}; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800;">
        ${escapeHtml(pill)}
      </div>
    </div>

    <div style="color:#333; margin-bottom:14px;">
      Hola <b>${escapeHtml(uName)}</b>,
      ${kind === "cancelled" ? " tu turno fue cancelado." : " tu turno fue reservado con éxito."}
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Día", whenDateLong)}
        ${kvRow("Horario", `${time} hs`)}
        ${kvRow("Servicio", svc)}
      </table>
    </div>

    <div style="margin-top:14px; font-size:12px; color:#666;">
      ${
        kind === "cancelled"
          ? "Si fue un error, podés volver a reservar desde la agenda."
          : "Si no podés asistir, recordá cancelarlo con anticipación desde tu perfil."
      }
    </div>
  `;

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${title}`,
    preheader: `${title}: ${ap?.date || ""} ${time} · ${svc}`,
    bodyHtml: body,
  });
}

/* =========================================================
   Emails existentes
========================================================= */
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

/* =========================================================
   ✅ Turnos (USER + ADMIN)
========================================================= */
export async function sendAppointmentBookedEmail(user, ap, serviceName) {
  if (!user?.email) return;

  const subject = "✅ Tu turno fue reservado - DUO";
  const text = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Tu turno fue reservado con éxito.",
    "",
    `Día: ${ap?.date || "-"}`,
    `Horario: ${ap?.time || "-"}`,
    serviceName ? `Servicio: ${serviceName}` : ap?.service ? `Servicio: ${ap.service}` : "",
    "",
    "Si no podés asistir, recordá cancelarlo con anticipación desde tu perfil.",
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildAppointmentCardHtml({ user, ap, serviceName, kind: "booked" });

  await sendMail(user.email, subject, text, html);

  // ✅ También al admin
  await sendAdminAppointmentBookedEmail(user, ap, serviceName);
}

export async function sendAppointmentCancelledEmail(user, ap, serviceName) {
  if (!user?.email) return;

  const subject = "❌ Tu turno fue cancelado - DUO";
  const text = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Tu turno fue cancelado.",
    "",
    `Día: ${ap?.date || "-"}`,
    `Horario: ${ap?.time || "-"}`,
    serviceName ? `Servicio: ${serviceName}` : ap?.service ? `Servicio: ${ap.service}` : "",
    "",
    "Si fue un error, podés volver a reservar desde la agenda.",
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildAppointmentCardHtml({ user, ap, serviceName, kind: "cancelled" });

  await sendMail(user.email, subject, text, html);

  // ✅ También al admin
  await sendAdminAppointmentCancelledEmail(user, ap, serviceName);
}

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

/* =========================================================
   ✅ ADMIN — turnos reservados / cancelados
========================================================= */
export async function sendAdminAppointmentBookedEmail(user, ap, serviceName) {
  const to = ADMIN_EMAIL;
  if (!to) return;

  const uName =
    `${user?.name || ""} ${user?.lastName || ""}`.trim() || user?.fullName || "-";
  const uEmail = user?.email || "-";
  const svc = serviceName || ap?.service || "-";

  const subject = `🗓️ Nuevo turno reservado — ${uName} · ${ap?.date || "-"} ${ap?.time || ""}`;

  const text = [
    "Nuevo turno reservado",
    "",
    `Usuario: ${uName}`,
    `Email: ${uEmail}`,
    "",
    `Día: ${ap?.date || "-"}`,
    `Horario: ${ap?.time || "-"}`,
    `Servicio: ${svc}`,
    ap?.notes ? "" : "",
    ap?.notes ? `Notas: ${String(ap.notes)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const bodyHtml = `
    <div style="font-size:18px; font-weight:800; margin-bottom:12px;">Nuevo turno reservado</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Usuario", uName)}
        ${kvRow("Email", uEmail)}
        ${kvRow("Día", prettyDateAR(ap?.date))}
        ${kvRow("Horario", `${ap?.time || "-"} hs`)}
        ${kvRow("Servicio", svc)}
        ${ap?.notes ? kvRow("Notas", String(ap.notes)) : ""}
      </table>
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Nuevo turno reservado`,
    preheader: `${uName} · ${ap?.date || ""} ${ap?.time || ""} · ${svc}`,
    bodyHtml,
  });

  await sendMail(to, subject, text, html);
}

export async function sendAdminAppointmentCancelledEmail(user, ap, serviceName) {
  const to = ADMIN_EMAIL;
  if (!to) return;

  const uName =
    `${user?.name || ""} ${user?.lastName || ""}`.trim() || user?.fullName || "-";
  const uEmail = user?.email || "-";
  const svc = serviceName || ap?.service || "-";

  const subject = `🧾 Turno cancelado — ${uName} · ${ap?.date || "-"} ${ap?.time || ""}`;

  const text = [
    "Turno cancelado",
    "",
    `Usuario: ${uName}`,
    `Email: ${uEmail}`,
    "",
    `Día: ${ap?.date || "-"}`,
    `Horario: ${ap?.time || "-"}`,
    `Servicio: ${svc}`,
  ]
    .filter(Boolean)
    .join("\n");

  const bodyHtml = `
    <div style="font-size:18px; font-weight:800; margin-bottom:12px;">Turno cancelado</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Usuario", uName)}
        ${kvRow("Email", uEmail)}
        ${kvRow("Día", prettyDateAR(ap?.date))}
        ${kvRow("Horario", `${ap?.time || "-"} hs`)}
        ${kvRow("Servicio", svc)}
      </table>
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Turno cancelado`,
    preheader: `${uName} canceló ${ap?.date || ""} ${ap?.time || ""} · ${svc}`,
    bodyHtml,
  });

  await sendMail(to, subject, text, html);
}

/* =========================================================
   ✅ NUEVO: ADMIN — nuevo pedido (FIX LOGIN)
   (esto arregla el error de orders.js)
========================================================= */
export async function sendAdminNewOrderEmail(order = {}, user = null) {
  const to = ADMIN_EMAIL;
  if (!to) return;

  const uName =
    `${user?.name || ""} ${user?.lastName || ""}`.trim() ||
    user?.fullName ||
    user?.email ||
    "-";
  const uEmail = user?.email || "-";

  const orderId = order?._id?.toString?.() || order?.id || "-";
  const total = order?.total != null ? String(order.total) : "-";

  const items = Array.isArray(order?.items) ? order.items : [];

  const subject = `🛒 Nuevo pedido — ${uName} · #${orderId}`;

  const text = [
    "Nuevo pedido",
    "",
    `Pedido: ${orderId}`,
    `Usuario: ${uName}`,
    `Email: ${uEmail}`,
    "",
    `Total: ${total}`,
    "",
    "Items:",
    ...(items.length
      ? items.map((it, i) => `${i + 1}. ${it?.name || it?.title || "Item"} x${it?.qty || 1}`)
      : ["(sin items)"]),
  ].join("\n");

  const bodyHtml = `
    <div style="font-size:18px; font-weight:800; margin-bottom:12px;">Nuevo pedido</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Pedido", `#${orderId}`)}
        ${kvRow("Usuario", uName)}
        ${kvRow("Email", uEmail)}
        ${kvRow("Total", total)}
        ${kvRow("Items", items.length ? String(items.length) : "0")}
      </table>
    </div>

    ${
      items.length
        ? `
        <div style="margin-top:14px; font-size:13px; font-weight:800;">Detalle</div>
        <ul style="margin:10px 0 0; padding-left:18px; color:#111;">
          ${items
            .map((it) => {
              const name = it?.name || it?.title || "Item";
              const qty = it?.qty || it?.quantity || 1;
              return `<li style="margin:6px 0;">${escapeHtml(name)} x${escapeHtml(qty)}</li>`;
            })
            .join("")}
        </ul>
      `
        : ""
    }
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Nuevo pedido`,
    preheader: `Nuevo pedido #${orderId} · ${uName}`,
    bodyHtml,
  });

  await sendMail(to, subject, text, html);
}

/* =========================================================
   Batch (user) — y opcional admin
========================================================= */
export async function sendAppointmentBookedBatchEmail(user, items = []) {
  if (!user?.email) return;

  const list = Array.isArray(items) ? items : [];
  const linesItems = list.map((it, i) => {
    const date = it?.date || "-";
    const time = it?.time || "-";
    const svc = it?.service || it?.serviceName || "";
    return `${i + 1}. ${date} · ${time}${svc ? ` · ${svc}` : ""}`;
  });

  const text = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Tus turnos fueron reservados con éxito.",
    "",
    "Detalle:",
    ...(linesItems.length ? linesItems : ["(sin items)"]),
    "",
    "Si no podés asistir, recordá cancelarlos con anticipación desde tu perfil.",
  ].join("\n");

  const html = `
  <div style="font-family: Arial, sans-serif; color:#111; line-height:1.4;">
    <h2 style="margin:0 0 10px;">✅ Turnos reservados</h2>
    <p>Hola ${user.name || ""},</p>
    <p>Tus turnos fueron reservados con éxito.</p>
    <div style="padding:12px; border:1px solid #ddd; border-radius:10px;">
      <div style="font-weight:700; margin-bottom:8px;">Detalle</div>
      <ul style="margin:0; padding-left:18px;">
        ${
          linesItems.length
            ? linesItems.map((l) => `<li style="margin:6px 0;">${escapeHtml(l)}</li>`).join("")
            : "<li>(sin items)</li>"
        }
      </ul>
    </div>
    <p style="margin-top:12px; font-size:12px; color:#444;">
      Si no podés asistir, recordá cancelarlos con anticipación desde tu perfil.
    </p>
  </div>
  `;

  await sendMail(user.email, "Tus turnos fueron reservados", text, html);

  // ✅ opcional admin
  // await sendMail(ADMIN_EMAIL, "🗓️ Batch de turnos reservado", text, html);
}
