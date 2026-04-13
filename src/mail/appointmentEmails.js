// backend/src/mail/appointmentEmails.js
import { ADMIN_EMAIL, BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { escapeHtml, prettyDateAR } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";
import {
  buildExactMail,
  renderExactBodyText,
  renderExactReminderBellIcon,
  renderPrimaryButton,
  renderAdminMetaPanel,
  renderAdminDetailPanel,
  renderRowCard,
} from "./ui.js";

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

function normalizeItems(items = []) {
  return (Array.isArray(items) ? items : []).map((it) => ({
    ...it,
    serviceName: getServiceName(it, it?.serviceName),
  }));
}

function buildTurnsPanel(items = []) {
  const list = normalizeItems(items);

  const cards = list.length
    ? list
        .map((it) => {
          const date = prettyDateAR(it?.date || "");
          const time = `${it?.time || "-"} hs`;
          const service = getServiceName(it, it?.serviceName);

          return renderRowCard({
            titleLeft: date,
            titleRight: time,
            subtitle: `<span style="color:#ffffff;">${escapeHtml(service)}</span>`,
          });
        })
        .join("")
    : `
      <div style="
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
    <div
      class="panel turns-panel"
      style="
        background:#0a0a0a;
        border-radius:6px;
        padding:14px;
        margin:0 auto 22px;
        max-width:100%;
        text-align:left;
      "
    >
      ${cards}
    </div>
  `;
}

function buildAppointmentEmail({
  title,
  preheader,
  icon = "✓",
  items = [],
  topTextHtml = "",
  bottomTextHtml = "",
}) {
  const exact = buildExactMail({
    brandName: BRAND_NAME,
    title,
    preheader,
    icon,
    innerHtml: `
      ${topTextHtml || ""}
      ${buildTurnsPanel(items)}
      ${bottomTextHtml || ""}
    `,
  });

  return buildEmailLayout({
    title: exact.title,
    preheader: exact.preheader,
    bodyHtml: exact.bodyHtml,
    footerNote: "",
  });
}

function buildReminderEmail({ items = [] }) {
  const bodyHtml = `
    ${renderExactReminderBellIcon()}
    <div
      class="mail-title"
      style="
        font-size:19px;
        line-height:20px;
        font-weight:900;
        margin:0 auto 18px;
        max-width:285px;
        color:#111111;
        white-space:pre-line;
        letter-spacing:-0.2px;
      "
    >
      Recordatorio de turno
    </div>

    ${buildTurnsPanel(items)}

    ${renderExactBodyText(
      "Si no podés asistir, recordá cancelarlo con anticipación desde tu perfil.",
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 305,
        marginBottom: 0,
      }
    )}
  `;

  return buildEmailLayout({
    title: `${BRAND_NAME} · Recordatorio de turno`,
    preheader: "Recordatorio: tenés un turno agendado",
    bodyHtml: `
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr>
          <td align="center" style="padding:0;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:430px; border-collapse:separate;">
              <tr>
                <td
                  class="mail-shell"
                  bgcolor="#ffffff"
                  style="
                    background:#ffffff;
                    border-radius:14px;
                    padding:18px 10px 26px;
                    text-align:center;
                    color:#111111;
                  "
                >
                  <style>
                    @media only screen and (max-width: 560px) {
                      .mail-shell { padding:16px 8px 22px !important; }
                      .mail-title { font-size:18px !important; line-height:19px !important; margin:0 auto 16px !important; }
                      .panel { padding:12px !important; }
                      .row-card { padding:9px 10px !important; }
                      .row-k { font-size:14px !important; line-height:16px !important; }
                      .row-v { font-size:13px !important; line-height:15px !important; }
                      .reminder-bell { width:64px !important; height:64px !important; }
                    }
                  </style>
                  ${bodyHtml}
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `,
    footerNote: "",
  });
}

function buildAdminAppointmentEmail({
  user,
  items = [],
  kind = "booked",
  meta = {},
}) {
  const list = normalizeItems(items);
  const isCancelled = kind === "cancelled";
  const icon = isCancelled ? "✕" : "✓";
  const uName = getUserName(user);
  const uEmail = user?.email || "-";

  const title = isCancelled
    ? list.length > 1
      ? "Se cancelaron\nturnos"
      : "Se canceló\nun turno"
    : list.length > 1
    ? "Se reservaron\nturnos"
    : "Se reservó\nun turno";

  const refundFlag =
    typeof meta?.refund === "boolean"
      ? meta.refund
      : typeof list?.[0]?.refund === "boolean"
      ? list[0].refund
      : null;

  const cutoff =
    typeof meta?.refundCutoffHours === "number"
      ? meta.refundCutoffHours
      : typeof list?.[0]?.refundCutoffHours === "number"
      ? list[0].refundCutoffHours
      : null;

  const refundDetail =
    refundFlag === null ? "" : refundFlag ? "Sí (1 sesión)" : "No";

  const detailText =
    refundFlag === null
      ? ""
      : refundFlag
      ? "Se reintegró 1 sesión."
      : cutoff
      ? `Fuera del límite (${cutoff} hs).`
      : "Fuera del límite.";

  const exact = buildExactMail({
    brandName: BRAND_NAME,
    title,
    preheader: `${uName} · ${isCancelled ? "cancelación" : "reserva"} de turno`,
    icon,
    innerHtml: `
      ${renderAdminMetaPanel([
        { label: "Usuario", value: uName },
        { label: "Email", value: uEmail },
      ])}

      ${
        refundDetail || detailText
          ? renderAdminDetailPanel(
              [
                refundDetail ? { label: "Reintegro", value: refundDetail } : null,
                detailText ? { label: "Detalle", value: detailText } : null,
              ].filter(Boolean)
            )
          : ""
      }

      ${buildTurnsPanel(list)}
    `,
  });

  return buildEmailLayout({
    title: exact.title,
    preheader: exact.preheader,
    bodyHtml: exact.bodyHtml,
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
  const item = { ...ap, serviceName: svc };

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

  const html = buildAppointmentEmail({
    title: "Turno confirmado\ncon éxito.",
    preheader: "Tu turno fue confirmado",
    icon: "✓",
    items: [item],
    topTextHtml: renderExactBodyText(
      `Hola <b>${escapeHtml(user?.name || "Usuario")}</b>,<br/>Tu turno fue confirmado correctamente.`,
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 14,
      }
    ),
    bottomTextHtml: `
      ${renderPrimaryButton(`Ingresar a ${BRAND_NAME}`, BRAND_URL)}
      ${renderExactBodyText(
        "Ingresá a DUO para revisar el detalle.",
        {
          fontSize: 12,
          lineHeight: 17,
          weight: 600,
          maxWidth: 320,
          marginTop: 8,
          marginBottom: 0,
        }
      )}
    `,
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
    refund:
      typeof meta?.refund === "boolean" ? meta.refund : ap?.refund,
    refundCutoffHours:
      typeof meta?.refundCutoffHours === "number"
        ? meta.refundCutoffHours
        : ap?.refundCutoffHours,
  });

  if (!user?.email) return;

  const svc = getServiceName(ap, serviceName);
  const item = { ...ap, serviceName: svc };

  const refundFlag =
    typeof meta?.refund === "boolean"
      ? meta.refund
      : typeof ap?.refund === "boolean"
      ? ap.refund
      : null;

  const cutoff =
    typeof meta?.refundCutoffHours === "number"
      ? meta.refundCutoffHours
      : typeof ap?.refundCutoffHours === "number"
      ? ap.refundCutoffHours
      : null;

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

  const cancelExplain =
    refundFlag === null
      ? "Tu turno fue cancelado correctamente."
      : refundFlag
      ? "Tu turno fue cancelado correctamente.<br/>Si corresponde según la política de cancelación, el crédito ya fue reintegrado a tu cuenta."
      : "Tu turno fue cancelado correctamente.";

  const html = buildAppointmentEmail({
    title: "Turno cancelado\ncon éxito.",
    preheader: "Tu turno fue cancelado",
    icon: "✕",
    items: [item],
    topTextHtml: renderExactBodyText(
      `Hola <b>${escapeHtml(user?.name || "Usuario")}</b>,<br/>${cancelExplain}`,
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 14,
      }
    ),
    bottomTextHtml: `
      ${renderPrimaryButton(`Ingresar a ${BRAND_NAME}`, BRAND_URL)}
      ${renderExactBodyText(
        "Ingresá a DUO para revisar el detalle.",
        {
          fontSize: 12,
          lineHeight: 17,
          weight: 600,
          maxWidth: 320,
          marginTop: 8,
          marginBottom: 0,
        }
      )}
    `,
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

  const svc = getServiceName(ap, serviceName);

  const subject = `🔔 Recordatorio de turno - ${BRAND_NAME}`;

  const text = [
    `Hola ${user?.name || ""}`.trim() + ",",
    "",
    "Te recordamos que tenés un turno agendado.",
    "",
    `Día: ${ap?.date || "-"}`,
    `Horario: ${ap?.time || "-"} hs`,
    `Servicio: ${svc}`,
    "",
    "Si no podés asistir, recordá anularlo con anticipación desde tu perfil.",
  ].join("\n");

  const html = buildReminderEmail({
    items: [{ ...ap, serviceName: svc }],
  });

  await sendMail(user.email, subject, text, html);
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
    `Horario: ${ap?.time || "-"} hs`,
    `Servicio: ${svc}`,
    ap?.notes ? `Notas: ${String(ap.notes)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildAdminAppointmentEmail({
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

  const refundFlag =
    typeof meta?.refund === "boolean"
      ? meta.refund
      : typeof ap?.refund === "boolean"
      ? ap.refund
      : null;

  const cutoff =
    typeof meta?.refundCutoffHours === "number"
      ? meta.refundCutoffHours
      : typeof ap?.refundCutoffHours === "number"
      ? ap.refundCutoffHours
      : null;

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

  const html = buildAdminAppointmentEmail({
    user,
    items: [{ ...ap, serviceName: svc }],
    kind: "cancelled",
    meta: {
      ...meta,
      refund: refundFlag,
      refundCutoffHours: cutoff,
    },
  });

  await sendMail(to, subject, text, html);
}

/* =========================================================
   Batch
========================================================= */

export async function sendAppointmentBookedBatchEmail(user, items = []) {
  console.log("[MAIL][APPT] booked batch ->", {
    to: user?.email,
    count: Array.isArray(items) ? items.length : 0,
  });

  if (!user?.email) return;

  const list = normalizeItems(items);

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

  const html = buildAppointmentEmail({
    title: "Turnos confirmados\ncon éxito.",
    preheader: "Tus turnos fueron confirmados",
    icon: "✓",
    items: list,
    topTextHtml: renderExactBodyText(
      `Hola <b>${escapeHtml(user?.name || "Usuario")}</b>,<br/>Tus turnos fueron confirmados correctamente.`,
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 14,
      }
    ),
    bottomTextHtml: `
      ${renderPrimaryButton(`Ingresar a ${BRAND_NAME}`, BRAND_URL)}
      ${renderExactBodyText(
        "Ingresá a DUO para revisar el detalle.",
        {
          fontSize: 12,
          lineHeight: 17,
          weight: 600,
          maxWidth: 320,
          marginTop: 8,
          marginBottom: 0,
        }
      )}
    `,
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

  const list = normalizeItems(items);

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

  const html = buildAppointmentEmail({
    title: "Turnos cancelados\ncon éxito.",
    preheader: "Tus turnos fueron cancelados",
    icon: "✕",
    items: list,
    topTextHtml: renderExactBodyText(
      `Hola <b>${escapeHtml(user?.name || "Usuario")}</b>,<br/>Tus turnos fueron cancelados correctamente.`,
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 14,
      }
    ),
    bottomTextHtml: `
      ${renderPrimaryButton(`Ingresar a ${BRAND_NAME}`, BRAND_URL)}
      ${renderExactBodyText(
        "Ingresá a DUO para revisar el detalle.",
        {
          fontSize: 12,
          lineHeight: 17,
          weight: 600,
          maxWidth: 320,
          marginTop: 8,
          marginBottom: 0,
        }
      )}
    `,
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

  const exact = buildExactMail({
    brandName: BRAND_NAME,
    title: "Se liberó un cupo",
    preheader: "Se liberó un cupo para tu turno en lista de espera",
    icon: "✓",
    innerHtml: `
      ${renderExactBodyText(`Hola <b>${escapeHtml(uName)}</b>,`, {
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

      ${buildTurnsPanel([{ ...ap, serviceName: svc }])}

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

      ${renderPrimaryButton("Confirmar turno", link)}

      ${renderExactBodyText(
        "Si al entrar ya no aparece disponible, significa que otra persona lo confirmó primero.",
        {
          fontSize: 12,
          lineHeight: 17,
          weight: 600,
          maxWidth: 320,
          marginTop: 8,
          marginBottom: 0,
        }
      )}
    `,
  });

  const html = buildEmailLayout({
    title: exact.title,
    preheader: exact.preheader,
    bodyHtml: exact.bodyHtml,
    footerNote: "",
  });

  await sendMail(
    user.email,
    `Se liberó un cupo para tu turno - ${BRAND_NAME}`,
    text,
    html
  );
}