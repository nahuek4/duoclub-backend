import { ADMIN_EMAIL, BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { EMAIL_FONT, escapeHtml, kvRow, prettyDateAR } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";

/* =========================================================
   Helpers visuales
========================================================= */

function getUserName(user = {}) {
  return (
    `${user?.name || ""} ${user?.lastName || ""}`.trim() ||
    user?.fullName ||
    user?.email ||
    "Usuario"
  );
}

function getServiceName(ap = {}, serviceName = "") {
  return serviceName || ap?.service || ap?.serviceName || "Entrenamiento Personal";
}

function renderStatusIconCircle(symbol = "✓") {
  return `
    <div style="
      width:58px;
      height:58px;
      margin:0 auto 16px;
      border-radius:999px;
      background:#000000;
      color:#ffffff;
      text-align:center;
      font-family:${EMAIL_FONT};
      font-size:38px;
      line-height:58px;
      font-weight:900;
    ">
      ${escapeHtml(symbol)}
    </div>
  `;
}

function renderWhiteCard(innerHtml, maxWidth = 430) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
      <tr>
        <td align="center" style="padding:0 0 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:${maxWidth}px; border-collapse:separate;">
            <tr>
              <td
                bgcolor="#ffffff"
                style="
                  background:#ffffff;
                  border-radius:18px;
                  padding:22px 18px 20px;
                  text-align:center;
                  font-family:${EMAIL_FONT};
                  color:#111111;
                "
              >
                ${innerHtml}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

function renderSimpleAdminCard(title, innerHtml, icon = "✓") {
  return renderWhiteCard(
    `
      ${renderStatusIconCircle(icon)}

      <div style="
        font-family:${EMAIL_FONT};
        font-size:20px;
        line-height:24px;
        font-weight:900;
        margin:0 auto 18px;
        max-width:320px;
      ">
        ${escapeHtml(title)}
      </div>

      <div style="
        font-family:${EMAIL_FONT};
        font-size:14px;
        line-height:20px;
        font-weight:600;
        margin:0 auto;
        max-width:420px;
        text-align:left;
      ">
        ${innerHtml}
      </div>
    `,
    460
  );
}

function renderBlackTurnsPanel(items = []) {
  const list = Array.isArray(items) ? items : [];

  const cards = list.length
    ? list
        .map((it) => {
          const date = prettyDateAR(it?.date || "");
          const time = `${it?.time || "-"} hs`;
          const service = getServiceName(it, it?.serviceName);

          return `
            <div style="
              border:1px solid #d7f000;
              border-radius:8px;
              padding:10px 12px;
              margin:0 0 10px;
              text-align:left;
            ">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
                <tr>
                  <td style="
                    font-family:${EMAIL_FONT};
                    font-size:16px;
                    line-height:18px;
                    font-weight:900;
                    color:#e6ff00;
                  ">
                    ${escapeHtml(date)}
                  </td>
                  <td align="right" style="
                    font-family:${EMAIL_FONT};
                    font-size:16px;
                    line-height:18px;
                    font-weight:900;
                    color:#e6ff00;
                  ">
                    ${escapeHtml(time)}
                  </td>
                </tr>
                <tr>
                  <td colspan="2" style="
                    padding-top:4px;
                    font-family:${EMAIL_FONT};
                    font-size:15px;
                    line-height:18px;
                    font-weight:700;
                    color:#ffffff;
                  ">
                    ${escapeHtml(service)}
                  </td>
                </tr>
              </table>
            </div>
          `;
        })
        .join("")
    : `
      <div style="
        font-family:${EMAIL_FONT};
        font-size:14px;
        line-height:18px;
        color:#ffffff;
        text-align:left;
      ">
        Sin turnos para mostrar.
      </div>
    `;

  return `
    <div style="
      background:#060606;
      border-radius:8px;
      padding:14px;
      margin:0 auto 18px;
      max-width:100%;
    ">
      ${cards}
    </div>
  `;
}

function renderSingleTurnTable({ ap, serviceName, extraRows = "" }) {
  return `
    <div style="
      border:1px solid #eeeeee;
      border-radius:14px;
      overflow:hidden;
      margin:0 auto 14px;
      max-width:100%;
      text-align:left;
    ">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
        ${kvRow("Día", prettyDateAR(ap?.date))}
        ${kvRow("Horario", `${ap?.time || "-"} hs`)}
        ${kvRow("Servicio", getServiceName(ap, serviceName))}
        ${extraRows}
      </table>
    </div>
  `;
}

function renderUserAppointmentCard({ user, ap, serviceName, kind, meta = {} }) {
  const uName = getUserName(user);
  const svc = getServiceName(ap, serviceName);

  const isCancelled = kind === "cancelled";
  const title = isCancelled
    ? "Tu turno fue cancelado"
    : "Tu turno fue confirmado";
  const icon = isCancelled ? "✕" : "✓";

  const refundFlag =
    isCancelled && typeof meta?.refund === "boolean" ? meta.refund : null;

  const cutoff =
    typeof meta?.refundCutoffHours === "number" ? meta.refundCutoffHours : null;

  const refundText =
    refundFlag === null
      ? ""
      : refundFlag
      ? "Se reintegró 1 sesión a tu cuenta."
      : cutoff
      ? `No hubo reintegro porque la cancelación fue fuera del límite (${cutoff}hs).`
      : "No hubo reintegro porque la cancelación fue fuera del límite.";

  const extraRows =
    refundFlag === null
      ? ""
      : kvRow("Reintegro", refundFlag ? "Sí (1 sesión)" : "No");

  const innerHtml = `
    ${renderStatusIconCircle(icon)}

    <div style="
      font-family:${EMAIL_FONT};
      font-size:20px;
      line-height:24px;
      font-weight:900;
      margin:0 auto 22px;
      max-width:300px;
    ">
      ${escapeHtml(title)}
    </div>

    <div style="
      font-family:${EMAIL_FONT};
      font-size:16px;
      line-height:22px;
      font-weight:600;
      margin:0 auto 14px;
      max-width:380px;
    ">
      Hola (${escapeHtml(uName)}),
    </div>

    <div style="
      font-family:${EMAIL_FONT};
      font-size:16px;
      line-height:22px;
      font-weight:600;
      margin:0 auto 16px;
      max-width:380px;
    ">
      ${
        isCancelled
          ? "Tu turno fue cancelado correctamente."
          : "Tu turno fue reservado con éxito."
      }
    </div>

    ${renderSingleTurnTable({ ap, serviceName: svc, extraRows })}

    ${
      refundText
        ? `
      <div style="
        font-family:${EMAIL_FONT};
        font-size:14px;
        line-height:20px;
        font-weight:600;
        margin:0 auto 12px;
        max-width:380px;
      ">
        ${escapeHtml(refundText)}
      </div>
    `
        : ""
    }

    <div style="
      font-family:${EMAIL_FONT};
      font-size:14px;
      line-height:20px;
      font-weight:700;
      margin:0 auto;
      max-width:380px;
    ">
      ${
        isCancelled
          ? "Si fue un error, podés volver a reservar desde la agenda."
          : "Si no podés asistir, recordá cancelarlo con anticipación desde tu perfil."
      }
    </div>
  `;

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${title}`,
    preheader: `${title}: ${ap?.date || ""} ${ap?.time || ""} · ${svc}`,
    bodyHtml: renderWhiteCard(innerHtml),
    footerNote: "",
  });
}

function renderUserBatchCard({ items = [], kind = "booked" }) {
  const isCancelled = kind === "cancelled";
  const icon = isCancelled ? "✕" : "✓";
  const title = isCancelled
    ? "Tus turnos fueron\ncancelados con éxito"
    : "Tus turnos fueron\nconfirmados con éxito";

  const innerHtml = `
    ${renderStatusIconCircle(icon)}

    <div style="
      font-family:${EMAIL_FONT};
      font-size:20px;
      line-height:24px;
      font-weight:900;
      margin:0 auto 22px;
      max-width:300px;
      white-space:pre-line;
    ">
      ${escapeHtml(title)}
    </div>

    ${renderBlackTurnsPanel(items)}

    <div style="
      font-family:${EMAIL_FONT};
      font-size:14px;
      line-height:20px;
      font-weight:700;
      margin:0 auto;
      max-width:360px;
    ">
      ${
        isCancelled
          ? "Si fue un error, podés volver a reservar desde la agenda."
          : "Si no podés asistir, recordá cancelarlo con anticipación desde tu perfil."
      }
    </div>
  `;

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${isCancelled ? "Turnos cancelados" : "Turnos reservados"}`,
    preheader: isCancelled
      ? "Tus turnos fueron cancelados"
      : "Tus turnos fueron reservados",
    bodyHtml: renderWhiteCard(innerHtml),
    footerNote: "",
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
    `Hola ${user?.name || ""}`.trim() + ",",
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

  const html = renderUserAppointmentCard({
    user,
    ap,
    serviceName,
    kind: "booked",
  });

  await sendMail(user.email, subject, text, html);
  await sendAdminAppointmentBookedEmail(user, ap, serviceName);
}

export async function sendAppointmentCancelledEmail(
  user,
  ap,
  serviceName,
  meta = {}
) {
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
    `Hola ${user?.name || ""}`.trim() + ",",
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
    refundLine,
    extraExplain,
    "",
    "Si fue un error, podés volver a reservar desde la agenda.",
  ]
    .filter(Boolean)
    .join("\n");

  const html = renderUserAppointmentCard({
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

  const uName = getUserName(user);
  const svc = getServiceName(ap, serviceName);

  const text = [
    `Hola ${user?.name || ""}`.trim() + ",",
    "",
    "Te recordamos que tenés un turno agendado en las próximas 24 horas.",
    "",
    `Día: ${ap?.date || "-"}`,
    `Horario: ${ap?.time || "-"}`,
    `Servicio: ${svc}`,
    "",
    "Te esperamos. Si no podés asistir, cancelá el turno para liberar el espacio.",
  ].join("\n");

  const innerHtml = `
    ${renderStatusIconCircle("⏰")}

    <div style="
      font-family:${EMAIL_FONT};
      font-size:20px;
      line-height:24px;
      font-weight:900;
      margin:0 auto 22px;
      max-width:300px;
    ">
      Recordatorio de turno
    </div>

    <div style="
      font-family:${EMAIL_FONT};
      font-size:16px;
      line-height:22px;
      font-weight:600;
      margin:0 auto 16px;
      max-width:380px;
    ">
      Hola (${escapeHtml(uName)}),
    </div>

    <div style="
      font-family:${EMAIL_FONT};
      font-size:16px;
      line-height:22px;
      font-weight:600;
      margin:0 auto 16px;
      max-width:380px;
    ">
      Te recordamos que tenés un turno en las próximas 24 horas.
    </div>

    ${renderSingleTurnTable({ ap, serviceName: svc })}

    <div style="
      font-family:${EMAIL_FONT};
      font-size:14px;
      line-height:20px;
      font-weight:700;
      margin:0 auto;
      max-width:380px;
    ">
      Si no podés asistir, cancelá el turno para liberar el espacio.
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Recordatorio de turno`,
    preheader: `Recordatorio: ${ap?.date || ""} ${ap?.time || ""} · ${svc}`,
    bodyHtml: renderWhiteCard(innerHtml),
    footerNote: "",
  });

  await sendMail(
    user.email,
    `⏰ Recordatorio de turno - ${BRAND_NAME}`,
    text,
    html
  );
}

/* =========================================================
   ADMIN emails
========================================================= */

export async function sendAdminAppointmentBookedEmail(user, ap, serviceName) {
  const to = ADMIN_EMAIL;
  if (!to) return;

  const uName = getUserName(user);
  const uEmail = user?.email || "-";
  const svc = getServiceName(ap, serviceName);

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

  const details = `
    <div style="margin-bottom:14px; text-align:center;">
      Se registró un nuevo turno reservado.
    </div>

    <div style="border:1px solid #eeeeee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
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
    bodyHtml: renderSimpleAdminCard("Nuevo turno reservado", details, "✓"),
    footerNote: "",
  });

  await sendMail(to, subject, text, html);
}

export async function sendAdminAppointmentCancelledEmail(
  user,
  ap,
  serviceName,
  meta = {}
) {
  const to = ADMIN_EMAIL;
  if (!to) return;

  const uName = getUserName(user);
  const uEmail = user?.email || "-";
  const svc = getServiceName(ap, serviceName);

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
    refundLine,
    extraExplain,
  ]
    .filter(Boolean)
    .join("\n");

  const details = `
    <div style="margin-bottom:14px; text-align:center;">
      Se registró una cancelación de turno.
    </div>

    <div style="border:1px solid #eeeeee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
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
        ${refundFlag === null ? "" : kvRow("Detalle", extraExplain || "-")}
      </table>
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Turno cancelado`,
    preheader: `${uName} canceló ${ap?.date || ""} ${ap?.time || ""} · ${svc}`,
    bodyHtml: renderSimpleAdminCard("Turno cancelado", details, "✕"),
    footerNote: "",
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
    const svc = getServiceName(it, it?.serviceName);
    return `${i + 1}. ${date} · ${time}${svc ? ` · ${svc}` : ""}`;
  });

  const text = [
    `Hola ${user?.name || ""}`.trim() + ",",
    "",
    "Tus turnos fueron reservados con éxito.",
    "",
    "Detalle:",
    ...(linesItems.length ? linesItems : ["(sin items)"]),
    "",
    "Si no podés asistir, recordá cancelarlos con anticipación desde tu perfil.",
  ].join("\n");

  const html = renderUserBatchCard({ items: list, kind: "booked" });

  await sendMail(
    user.email,
    `Tus turnos fueron reservados - ${BRAND_NAME}`,
    text,
    html
  );
}

export async function sendAppointmentCancelledBatchEmail(user, items = []) {
  console.log("[MAIL][APPT] cancelled batch ->", {
    to: user?.email,
    count: Array.isArray(items) ? items.length : 0,
  });

  if (!user?.email) return;

  const list = Array.isArray(items) ? items : [];
  const linesItems = list.map((it, i) => {
    const date = it?.date || "-";
    const time = it?.time || "-";
    const svc = getServiceName(it, it?.serviceName);
    return `${i + 1}. ${date} · ${time}${svc ? ` · ${svc}` : ""}`;
  });

  const text = [
    `Hola ${user?.name || ""}`.trim() + ",",
    "",
    "Tus turnos fueron cancelados con éxito.",
    "",
    "Detalle:",
    ...(linesItems.length ? linesItems : ["(sin items)"]),
    "",
    "Si fue un error, podés volver a reservar desde la agenda.",
  ].join("\n");

  const html = renderUserBatchCard({ items: list, kind: "cancelled" });

  await sendMail(
    user.email,
    `Tus turnos fueron cancelados - ${BRAND_NAME}`,
    text,
    html
  );
}

/* =========================================================
   WAITLIST
========================================================= */

export async function sendWaitlistSlotAvailableEmail(user, ap, meta = {}) {
  if (!user?.email) return;

  const token = String(meta?.token || "").trim();
  const totalNotified = Number(meta?.totalNotified || 0);
  const uName = getUserName(user);
  const svc = getServiceName(ap);

  const link = token
    ? `${BRAND_URL}/?waitlist=${encodeURIComponent(token)}`
    : BRAND_URL;

  const text = [
    "Se liberó un cupo para tu turno en lista de espera.",
    `Fecha: ${ap?.date || "-"} ${ap?.time || "-"}`,
    `Servicio: ${svc}`,
    totalNotified > 1
      ? `Avisamos a vos y a otras ${totalNotified - 1} personas. Se asigna al primero que lo confirme.`
      : "Se asigna al primero que lo confirme.",
    `Confirmá acá: ${link}`,
  ].join("\n");

  const innerHtml = `
    ${renderStatusIconCircle("✓")}

    <div style="
      font-family:${EMAIL_FONT};
      font-size:20px;
      line-height:24px;
      font-weight:900;
      margin:0 auto 22px;
      max-width:300px;
    ">
      Se liberó un cupo
    </div>

    <div style="
      font-family:${EMAIL_FONT};
      font-size:16px;
      line-height:22px;
      font-weight:600;
      margin:0 auto 14px;
      max-width:380px;
    ">
      Hola (${escapeHtml(uName)}),
    </div>

    <div style="
      font-family:${EMAIL_FONT};
      font-size:16px;
      line-height:22px;
      font-weight:600;
      margin:0 auto 16px;
      max-width:380px;
    ">
      Se liberó un cupo para el turno que tenías en lista de espera.
    </div>

    ${renderSingleTurnTable({ ap, serviceName: svc })}

    <div style="
      font-family:${EMAIL_FONT};
      font-size:14px;
      line-height:20px;
      font-weight:700;
      margin:0 auto 16px;
      max-width:380px;
    ">
      ${
        totalNotified > 1
          ? `Avisamos a vos y a otras ${totalNotified - 1} personas. El turno se asigna al primero que lo confirme.`
          : "El turno se asigna al primero que lo confirme."
      }
    </div>

    <div style="margin:16px 0;">
      <a href="${escapeHtml(link)}"
        style="
          display:inline-block;
          background:#111111;
          color:#ffffff;
          text-decoration:none;
          padding:12px 16px;
          border-radius:12px;
          font-family:${EMAIL_FONT};
          font-weight:800;
        ">
        Confirmar turno
      </a>
    </div>

    <div style="
      font-family:${EMAIL_FONT};
      font-size:12px;
      line-height:18px;
      font-weight:600;
      color:#666666;
      max-width:380px;
      margin:0 auto;
    ">
      Si al entrar ya no aparece disponible, significa que otra persona lo confirmó primero.
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Cupo disponible`,
    preheader: "Se liberó un cupo para tu turno en lista de espera",
    bodyHtml: renderWhiteCard(innerHtml),
    footerNote: "",
  });

  await sendMail(
    user.email,
    `Se liberó un cupo para tu turno - ${BRAND_NAME}`,
    text,
    html
  );
}