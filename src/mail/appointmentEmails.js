import { ADMIN_EMAIL, BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { EMAIL_FONT, escapeHtml, prettyDateAR } from "./helpers.js";
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
  return (
    serviceName ||
    ap?.serviceName ||
    ap?.service ||
    "Entrenamiento Personal"
  );
}

/* =========================================================
   Helpers visuales EXACTOS (look 1:1 referencia)
========================================================= */

function renderExactUserShell(innerHtml) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
      <tr>
        <td align="center" style="padding:0;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:430px; border-collapse:separate;">
            <tr>
              <td
                bgcolor="#ffffff"
                style="
                  background:#ffffff;
                  border-radius:14px;
                  padding:18px 10px 26px;
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
      margin:0 auto 0px;
      border-radius:999px;
      background:#0a0a0a;
      color:#ffffff;
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
      font-size:19px;
      line-height:20px;
      font-weight:900;
      margin:0 auto 18px;
      max-width:${maxWidth}px;
      font-family:${EMAIL_FONT};
      color:#111111;
      white-space:pre-line;
      letter-spacing:-0.2px;
    ">
      ${escapeHtml(text)}
    </div>
  `;
}

function renderExactBodyText(html, opts = {}) {
  const fontSize = opts?.fontSize || 14;
  const lineHeight = opts?.lineHeight || 19;
  const weight = opts?.weight || 700;
  const maxWidth = opts?.maxWidth || 320;
  const marginTop = opts?.marginTop ?? 0;
  const marginBottom = opts?.marginBottom ?? 0;

  return `
    <div style="
      font-size:${fontSize}px;
      line-height:${lineHeight}px;
      font-weight:${weight};
      max-width:${maxWidth}px;
      margin:${marginTop}px auto ${marginBottom}px;
      font-family:${EMAIL_FONT};
      color:#111111;
      white-space:pre-line;
    ">
      ${html}
    </div>
  `;
}

function renderExactTurnsPanel(items = []) {
  const list = Array.isArray(items) ? items : [];

  const cards = list.length
    ? list
        .map((it, idx) => {
          const date = prettyDateAR(it?.date || "");
          const time = `${it?.time || "-"} hs`;
          const service = getServiceName(it, it?.serviceName);

          return `
            <div style="
              border:1px solid #e4ff00;
              border-radius:8px;
              padding:10px 12px;
              margin:0 0 ${idx === list.length - 1 ? 0 : 11}px;
              text-align:left;
              background:#0b0b0b;
            ">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
                <tr>
                  <td style="
                    font-family:${EMAIL_FONT};
                    font-size:15px;
                    line-height:17px;
                    font-weight:800;
                    color:#e4ff00;
                    padding:0;
                  ">
                    ${escapeHtml(date)}
                  </td>
                  <td align="right" style="
                    font-family:${EMAIL_FONT};
                    font-size:15px;
                    line-height:17px;
                    font-weight:800;
                    color:#e4ff00;
                    padding:0;
                    white-space:nowrap;
                  ">
                    ${escapeHtml(time)}
                  </td>
                </tr>
                <tr>
                  <td colspan="2" style="
                    padding-top:4px;
                    font-family:${EMAIL_FONT};
                    font-size:14px;
                    line-height:16px;
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
      background:#0a0a0a;
      border-radius:6px;
      padding:14px;
      margin:0 auto 22px;
      max-width:100%;
      text-align:left;
    ">
      ${cards}
    </div>
  `;
}

/* =========================================================
   Panel admin (misma estética)
========================================================= */

function renderAdminMetaPanel(rows = []) {
  const validRows = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && r.label && r.value
  );

  if (!validRows.length) return "";

  const items = validRows
    .map(
      (row, idx) => `
        <div style="
          margin:0 0 ${idx === validRows.length - 1 ? 0 : 9}px;
          text-align:left;
        ">
          <div style="
            font-family:${EMAIL_FONT};
            font-size:12px;
            line-height:14px;
            font-weight:900;
            color:#e4ff00;
            text-transform:uppercase;
            letter-spacing:0.2px;
            margin-bottom:2px;
          ">
            ${escapeHtml(row.label)}
          </div>
          <div style="
            font-family:${EMAIL_FONT};
            font-size:14px;
            line-height:17px;
            font-weight:700;
            color:#ffffff;
            white-space:pre-line;
          ">
            ${escapeHtml(row.value)}
          </div>
        </div>
      `
    )
    .join("");

  return `
    <div style="
      background:#0a0a0a;
      border-radius:6px;
      padding:14px;
      margin:0 auto 22px;
      max-width:100%;
      text-align:left;
      display:flex;
      justify-content:space-around;
      flex-wrap:wrap;
    ">
      ${items}
    </div>
  `;
}

/* =========================================================
   Card principal EXACTA para booked/cancelled
   (single y batch usan la MISMA estructura)
========================================================= */

function buildExactAppointmentVisualHtml({
  items = [],
  kind = "booked",
  showBottomText = true,
}) {
  const isCancelled = kind === "cancelled";
  const icon = isCancelled ? "✕" : "✓";

  const title = isCancelled
    ? items.length > 1
      ? "Tus turnos fueron\ncancelados con éxito"
      : "Tu turno fue\ncancelado con éxito"
    : items.length > 1
    ? "Tus turnos fueron\nconfirmados con éxito"
    : "Tu turno fue\nconfirmado con éxito";

  const bottomText = isCancelled
    ? "Si querés, podés volver a reservar\ndesde tu perfil."
    : "Si no podés asistir, recordá\ncancelarlo con anticipación desde tu perfil.";

  const innerHtml = `
    ${renderExactStatusIcon(icon)}
    ${renderExactTitle(title, 285)}
    ${renderExactTurnsPanel(items)}
    ${
      showBottomText
        ? renderExactBodyText(
            escapeHtml(bottomText).replace(/\n/g, "<br/>"),
            {
              fontSize: 14,
              lineHeight: 19,
              weight: 700,
              maxWidth: 305,
              marginBottom: 0,
            }
          )
        : ""
    }
  `;

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${
      isCancelled
        ? items.length > 1
          ? "Turnos cancelados"
          : "Turno cancelado"
        : items.length > 1
        ? "Turnos confirmados"
        : "Turno confirmado"
    }`,
    preheader: isCancelled
      ? items.length > 1
        ? "Tus turnos fueron cancelados"
        : "Tu turno fue cancelado"
      : items.length > 1
      ? "Tus turnos fueron confirmados"
      : "Tu turno fue confirmado",
    bodyHtml: renderExactUserShell(innerHtml),
    footerNote: "",
  });
}

/* =========================================================
   Card admin con misma estética
========================================================= */

function buildExactAdminAppointmentVisualHtml({
  user,
  items = [],
  kind = "booked",
  meta = {},
}) {
  const isCancelled = kind === "cancelled";
  const icon = isCancelled ? "✕" : "✓";
  const uName = getUserName(user);
  const uEmail = user?.email || "-";

  const title = isCancelled
    ? items.length > 1
      ? "Se cancelaron\nturnos"
      : "Se canceló\nun turno"
    : items.length > 1
    ? "Se reservaron\nturnos"
    : "Se reservó\nun turno";

  const refundFlag = typeof meta?.refund === "boolean" ? meta.refund : null;
  const cutoff =
    typeof meta?.refundCutoffHours === "number" ? meta.refundCutoffHours : null;

  const refundDetail =
    refundFlag === null
      ? ""
      : refundFlag
      ? "Sí (1 sesión)"
      : "No";

  const detailText =
    refundFlag === null
      ? ""
      : refundFlag
      ? "Se reintegró 1 sesión."
      : cutoff
      ? `Fuera del límite (${cutoff} hs).`
      : "Fuera del límite.";

  const metaRows = [
    { label: "Usuario", value: uName },
    { label: "Email", value: uEmail },
  ];

  if (refundDetail) metaRows.push({ label: "Reintegro", value: refundDetail });
  if (detailText) metaRows.push({ label: "Detalle", value: detailText });

  const innerHtml = `
    ${renderExactStatusIcon(icon)}
    ${renderExactTitle(title, 285)}
    ${renderAdminMetaPanel(metaRows)}
    ${renderExactTurnsPanel(items)}
  `;

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${
      isCancelled ? "Admin turno cancelado" : "Admin turno reservado"
    }`,
    preheader: `${uName} · ${isCancelled ? "cancelación" : "reserva"} de turno`,
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

  const svc = getServiceName(ap, serviceName);

  const subject = `✅ Tu turno fue reservado - ${BRAND_NAME}`;
  const text = [
    `Hola ${user?.name || ""}`.trim() + ",",
    "",
    "Tu turno fue reservado con éxito.",
    "",
    `Día: ${ap?.date || "-"}`,
    `Horario: ${ap?.time || "-"} hs`,
    `Servicio: ${svc}`,
    "",
    "Si no podés asistir, recordá cancelarlo con anticipación desde tu perfil.",
  ].join("\n");

  const html = buildExactAppointmentVisualHtml({
    items: [{ ...ap, serviceName: svc }],
    kind: "booked",
    showBottomText: true,
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

  const svc = getServiceName(ap, serviceName);

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
    `Horario: ${ap?.time || "-"} hs`,
    `Servicio: ${svc}`,
    refundLine,
    extraExplain,
    "",
    "Si querés, podés volver a reservar desde tu perfil.",
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildExactAppointmentVisualHtml({
    items: [{ ...ap, serviceName: svc }],
    kind: "cancelled",
    showBottomText: true,
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
      fontSize: 15,
      lineHeight: 20,
      weight: 700,
      maxWidth: 320,
      marginBottom: 10,
    })}
    ${renderExactBodyText(
      "Te recordamos que tenés un turno en las próximas 24 horas.",
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 16,
      }
    )}
    ${renderExactTurnsPanel([{ ...ap, serviceName: svc }])}
    ${renderExactBodyText(
      "Si no podés asistir, cancelá el turno para liberar el espacio.",
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
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
   ADMIN emails (misma estética)
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
    `Horario: ${ap?.time || "-"} hs`,
    `Servicio: ${svc}`,
    ap?.notes ? `Notas: ${String(ap.notes)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildExactAdminAppointmentVisualHtml({
    user,
    items: [{ ...ap, serviceName: svc }],
    kind: "booked",
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
    `Horario: ${ap?.time || "-"} hs`,
    `Servicio: ${svc}`,
    refundLine,
    extraExplain,
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildExactAdminAppointmentVisualHtml({
    user,
    items: [{ ...ap, serviceName: svc }],
    kind: "cancelled",
    meta,
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

  const html = buildExactAppointmentVisualHtml({
    items: list,
    kind: "booked",
    showBottomText: true,
  });

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
    "",
    "Si querés, podés volver a reservar desde tu perfil.",
  ].join("\n");

  const html = buildExactAppointmentVisualHtml({
    items: list,
    kind: "cancelled",
    showBottomText: true,
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
      fontSize: 15,
      lineHeight: 20,
      weight: 700,
      maxWidth: 320,
      marginBottom: 10,
    })}
    ${renderExactBodyText(
      "Se liberó un cupo para el turno que tenías en lista de espera.",
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 16,
      }
    )}
    ${renderExactTurnsPanel([{ ...ap, serviceName: svc }])}
    ${renderExactBodyText(
      totalNotified > 1
        ? `Avisamos a vos y a otras ${totalNotified - 1} personas. El turno se asigna al primero que lo confirme.`
        : "El turno se asigna al primero que lo confirme.",
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
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
        lineHeight: 17,
        weight: 600,
        maxWidth: 320,
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