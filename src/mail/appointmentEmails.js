// backend/src/mail/appointmentEmails.js
import { ADMIN_EMAIL, BRAND_NAME, sendMail } from "./core.js";
import { escapeHtml, kvRow, prettyDateAR } from "./helpers.js";
import { buildEmailLayout } from "./layout_adapted.js";

/* =========================================================
   Turnos (USER + ADMIN)
========================================================= */

function buildAppointmentCardHtml({ user, ap, serviceName, kind, meta = {} }) {
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

  const refundFlag =
    kind === "cancelled" && typeof meta?.refund === "boolean" ? meta.refund : null;

  const refundText =
    refundFlag === null
      ? ""
      : refundFlag
      ? `✅ Se reintegró 1 sesión a tu cuenta.`
      : `ℹ️ No hubo reintegro de sesión (cancelación fuera del límite).`;

  const cutoff =
    typeof meta?.refundCutoffHours === "number" ? meta.refundCutoffHours : null;

  const cutoffLine =
    refundFlag === null
      ? ""
      : cutoff
      ? `Límite de reintegro: ${cutoff}hs o más de anticipación.`
      : "";

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
        ${
          refundFlag === null
            ? ""
            : kvRow("Reintegro", refundFlag ? "Sí (1 sesión)" : "No")
        }
      </table>
    </div>

    ${
      refundFlag === null
        ? ""
        : `
        <div style="margin-top:12px; font-size:13px; color:#111;">
          ${escapeHtml(refundText)}
        </div>
        ${
          cutoffLine
            ? `<div style="margin-top:6px; font-size:12px; color:#666;">${escapeHtml(
                cutoffLine
              )}</div>`
            : ""
        }
      `
    }

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
   USER emails
========================================================= */

export async function sendAppointmentBookedEmail(user, ap, serviceName) {
  console.log("[MAIL][APPT] booked ->", {
    to: user?.email,
    date: ap?.date,
    time: ap?.time,
    serviceName: serviceName || ap?.service,
  });

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

/**
 * ✅ Cancelación: acepta meta para reintegro
 * meta = { refund:boolean, refundCutoffHours:number }
 */
export async function sendAppointmentCancelledEmail(user, ap, serviceName, meta = {}) {
  console.log("[MAIL][APPT] cancelled ->", {
    to: user?.email,
    date: ap?.date,
    time: ap?.time,
    serviceName: serviceName || ap?.service,
    refund: meta?.refund,
    refundCutoffHours: meta?.refundCutoffHours,
  });

  if (!user?.email) return;

  const refundFlag = typeof meta?.refund === "boolean" ? meta.refund : null;
  const cutoff =
    typeof meta?.refundCutoffHours === "number" ? meta.refundCutoffHours : null;

  const subject = `❌ Tu turno fue cancelado - ${BRAND_NAME}`;

  const refundLine =
    refundFlag === null
      ? ""
      : refundFlag
      ? "Reintegro: Sí (1 sesión)"
      : "Reintegro: No";

  const extraExplain =
    refundFlag === null
      ? ""
      : refundFlag
      ? "Se reintegró 1 sesión a tu cuenta."
      : cutoff
      ? `No hubo reintegro porque la cancelación fue fuera del límite (${cutoff}hs).`
      : "No hubo reintegro porque la cancelación fue fuera del límite.";

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
    refundLine ? refundLine : "",
    extraExplain ? extraExplain : "",
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
    meta,
  });

  await sendMail(user.email, subject, text, html);
  await sendAdminAppointmentCancelledEmail(user, ap, serviceName, meta);
}

export async function sendAppointmentReminderEmail(user, ap, serviceName) {
  console.log("[MAIL][APPT] reminder ->", {
    to: user?.email,
    date: ap?.date,
    time: ap?.time,
    serviceName: serviceName || ap?.service,
  });

  if (!user?.email) return;

  const text = [
    `Hola ${user.name || ""}`.trim() + ",",
    "",
    "Te recordamos que tenés un turno agendado en las próximas 24 horas.",
    "",
    `Día: ${ap?.date || "-"}`,
    `Horario: ${ap?.time || "-"}`,
    serviceName ? `Servicio: ${serviceName}` : ap?.service ? `Servicio: ${ap.service}` : "",
    "",
    "Te esperamos. Si no podés asistir, cancelá el turno para liberar el espacio.",
  ]
    .filter(Boolean)
    .join("\n");

  const whenDateLong = prettyDateAR(ap?.date);
  const time = ap?.time || "-";
  const svc = serviceName || ap?.service || "-";
  const uName =
    `${user?.name || ""} ${user?.lastName || ""}`.trim() ||
    user?.fullName ||
    user?.email ||
    "Usuario";

  const bodyHtml = `
    <div style="display:flex; gap:10px; align-items:center; margin-bottom:14px;">
      <div style="font-size:18px; font-weight:800;">Recordatorio de turno</div>
      <div style="margin-left:auto; background:#fff6db; color:#7a5200; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800;">
        RECORDATORIO
      </div>
    </div>

    <div style="color:#333; margin-bottom:14px;">
      Hola <b>${escapeHtml(uName)}</b>, te recordamos que tenés un turno en las próximas 24 horas.
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Día", whenDateLong)}
        ${kvRow("Horario", `${time} hs`)}
        ${kvRow("Servicio", svc)}
      </table>
    </div>

    <div style="margin-top:14px; font-size:12px; color:#666;">
      Si no podés asistir, cancelá el turno para liberar el espacio.
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Recordatorio de turno`,
    preheader: `Recordatorio: ${ap?.date || ""} ${time} · ${svc}`,
    bodyHtml,
  });

  await sendMail(user.email, `⏰ Recordatorio de turno - ${BRAND_NAME}`, text, html);
}

/* =========================================================
   ADMIN emails
========================================================= */

export async function sendAdminAppointmentBookedEmail(user, ap, serviceName) {
  const to = ADMIN_EMAIL;
  if (!to) return;

  const uName =
    `${user?.name || ""} ${user?.lastName || ""}`.trim() ||
    user?.fullName ||
    "-";
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

/**
 * ✅ Admin cancel: acepta meta refund
 */
export async function sendAdminAppointmentCancelledEmail(user, ap, serviceName, meta = {}) {
  const to = ADMIN_EMAIL;
  if (!to) return;

  const uName =
    `${user?.name || ""} ${user?.lastName || ""}`.trim() ||
    user?.fullName ||
    "-";
  const uEmail = user?.email || "-";
  const svc = serviceName || ap?.service || "-";

  const refundFlag = typeof meta?.refund === "boolean" ? meta.refund : null;
  const cutoff =
    typeof meta?.refundCutoffHours === "number" ? meta.refundCutoffHours : null;

  const subject = `🧾 Turno cancelado — ${uName} · ${ap?.date || "-"} ${ap?.time || ""}`;

  const refundLine =
    refundFlag === null
      ? ""
      : refundFlag
      ? "Reintegro: Sí (1 sesión)"
      : "Reintegro: No";

  const extraExplain =
    refundFlag === null
      ? ""
      : refundFlag
      ? "Se reintegró 1 sesión."
      : cutoff
      ? `No hubo reintegro (fuera del límite: ${cutoff}hs).`
      : "No hubo reintegro (fuera del límite).";

  const text = [
    "Turno cancelado",
    "",
    `Usuario: ${uName}`,
    `Email: ${uEmail}`,
    "",
    `Día: ${ap?.date || "-"}`,
    `Horario: ${ap?.time || "-"}`,
    `Servicio: ${svc}`,
    refundLine ? refundLine : "",
    extraExplain ? extraExplain : "",
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
        ${
          refundFlag === null
            ? ""
            : kvRow("Reintegro", refundFlag ? "Sí (1 sesión)" : "No")
        }
        ${refundFlag === null ? "" : kvRow("Detalle", escapeHtml(extraExplain || "-"))}
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
   Batch (turnos)
========================================================= */
export async function sendAppointmentBookedBatchEmail(user, items = []) {
  console.log("[MAIL][APPT] booked batch ->", {
    to: user?.email,
    count: Array.isArray(items) ? items.length : 0,
  });

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
   ✅ WAITLIST: se liberó un cupo
========================================================= */
export async function sendWaitlistSlotAvailableEmail(user, ap, meta = {}) {
  const token = String(meta?.token || "").trim();
  const totalNotified = Number(meta?.totalNotified || 0);

  const link = token ? `${BRAND_URL}/?waitlist=${encodeURIComponent(token)}` : BRAND_URL;

  const text = [
    `Se liberó un cupo para tu turno en lista de espera.`,
    `Fecha: ${ap?.date} ${ap?.time}`,
    `Servicio: ${ap?.service || "Entrenamiento Personal"}`,
    totalNotified > 1
      ? `Avisamos a vos y a otras ${totalNotified - 1} personas. Se asigna al primero que lo confirme.`
      : `Se asigna al primero que lo confirme.`,
    `Confirmá acá: ${link}`,
  ].join("\\n");

  const bodyHtml = `
    <div style="font-size:18px; font-weight:800; margin-bottom:10px;">📣 Se liberó un cupo</div>

    <div style="color:#333; margin-bottom:12px;">
      Hola <b>${escapeHtml(user?.name || "")}</b>,
    </div>

    <div style="color:#333; margin-bottom:12px;">
      Se liberó un cupo para el turno que tenías en lista de espera:
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-bottom:14px;">
      <div style="padding:12px 12px 0; font-size:13px; font-weight:800;">Detalle</div>
      <div style="padding:10px 12px 12px; color:#111;">
        <div><b>Fecha:</b> ${escapeHtml(ap?.date || "")}</div>
        <div><b>Hora:</b> ${escapeHtml(ap?.time || "")}</div>
        <div><b>Servicio:</b> ${escapeHtml(ap?.service || "Entrenamiento Personal")}</div>
      </div>
    </div>

    ${
      totalNotified > 1
        ? `<div style="color:#333; margin-bottom:14px;">
            Avisamos a vos y a <b>otras ${totalNotified - 1} personas</b>. El turno se asigna al primero que lo confirme.
          </div>`
        : `<div style="color:#333; margin-bottom:14px;">
            El turno se asigna al primero que lo confirme.
          </div>`
    }

    <div style="margin:16px 0;">
      <a href="${link}"
         style="display:inline-block; background:#111; color:#fff; text-decoration:none; padding:12px 16px; border-radius:12px; font-weight:700;">
        Confirmar turno
      </a>
    </div>

    <div style="font-size:12px; color:#666;">
      Si al entrar ya no aparece disponible, significa que otra persona lo confirmó primero.
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Cupo disponible`,
    preheader: "Se liberó un cupo para tu turno en lista de espera",
    bodyHtml,
  });

  await sendMail(
    user.email,
    `Se liberó un cupo para tu turno - ${BRAND_NAME}`,
    text,
    html
  );
}
