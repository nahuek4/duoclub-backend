import { ADMIN_EMAIL, BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { EMAIL_FONT, escapeHtml, kvRow, prettyDateAR } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";

/* =========================================================
   Helpers base
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

/* =========================================================
   Helpers visuales EXACTOS (mismo estilo que admisión user)
========================================================= */

function renderExactUserShell(innerHtml) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
      <tr>
        <td align="center" style="padding:0 0 8px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:430px; border-collapse:separate;">
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

function renderExactStatusIcon(symbol = "✓") {
  return `
    <div style="
      width:58px;
      height:58px;
      margin:0 auto 16px;
      border-radius:999px;
      background:#000;
      color:#fff;
      font-size:38px;
      line-height:58px;
      font-weight:900;
      font-family:${EMAIL_FONT};
      text-align:center;
    ">${escapeHtml(symbol)}</div>
  `;
}

function renderExactTitle(text, maxWidth = 300) {
  return `
    <div style="
      font-size:20px;
      line-height:24px;
      font-weight:900;
      margin:0 auto 26px;
      max-width:${maxWidth}px;
      font-family:${EMAIL_FONT};
      color:#111111;
      white-space:pre-line;
    ">
      ${escapeHtml(text)}
    </div>
  `;
}

function renderExactBodyText(html, opts = {}) {
  const fontSize = opts?.fontSize || 16;
  const lineHeight = opts?.lineHeight || 22;
  const weight = opts?.weight || 600;
  const maxWidth = opts?.maxWidth || 380;
  const marginBottom = opts?.marginBottom ?? 14;

  return `
    <div style="
      font-size:${fontSize}px;
      line-height:${lineHeight}px;
      font-weight:${weight};
      max-width:${maxWidth}px;
      margin:0 auto ${marginBottom}px;
      font-family:${EMAIL_FONT};
      color:#111111;
    ">
      ${html}
    </div>
  `;
}

function renderExactSingleTurnTable({ ap, serviceName, extraRows = "" }) {
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

function renderExactBlackTurnsPanel(items = []) {
  const list = Array.isArray(items) ? items : [];

  const cards = list.length
    ? list
        .map((it, idx) => {
          const date = prettyDateAR(it?.date || "");
          const time = `${it?.time || "-"} hs`;
          const service = getServiceName(it, it?.serviceName);

          return `
            <div style="
              border:1px solid #dfff00;
              border-radius:8px;
              padding:10px 12px;
              margin:0 0 ${idx === list.length - 1 ? 0 : 10}px;
              text-align:left;
            ">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
                <tr>
                  <td style="
                    font-family:${EMAIL_FONT};
                    font-size:16px;
                    line-height:18px;
                    font-weight:900;
                    color:#e9ff00;
                  ">
                    ${escapeHtml(date)}
                  </td>
                  <td align="right" style="
                    font-family:${EMAIL_FONT};
                    font-size:16px;
                    line-height:18px;
                    font-weight:900;
                    color:#e9ff00;
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
        font-weight:700;
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

/* =========================================================
   USER cards
========================================================= */

function buildAppointmentCardHtml({ user, ap, serviceName, kind, meta = {} }) {
  const uName = getUserName(user);
  const svc = getServiceName(ap, serviceName);

  const isCancelled = kind === "cancelled";
  const icon = isCancelled ? "✕" : "✓";
  const title = isCancelled
    ? "Tu turno fue\ncancelado con éxito"
    : "Tu turno fue\nconfirmado con éxito";

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
    ${renderExactStatusIcon(icon)}
    ${renderExactTitle(title, 285)}

    ${renderExactBodyText(`Hola (${escapeHtml(uName)}),`, {
      marginBottom: 12,
    })}

    ${renderExactBodyText(
      isCancelled
        ? "Tu turno fue cancelado correctamente."
        : "Tu turno fue reservado con éxito.",
      { marginBottom: 16 }
    )}

    ${renderExactSingleTurnTable({ ap, serviceName: svc, extraRows })}

    ${
      refundText
        ? renderExactBodyText(escapeHtml(refundText), {
            fontSize: 14,
            lineHeight: 20,
            weight: 600,
            marginBottom: 12,
          })
        : ""
    }

    ${renderExactBodyText(
      isCancelled
        ? "Si fue un error, podés volver a reservar desde la agenda."
        : "Si no podés asistir, recordá cancelarlo con anticipación desde tu perfil.",
      {
        fontSize: 14,
        lineHeight: 20,
        weight: 700,
        maxWidth: 360,
        marginBottom: 0,
      }
    )}
  `;

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${isCancelled ? "Turno cancelado" : "Turno confirmado"}`,
    preheader: `${isCancelled ? "Turno cancelado" : "Turno confirmado"}: ${
      ap?.date || ""
    } ${ap?.time || ""} · ${svc}`,
    bodyHtml: renderExactUserShell(innerHtml),
    footerNote: "",
  });
}

function buildBatchAppointmentCardHtml({ items = [], kind = "booked" }) {
  const isCancelled = kind === "cancelled";
  const icon = isCancelled ? "✕" : "✓";

  const title = isCancelled
    ? "Tus turnos fueron\ncancelados con éxito"
    : "Tus turnos fueron\nconfirmados con éxito";

  const bottomText = isCancelled
    ? "" // en la imagen de cancelados no aparece texto abajo
    : "Si no podés asistir, recordá\ncancelarlo con anticipación desde tu perfil.";

  const innerHtml = `
    ${renderExactStatusIcon(icon)}
    ${renderExactTitle(title, 280)}
    ${renderExactBlackTurnsPanel(items)}
    ${
      bottomText
        ? renderExactBodyText(
            escapeHtml(bottomText).replace(/\n/g, "<br/>"),
            {
              fontSize: 14,
              lineHeight: 20,
              weight: 700,
              maxWidth: 310,
              marginBottom: 0,
            }
          )
        : ""
    }
  `;

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${
      isCancelled ? "Turnos cancelados" : "Turnos confirmados"
    }`,
    preheader: isCancelled
      ? "Tus turnos fueron cancelados"
      : "Tus turnos fueron confirmados",
    bodyHtml: renderExactUserShell(innerHtml),
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

  const html = buildAppointmentCardHtml({
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
    ${renderExactStatusIcon("⏰")}
    ${renderExactTitle("Recordatorio de turno", 280)}
    ${renderExactBodyText(`Hola (${escapeHtml(uName)}),`, {
      marginBottom: 12,
    })}
    ${renderExactBodyText(
      "Te recordamos que tenés un turno en las próximas 24 horas.",
      { marginBottom: 16 }
    )}
    ${renderExactSingleTurnTable({ ap, serviceName: svc })}
    ${renderExactBodyText(
      "Si no podés asistir, cancelá el turno para liberar el espacio.",
      {
        fontSize: 14,
        lineHeight: 20,
        weight: 700,
        maxWidth: 360,
        marginBottom: 0,
      }
    )}
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Recordatorio de turno`,
    preheader: `Recordatorio: ${ap?.date || ""} ${ap?.time || ""} · ${svc}`,
    bodyHtml: renderExactUserShell(innerHtml),
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

  const subject = `🗓️ Nuevo turno reservado — ${uName} · ${ap?.date || "-"} ${
    ap?.time || ""
  }`;

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
    <div style="font-family:${EMAIL_FONT}; font-size:18px; font-weight:800; margin-bottom:12px;">
      Nuevo turno reservado
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
    bodyHtml,
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

  const subject = `🧾 Turno cancelado — ${uName} · ${ap?.date || "-"} ${
    ap?.time || ""
  }`;

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

  const bodyHtml = `
    <div style="font-family:${EMAIL_FONT}; font-size:18px; font-weight:800; margin-bottom:12px;">
      Turno cancelado
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
    bodyHtml,
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
    "Tus turnos fueron confirmados con éxito.",
    "",
    "Detalle:",
    ...(linesItems.length ? linesItems : ["(sin items)"]),
    "",
    "Si no podés asistir, recordá cancelarlo con anticipación desde tu perfil.",
  ].join("\n");

  const html = buildBatchAppointmentCardHtml({ items: list, kind: "booked" });

  await sendMail(
    user.email,
    `Tus turnos fueron confirmados - ${BRAND_NAME}`,
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
  ].join("\n");

  const html = buildBatchAppointmentCardHtml({
    items: list,
    kind: "cancelled",
  });

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
    ${renderExactStatusIcon("✓")}
    ${renderExactTitle("Se liberó un cupo", 280)}
    ${renderExactBodyText(`Hola (${escapeHtml(uName)}),`, {
      marginBottom: 12,
    })}
    ${renderExactBodyText(
      "Se liberó un cupo para el turno que tenías en lista de espera.",
      { marginBottom: 16 }
    )}
    ${renderExactSingleTurnTable({ ap, serviceName: svc })}
    ${renderExactBodyText(
      totalNotified > 1
        ? `Avisamos a vos y a otras ${totalNotified - 1} personas. El turno se asigna al primero que lo confirme.`
        : "El turno se asigna al primero que lo confirme.",
      {
        fontSize: 14,
        lineHeight: 20,
        weight: 700,
        maxWidth: 360,
        marginBottom: 16,
      }
    )}

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

    ${renderExactBodyText(
      "Si al entrar ya no aparece disponible, significa que otra persona lo confirmó primero.",
      {
        fontSize: 12,
        lineHeight: 18,
        weight: 600,
        maxWidth: 360,
        marginBottom: 0,
      }
    )}
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Cupo disponible`,
    preheader: "Se liberó un cupo para tu turno en lista de espera",
    bodyHtml: renderExactUserShell(innerHtml),
    footerNote: "",
  });

  await sendMail(
    user.email,
    `Se liberó un cupo para tu turno - ${BRAND_NAME}`,
    text,
    html
  );
}