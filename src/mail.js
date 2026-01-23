// backend/src/mail.js
import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

let transporter = null;

/* =========================================================
   Config
========================================================= */
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "duoclub.ar@gmail.com";
const BRAND_NAME = process.env.BRAND_NAME || "DUO";
const BRAND_URL = process.env.BRAND_URL || "https://duoclub.ar";

/* =========================================================
   Util: fire-and-forget (no bloquear requests)
========================================================= */
export function fireAndForget(fn, label = "MAIL") {
  try {
    setImmediate(() => {
      Promise.resolve()
        .then(fn)
        .catch((e) => console.log(`[${label}] async error:`, e?.message || e));
    });
  } catch (e) {
    console.log(`[${label}] schedule error:`, e?.message || e);
  }
}

/* =========================================================
   Transporter (SMTP)
========================================================= */
function getTransporter() {
  if (transporter) return transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE } =
    process.env || {};

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

    // ✅ evita cuelgues largos
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,

    // ✅ opcional: pool (mejora performance si mandás varios)
    pool: true,
    maxConnections: 2,
    maxMessages: 50,
  });

  transporter.verify().then(
    () => console.log("[MAIL] SMTP OK"),
    (e) => console.log("[MAIL] SMTP verify failed:", e?.message || e)
  );

  return transporter;
}

/* =========================================================
   Envío base
========================================================= */
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
   Helpers HTML / Templates
========================================================= */
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

function moneyARS(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "-");
  try {
    return n.toLocaleString("es-AR", { style: "currency", currency: "ARS" });
  } catch {
    return `$${n}`;
  }
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

function pill(status) {
  const s = String(status || "").toLowerCase();
  if (s === "approved" || s === "paid") {
    return { bg: "#e9f7ef", tx: "#0b6b2a", label: "PAGADO" };
  }
  if (s === "pending") {
    return { bg: "#fff6db", tx: "#7a5200", label: "PENDIENTE" };
  }
  if (s === "cancelled" || s === "rejected" || s === "failed") {
    return { bg: "#ffe9ea", tx: "#a00010", label: "RECHAZADO" };
  }
  return { bg: "#eef1f5", tx: "#334155", label: String(status || "ESTADO") };
}

function buildEmailLayout({ title, preheader, bodyHtml, footerNote }) {
  const _title = escapeHtml(title || BRAND_NAME);
  const _pre = escapeHtml(preheader || "");
  const _footer = escapeHtml(
    footerNote ||
      "Si no reconocés esta acción, respondé a este correo y lo revisamos."
  );

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

function orderSummary(order = {}, user = null) {
  const orderId = order?._id?.toString?.() || order?.id || "-";
  const createdAt = order?.createdAt ? new Date(order.createdAt) : null;
  const createdDate = createdAt
    ? createdAt.toLocaleDateString("es-AR", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
    : "-";
  const createdTime = createdAt
    ? createdAt.toLocaleTimeString("es-AR", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

  const uName =
    `${user?.name || ""} ${user?.lastName || ""}`.trim() ||
    user?.fullName ||
    user?.email ||
    "-";
  const uEmail = user?.email || "-";

  const pm = String(order?.payMethod || "").toUpperCase() || "-";
  const status = String(order?.status || "pending").toLowerCase();

  const totalFinal =
    order?.totalFinal != null
      ? moneyARS(order.totalFinal)
      : moneyARS(order?.total ?? order?.price ?? 0);

  const items = Array.isArray(order?.items) ? order.items : [];
  const itemsCount = items.reduce(
    (acc, it) => acc + Math.max(1, Number(it?.qty) || 1),
    0
  );

  return {
    orderId,
    createdDate,
    createdTime,
    uName,
    uEmail,
    pm,
    status,
    totalFinal,
    items,
    itemsCount,
  };
}

function renderItemsList(items = []) {
  if (!items.length) return "<li>(sin items)</li>";

  return items
    .map((it) => {
      const kind = String(it?.kind || "").toUpperCase();
      const qty = Math.max(1, Number(it?.qty) || 1);

      if (kind === "CREDITS") {
        const svc = String(it?.serviceKey || "EP").toUpperCase();
        const cr = Number(it?.credits) || 0;
        return `<li style="margin:6px 0;">Créditos <b>${escapeHtml(
          String(cr)
        )}</b> (${escapeHtml(svc)}) x${escapeHtml(String(qty))}</li>`;
      }

      if (kind === "MEMBERSHIP") {
        const months = qty;
        return `<li style="margin:6px 0;">Membresía <b>DUO+</b> (${escapeHtml(
          String(months)
        )} mes/es)</li>`;
      }

      const name = it?.label || it?.name || it?.title || "Item";
      return `<li style="margin:6px 0;">${escapeHtml(
        String(name)
      )} x${escapeHtml(String(qty))}</li>`;
    })
    .join("");
}

/* =========================================================
   Emails existentes (verify / welcome)
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

/* =========================================================
   Turnos (USER + ADMIN)
========================================================= */
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
  const pillLabel = kind === "cancelled" ? "CANCELADO" : "CONFIRMADO";

  const body = `
    <div style="display:flex; gap:10px; align-items:center; margin-bottom:14px;">
      <div style="font-size:18px; font-weight:800;">${escapeHtml(title)}</div>
      <div style="margin-left:auto; background:${pillBg}; color:${pillTx}; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800;">
        ${escapeHtml(pillLabel)}
      </div>
    </div>

    <div style="color:#333; margin-bottom:14px;">
      Hola <b>${escapeHtml(uName)}</b>,
      ${
        kind === "cancelled"
          ? " tu turno fue cancelado."
          : " tu turno fue reservado con éxito."
      }
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

export async function sendAppointmentBookedEmail(user, ap, serviceName) {
  if (!user?.email) return;

  const subject = `✅ Tu turno fue reservado - ${BRAND_NAME}`;
  const text = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Tu turno fue reservado con éxito.",
    "",
    `Día: ${ap?.date || "-"}`,
    `Horario: ${ap?.time || "-"}`,
    serviceName
      ? `Servicio: ${serviceName}`
      : ap?.service
      ? `Servicio: ${ap.service}`
      : "",
    "",
    "Si no podés asistir, recordá cancelarlo con anticipación desde tu perfil.",
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildAppointmentCardHtml({
    user,
    ap,
    serviceName,
    kind: "booked",
  });

  await sendMail(user.email, subject, text, html);
  await sendAdminAppointmentBookedEmail(user, ap, serviceName);
}

export async function sendAppointmentCancelledEmail(user, ap, serviceName) {
  if (!user?.email) return;

  const subject = `❌ Tu turno fue cancelado - ${BRAND_NAME}`;
  const text = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Tu turno fue cancelado.",
    "",
    `Día: ${ap?.date || "-"}`,
    `Horario: ${ap?.time || "-"}`,
    serviceName
      ? `Servicio: ${serviceName}`
      : ap?.service
      ? `Servicio: ${ap.service}`
      : "",
    "",
    "Si fue un error, podés volver a reservar desde la agenda.",
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildAppointmentCardHtml({
    user,
    ap,
    serviceName,
    kind: "cancelled",
  });

  await sendMail(user.email, subject, text, html);
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

  await sendMail(
    user.email,
    "Recordatorio de turno",
    lines.filter(Boolean).join("\n")
  );
}

export async function sendAdminAppointmentBookedEmail(user, ap, serviceName) {
  const to = ADMIN_EMAIL;
  if (!to) return;

  const uName =
    `${user?.name || ""} ${user?.lastName || ""}`.trim() ||
    user?.fullName ||
    "-";
  const uEmail = user?.email || "-";
  const svc = serviceName || ap?.service || "-";

  const subject = `🗓️ Nuevo turno reservado — ${uName} · ${
    ap?.date || "-"
  } ${ap?.time || ""}`;

  const text = [
    "Nuevo turno reservado",
    "",
    `Usuario: ${uName}`,
    `Email: ${uEmail}`,
    "",
    `Día: ${ap?.date || "-"}`,
    `Horario: ${ap?.time || "-"}`,
    `Servicio: ${svc}`,
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
    `${user?.name || ""} ${user?.lastName || ""}`.trim() ||
    user?.fullName ||
    "-";
  const uEmail = user?.email || "-";
  const svc = serviceName || ap?.service || "-";

  const subject = `🧾 Turno cancelado — ${uName} · ${
    ap?.date || "-"
  } ${ap?.time || ""}`;

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
   ✅ NUEVO: ADMISSION (Formulario completo Step2) — ADMIN + USER
   (para usar en routes/admission.js)
========================================================= */
function safeAdmId(adm) {
  return adm?._id?.toString?.() || adm?.id || "-";
}

function admissionSummary(adm = {}, user = null) {
  const s1 = adm?.step1 || {};
  const s2 = adm?.step2 || {};

  const publicId = adm?.publicId || "-";
  const admissionId = safeAdmId(adm);

  const createdAt = adm?.createdAt ? new Date(adm.createdAt) : null;
  const createdDate = createdAt
    ? createdAt.toLocaleDateString("es-AR", { year: "numeric", month: "2-digit", day: "2-digit" })
    : "-";
  const createdTime = createdAt
    ? createdAt.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
    : "-";

  const fullName =
    `${user?.name || ""} ${user?.lastName || ""}`.trim() ||
    user?.fullName ||
    s1.fullName ||
    "-";

  const email = user?.email || s1.email || "-";
  const phone = user?.phone || s1.phone || "-";

  const city = s1.cityOther ? `${s1.city || ""} (${s1.cityOther})`.trim() : (s1.city || "-");

  // algunos campos típicos del form
  const fitnessLevel = s1.fitnessLevel || "-";
  const weight = s1.weight || "-";
  const height = s1.height || "-";

  // step2 (según lo que tengas)
  const immediateGoal = s2.immediateGoal || "-";
  const modality = s2.modality || "-";
  const weeklySessions = s2.weeklySessions || "-";
  const needsRehab = s2.needsRehab || "-";

  const hasContraindication =
    s1.hasContraindication === "SI"
      ? `SI (${s1.contraindicationDetail || "-"})`
      : (s1.hasContraindication || "-");

  const hasCondition =
    s1.hasCondition === "SI"
      ? `SI (${s1.conditionDetail || "-"})`
      : (s1.hasCondition || "-");

  const hadInjuryLastYear =
    s1.hadInjuryLastYear === "SI"
      ? `SI (${s1.injuryDetail || "-"})`
      : (s1.hadInjuryLastYear || "-");

  const relevantInfo = s1.relevantInfo || "-";

  return {
    admissionId,
    publicId,
    createdDate,
    createdTime,
    fullName,
    email,
    phone,
    city,
    fitnessLevel,
    weight,
    height,
    hasContraindication,
    hasCondition,
    hadInjuryLastYear,
    relevantInfo,
    immediateGoal,
    modality,
    weeklySessions,
    needsRehab,
  };
}

export async function sendAdminAdmissionCompletedEmail(admissionDoc = {}, pseudoUser = null) {
  const to = ADMIN_EMAIL;
  if (!to) return;

  const s = admissionSummary(admissionDoc, pseudoUser);

  const subject = `🧾 Formulario completo (Admisión) — ${s.fullName} · #${s.publicId}`;

  const text = [
    "Formulario de admisión completado (Step2)",
    "",
    `PublicId: ${s.publicId}`,
    `AdmissionId: ${s.admissionId}`,
    `Creado: ${s.createdDate} ${s.createdTime}`,
    "",
    `Nombre: ${s.fullName}`,
    `Email: ${s.email}`,
    `Tel: ${s.phone}`,
    `Ciudad: ${s.city}`,
    "",
    `Fitness: ${s.fitnessLevel}`,
    `Altura: ${s.height}`,
    `Peso: ${s.weight}`,
    "",
    `Contraindicación: ${s.hasContraindication}`,
    `Condición: ${s.hasCondition}`,
    `Lesión último año: ${s.hadInjuryLastYear}`,
    `Info relevante: ${s.relevantInfo}`,
    "",
    `Step2 · Rehab: ${s.needsRehab}`,
    `Step2 · Objetivo: ${s.immediateGoal}`,
    `Step2 · Modalidad: ${s.modality}`,
    `Step2 · Sesiones/sem: ${s.weeklySessions}`,
  ].join("\n");

  const bodyHtml = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <div style="font-size:18px; font-weight:800;">Formulario completado</div>
      <div style="margin-left:auto; background:#e9f7ef; color:#0b6b2a; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800;">
        COMPLETO
      </div>
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("PublicId", `#${s.publicId}`)}
        ${kvRow("AdmissionId", s.admissionId)}
        ${kvRow("Creado", `${s.createdDate} ${s.createdTime}`)}
        ${kvRow("Nombre", s.fullName)}
        ${kvRow("Email", s.email)}
        ${kvRow("Teléfono", s.phone)}
        ${kvRow("Ciudad", s.city)}
      </table>
    </div>

    <div style="margin-top:14px; font-size:13px; font-weight:800;">Resumen Step1</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:8px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Fitness", s.fitnessLevel)}
        ${kvRow("Altura", s.height)}
        ${kvRow("Peso", s.weight)}
        ${kvRow("Contraindicación", s.hasContraindication)}
        ${kvRow("Condición", s.hasCondition)}
        ${kvRow("Lesión último año", s.hadInjuryLastYear)}
        ${kvRow("Info relevante", s.relevantInfo)}
      </table>
    </div>

    <div style="margin-top:14px; font-size:13px; font-weight:800;">Resumen Step2</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:8px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Rehab", s.needsRehab)}
        ${kvRow("Objetivo", s.immediateGoal)}
        ${kvRow("Modalidad", s.modality)}
        ${kvRow("Sesiones/sem", s.weeklySessions)}
      </table>
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Admisión completada`,
    preheader: `Admisión #${s.publicId} · ${s.fullName}`,
    bodyHtml,
  });

  await sendMail(to, subject, text, html);
}

export async function sendUserAdmissionReceivedEmail(admissionDoc = {}, pseudoUser = null) {
  const email = String(pseudoUser?.email || admissionDoc?.step1?.email || "").trim();
  if (!email) return;

  const s = admissionSummary(admissionDoc, pseudoUser);

  const subject = `✅ Recibimos tu formulario - ${BRAND_NAME}`;

  const text = [
    `Hola ${pseudoUser?.name || ""}`.trim() + ",",
    "",
    "Recibimos tu formulario correctamente.",
    "",
    `Código: #${s.publicId}`,
    "",
    "En breve el staff lo revisa y te contacta si hace falta.",
  ].join("\n");

  const bodyHtml = `
    <div style="font-size:18px; font-weight:800; margin-bottom:10px;">Formulario recibido</div>

    <div style="color:#333; margin-bottom:12px;">
      Hola <b>${escapeHtml(pseudoUser?.name || s.fullName || "👋")}</b>, recibimos tu formulario correctamente.
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Código", `#${s.publicId}`)}
        ${kvRow("Nombre", s.fullName)}
        ${kvRow("Email", s.email)}
        ${kvRow("Teléfono", s.phone)}
      </table>
    </div>

    <div style="margin-top:14px; font-size:12px; color:#666;">
      En breve el staff lo revisa. Si hace falta, te contactamos por WhatsApp o email.
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Formulario recibido`,
    preheader: `Recibimos tu formulario · Código #${s.publicId}`,
    bodyHtml,
  });

  await sendMail(email, subject, text, html);
}

/* =========================================================
   ✅ NUEVO: Pedidos (ORDER) — ADMIN + USER
========================================================= */
export async function sendAdminNewOrderEmail(order = {}, user = null) {
  const to = ADMIN_EMAIL;
  if (!to) return;

  const s = orderSummary(order, user);

  const subject = `🛒 Nuevo pedido — ${s.uName} · #${s.orderId}`;

  const text = [
    "Nuevo pedido",
    "",
    `Pedido: #${s.orderId}`,
    `Usuario: ${s.uName}`,
    `Email: ${s.uEmail}`,
    "",
    `Pago: ${s.pm}`,
    `Estado: ${s.status}`,
    `Total: ${s.totalFinal}`,
    "",
    "Items:",
    ...(s.items.length
      ? s.items.map(
          (it, i) =>
            `${i + 1}. ${
              it?.label || it?.name || it?.title || it?.kind || "Item"
            } x${it?.qty || 1}`
        )
      : ["(sin items)"]),
  ].join("\n");

  const st = pill(s.status);
  const bodyHtml = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <div style="font-size:18px; font-weight:800;">Nuevo pedido</div>
      <div style="margin-left:auto; background:${st.bg}; color:${st.tx}; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800;">
        ${escapeHtml(st.label)}
      </div>
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Pedido", `#${s.orderId}`)}
        ${kvRow("Usuario", s.uName)}
        ${kvRow("Email", s.uEmail)}
        ${kvRow("Pago", s.pm)}
        ${kvRow("Estado", s.status)}
        ${kvRow("Total", s.totalFinal)}
        ${kvRow("Creado", `${s.createdDate} ${s.createdTime}`)}
        ${kvRow("Items", String(s.itemsCount))}
      </table>
    </div>

    <div style="margin-top:14px; font-size:13px; font-weight:800;">Detalle</div>
    <ul style="margin:10px 0 0; padding-left:18px; color:#111;">
      ${renderItemsList(s.items)}
    </ul>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Nuevo pedido`,
    preheader: `Nuevo pedido #${s.orderId} · ${s.uName} · ${s.totalFinal}`,
    bodyHtml,
  });

  await sendMail(to, subject, text, html);
}

export async function sendAdminOrderPaidEmail(order = {}, user = null) {
  const to = ADMIN_EMAIL;
  if (!to) return;

  const s = orderSummary(order, user);

  const subject = `✅ Pedido pagado — ${s.uName} · #${s.orderId}`;

  const text = [
    "Pedido pagado",
    "",
    `Pedido: #${s.orderId}`,
    `Usuario: ${s.uName}`,
    `Email: ${s.uEmail}`,
    "",
    `Pago: ${s.pm}`,
    `Estado: ${s.status}`,
    `Total: ${s.totalFinal}`,
  ].join("\n");

  const st = pill("paid");
  const bodyHtml = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <div style="font-size:18px; font-weight:800;">Pedido pagado</div>
      <div style="margin-left:auto; background:${st.bg}; color:${st.tx}; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800;">
        ${escapeHtml(st.label)}
      </div>
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Pedido", `#${s.orderId}`)}
        ${kvRow("Usuario", s.uName)}
        ${kvRow("Email", s.uEmail)}
        ${kvRow("Pago", s.pm)}
        ${kvRow("Total", s.totalFinal)}
      </table>
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Pedido pagado`,
    preheader: `Pedido #${s.orderId} pagado · ${s.uName} · ${s.totalFinal}`,
    bodyHtml,
  });

  await sendMail(to, subject, text, html);
}

export async function sendUserOrderCreatedEmail(order = {}, user = null) {
  if (!user?.email) return;

  const s = orderSummary(order, user);
  const st = pill("pending");

  const subject = `🧾 Recibimos tu pedido - ${BRAND_NAME}`;
  const text = [
    `Hola ${user?.name || ""}`.trim() + ",",
    "",
    "Recibimos tu pedido correctamente.",
    "",
    `Pedido: #${s.orderId}`,
    `Pago: ${s.pm}`,
    `Total: ${s.totalFinal}`,
    "",
    "Estado: Pendiente de pago/confirmación.",
    "Cuando el staff confirme el pago (efectivo), vas a ver reflejado el impacto en tu cuenta.",
  ].join("\n");

  const bodyHtml = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <div style="font-size:18px; font-weight:800;">Pedido recibido</div>
      <div style="margin-left:auto; background:${st.bg}; color:${st.tx}; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800;">
        ${escapeHtml(st.label)}
      </div>
    </div>

    <div style="color:#333; margin-bottom:12px;">
      Hola <b>${escapeHtml(user?.name || "")}</b>, recibimos tu pedido correctamente.
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Pedido", `#${s.orderId}`)}
        ${kvRow("Pago", s.pm)}
        ${kvRow("Total", s.totalFinal)}
        ${kvRow("Estado", "Pendiente")}
      </table>
    </div>

    <div style="margin-top:14px; font-size:13px; font-weight:800;">Detalle</div>
    <ul style="margin:10px 0 0; padding-left:18px; color:#111;">
      ${renderItemsList(s.items)}
    </ul>

    <div style="margin-top:14px; font-size:12px; color:#666;">
      Cuando el staff confirme el pago (efectivo), tu compra se acreditará automáticamente.
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Pedido recibido`,
    preheader: `Pedido #${s.orderId} recibido · ${s.totalFinal}`,
    bodyHtml,
  });

  await sendMail(user.email, subject, text, html);
}

export async function sendUserOrderPaidEmail(order = {}, user = null) {
  if (!user?.email) return;

  const s = orderSummary(order, user);
  const st = pill("paid");

  const subject = `✅ Pago aprobado - ${BRAND_NAME}`;
  const text = [
    `Hola ${user?.name || ""}`.trim() + ",",
    "",
    "Tu pago fue aprobado y tu compra se procesó correctamente.",
    "",
    `Pedido: #${s.orderId}`,
    `Pago: ${s.pm}`,
    `Total: ${s.totalFinal}`,
    "",
    "Ya podés ver el impacto (créditos/membresía) en tu cuenta.",
  ].join("\n");

  const bodyHtml = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <div style="font-size:18px; font-weight:800;">Pago aprobado</div>
      <div style="margin-left:auto; background:${st.bg}; color:${st.tx}; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800;">
        ${escapeHtml(st.label)}
      </div>
    </div>

    <div style="color:#333; margin-bottom:12px;">
      Hola <b>${escapeHtml(user?.name || "")}</b>, tu pago fue aprobado y tu compra se acreditó.
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Pedido", `#${s.orderId}`)}
        ${kvRow("Pago", s.pm)}
        ${kvRow("Total", s.totalFinal)}
        ${kvRow("Estado", "Pagado")}
      </table>
    </div>

    <div style="margin-top:14px; font-size:13px; font-weight:800;">Detalle</div>
    <ul style="margin:10px 0 0; padding-left:18px; color:#111;">
      ${renderItemsList(s.items)}
    </ul>

    <div style="margin-top:14px; font-size:12px; color:#666;">
      Ya podés ver el impacto (créditos/membresía) en tu cuenta.
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Pago aprobado`,
    preheader: `Pago aprobado · Pedido #${s.orderId} · ${s.totalFinal}`,
    bodyHtml,
  });

  await sendMail(user.email, subject, text, html);
}

/* =========================================================
   Batch (turnos)
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

  const bodyHtml = `
    <div style="font-size:18px; font-weight:800; margin-bottom:10px;">✅ Turnos reservados</div>
    <div style="color:#333; margin-bottom:12px;">Hola <b>${escapeHtml(
      user.name || ""
    )}</b>,</div>
    <div style="color:#333; margin-bottom:12px;">Tus turnos fueron reservados con éxito.</div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <div style="padding:12px 12px 0; font-size:13px; font-weight:800;">Detalle</div>
      <ul style="margin:10px 0 0; padding:0 12px 12px 28px; color:#111;">
        ${
          linesItems.length
            ? linesItems
                .map((l) => `<li style="margin:6px 0;">${escapeHtml(l)}</li>`)
                .join("")
            : "<li>(sin items)</li>"
        }
      </ul>
    </div>

    <div style="margin-top:12px; font-size:12px; color:#666;">
      Si no podés asistir, recordá cancelarlos con anticipación desde tu perfil.
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Turnos reservados`,
    preheader: "Tus turnos fueron reservados",
    bodyHtml,
  });

  await sendMail(
    user.email,
    `Tus turnos fueron reservados - ${BRAND_NAME}`,
    text,
    html
  );
}

/* =========================================================
   ✅ FALTABA ESTO: CASH creado (pendiente) — USER
   (para que no explote el import en orders.js)
========================================================= */
export async function sendUserOrderCashCreatedEmail(order = {}, user = null) {
  if (!user?.email) return;

  const s = orderSummary(order, user);
  const st = pill("pending");

  const subject = `🧾 Pedido generado (Efectivo) - ${BRAND_NAME}`;
  const text = [
    `Hola ${user?.name || ""}`.trim() + ",",
    "",
    "Generamos tu pedido correctamente.",
    "Medio de pago: EFECTIVO.",
    "",
    `Pedido: #${s.orderId}`,
    `Total: ${s.totalFinal}`,
    "",
    "Ahora coordiná el pago con el staff.",
    "Cuando el staff marque el pago como realizado, se acreditarán los créditos/membresía.",
  ].join("\n");

  const bodyHtml = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <div style="font-size:18px; font-weight:800;">Pedido generado (Efectivo)</div>
      <div style="margin-left:auto; background:${st.bg}; color:${st.tx}; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800;">
        ${escapeHtml(st.label)}
      </div>
    </div>

    <div style="color:#333; margin-bottom:12px;">
      Hola <b>${escapeHtml(user?.name || "")}</b>, generamos tu pedido correctamente.
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Pedido", `#${s.orderId}`)}
        ${kvRow("Pago", "Efectivo")}
        ${kvRow("Total", s.totalFinal)}
        ${kvRow("Estado", "Pendiente")}
      </table>
    </div>

    <div style="margin-top:14px; font-size:13px; font-weight:800;">Detalle</div>
    <ul style="margin:10px 0 0; padding-left:18px; color:#111;">
      ${renderItemsList(s.items)}
    </ul>

    <div style="margin-top:14px; font-size:12px; color:#666;">
      Coordiná el pago con el staff. Cuando se confirme, se acreditará automáticamente.
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Pedido generado (Efectivo)`,
    preheader: `Pedido #${s.orderId} generado · ${s.totalFinal}`,
    bodyHtml,
  });

  await sendMail(user.email, subject, text, html);
}
