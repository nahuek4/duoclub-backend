// backend/src/mail/appointmentEmails.jsx
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

function getFirstName(user = {}) {
  return String(user?.name || "").trim() || "Usuario";
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

function safeTime(value) {
  const raw = String(value || "-").trim();
  if (!raw || raw === "-") return "-";
  return /hs$/i.test(raw) ? raw : `${raw} hs`;
}

function buildAppointmentCard(item = {}) {
  const date = prettyDateAR(item?.date || "-");
  const time = safeTime(item?.time || "-");
  const service = getServiceName(item, item?.serviceName);

  return `
    <table
      role="presentation"
      cellpadding="0"
      cellspacing="0"
      width="100%"
      style="
        border-collapse:separate;
        border-spacing:0;
        width:100%;
        margin:0 0 10px;
        background:#ffffff;
        border:1.5px solid #2a2a2a;
        border-radius:10px;
        overflow:hidden;
      "
    >
      <tr>
        <td style="padding:0;">
          <table
            role="presentation"
            cellpadding="0"
            cellspacing="0"
            width="100%"
            style="border-collapse:collapse; width:100%;"
          >
            <tr>
              <td
                style="
                  padding:12px 14px;
                  border-bottom:1px solid #e7e7e7;
                  font-family:Arial, Helvetica, sans-serif;
                  font-size:12px;
                  line-height:16px;
                  font-weight:800;
                  color:#111111;
                "
              >
                <table
                  role="presentation"
                  cellpadding="0"
                  cellspacing="0"
                  width="100%"
                  style="border-collapse:collapse; width:100%;"
                >
                  <tr>
                    <td
                      valign="middle"
                      style="
                        font-family:Arial, Helvetica, sans-serif;
                        font-size:12px;
                        line-height:16px;
                        font-weight:800;
                        color:#111111;
                      "
                    >
                      ${escapeHtml(date)}
                    </td>
                    <td
                      valign="middle"
                      align="right"
                      style="
                        white-space:nowrap;
                        font-family:Arial, Helvetica, sans-serif;
                        font-size:12px;
                        line-height:16px;
                        font-weight:800;
                        color:#111111;
                      "
                    >
                      ${escapeHtml(time)}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td
                style="
                  padding:11px 14px 12px;
                  font-family:Arial, Helvetica, sans-serif;
                  font-size:12px;
                  line-height:16px;
                  font-weight:500;
                  color:#111111;
                "
              >
                ${escapeHtml(service)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

function buildAppointmentCards(items = []) {
  const list = normalizeItems(items);
  if (!list.length) return "";
  return list.map((item) => buildAppointmentCard(item)).join("");
}

function buildTopIcon(kind = "confirmed") {
  const isCancelled = kind === "cancelled";

  if (isCancelled) {
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="padding:0;">
            <div
              style="
                width:14px;
                height:14px;
                border-radius:50%;
                background:#e4ff00;
                color:#111111;
                font-family:Arial, Helvetica, sans-serif;
                font-size:11px;
                line-height:14px;
                font-weight:900;
                text-align:center;
              "
            >
              ×
            </div>
          </td>
        </tr>
      </table>
    `;
  }

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      <tr>
        <td style="padding:0;">
          <div
            style="
              width:12px;
              height:12px;
              border-radius:50%;
              background:#e4ff00;
              color:#111111;
              font-family:Arial, Helvetica, sans-serif;
              font-size:9px;
              line-height:12px;
              font-weight:900;
              text-align:center;
            "
          >
            ✓
          </div>
        </td>
      </tr>
    </table>
  `;
}

function buildDuoMark() {
  return `
    <div
      style="
        font-family:Arial, Helvetica, sans-serif;
        font-size:34px;
        line-height:34px;
        font-weight:900;
        letter-spacing:-1px;
        color:#ffffff;
      "
    >
      ᗡ◖
    </div>
  `;
}

function buildHeroHeader({ title, kind = "confirmed" }) {
  const notchStyle =
    kind === "cancelled"
      ? "left:0; right:auto; border-top-left-radius:0; border-top-right-radius:14px;"
      : "right:0; left:auto; border-top-right-radius:0; border-top-left-radius:14px;";

  const lineStyle =
    kind === "cancelled"
      ? "left:34px; right:auto;"
      : "right:34px; left:auto;";

  return `
    <tr>
      <td
        style="
          background:#050505;
          padding:16px 16px 40px;
          border-top-left-radius:16px;
          border-top-right-radius:16px;
          position:relative;
        "
      >
        <table
          role="presentation"
          cellpadding="0"
          cellspacing="0"
          width="100%"
          style="border-collapse:collapse; width:100%;"
        >
          <tr>
            <td valign="top" align="left">${buildTopIcon(kind)}</td>
            <td valign="top" align="right">${buildDuoMark()}</td>
          </tr>
          <tr>
            <td colspan="2" style="padding:18px 0 0;">
              <div
                style="
                  max-width:180px;
                  font-family:Arial, Helvetica, sans-serif;
                  font-size:28px;
                  line-height:29px;
                  font-weight:900;
                  letter-spacing:-0.7px;
                  color:#ffffff;
                "
              >
                ${title}
              </div>
            </td>
          </tr>
        </table>

        <div
          style="
            position:relative;
            height:0;
          "
        >
          <div
            style="
              position:absolute;
              bottom:-40px;
              ${notchStyle}
              width:66px;
              height:34px;
              background:#f3f3f3;
            "
          ></div>
          <div
            style="
              position:absolute;
              bottom:-7px;
              ${lineStyle}
              width:68px;
              height:0;
              border-top:3px solid #19a1ff;
              transform:skew(-36deg);
            "
          ></div>
        </div>
      </td>
    </tr>
  `;
}

function buildFooterBlock() {
  return `
    <tr>
      <td
        style="
          background:#0a0a0a;
          padding:24px 24px 22px;
        "
      >
        <table
          role="presentation"
          cellpadding="0"
          cellspacing="0"
          width="100%"
          style="border-collapse:collapse; width:100%;"
        >
          <tr>
            <td
              valign="bottom"
              style="
                width:50%;
                font-family:Arial, Helvetica, sans-serif;
                color:#ffffff;
              "
            >
              <div style="font-size:26px; line-height:26px; font-weight:900; letter-spacing:2px;">DUO</div>
              <div style="font-size:7px; line-height:10px; opacity:0.8; letter-spacing:1.2px; margin-top:3px;">HEALTH CLUB</div>
            </td>
            <td
              valign="bottom"
              align="right"
              style="
                width:50%;
                font-family:Arial, Helvetica, sans-serif;
                color:#ffffff;
              "
            >
              <div style="font-size:10px; line-height:14px; font-weight:700;">DUOCLUB.AR</div>
              <div style="font-size:10px; line-height:14px; font-weight:500; opacity:0.95;">+54 9 249 123 7458</div>
              <div style="font-size:10px; line-height:14px; font-weight:500; opacity:0.95;">Av. Santamarina 791, Tandil.</div>
              <div style="margin-top:6px; font-size:0; line-height:0;">
                <span style="display:inline-block; width:12px; height:12px; border-radius:50%; border:1px solid #ffffff; margin-left:4px;"></span>
                <span style="display:inline-block; width:12px; height:12px; border-radius:50%; border:1px solid #ffffff; margin-left:4px;"></span>
                <span style="display:inline-block; width:12px; height:12px; border-radius:50%; border:1px solid #ffffff; margin-left:4px;"></span>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}

function buildAppointmentVisualEmail({
  title,
  preheader,
  kind = "confirmed",
  user,
  items = [],
  introHtml = "",
  noteHtml = "",
  buttonLabel = `Ingresar a ${BRAND_NAME}`,
  buttonHref = BRAND_URL,
}) {
  const firstName = getFirstName(user);
  const cardsHtml = buildAppointmentCards(items);

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${title.replace(/<br\s*\/?>/gi, " ")}`,
    preheader,
    footerNote: "",
    bodyHtml: `
      <style>
        @media only screen and (max-width: 560px) {
          .ap-card {
            border-radius: 16px !important;
          }
          .ap-body {
            padding: 22px 22px 26px !important;
          }
          .ap-title {
            font-size: 27px !important;
            line-height: 28px !important;
          }
          .ap-copy {
            font-size: 13px !important;
            line-height: 18px !important;
          }
          .ap-footer {
            padding: 22px 20px 20px !important;
          }
        }
      </style>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
        <tr>
          <td align="center" style="padding:0 10px;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:360px; border-collapse:separate; border-spacing:0;">
              <tr>
                <td
                  class="ap-card"
                  style="
                    background:#f3f3f3;
                    border-radius:16px;
                    overflow:hidden;
                  "
                >
                  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                    ${buildHeroHeader({ title, kind })}

                    <tr>
                      <td
                        class="ap-body"
                        style="
                          background:#f3f3f3;
                          padding:22px 26px 28px;
                          font-family:Arial, Helvetica, sans-serif;
                          color:#111111;
                        "
                      >
                        <div
                          class="ap-copy"
                          style="
                            font-size:12px;
                            line-height:17px;
                            font-weight:500;
                            color:#111111;
                            margin:0 0 18px;
                          "
                        >
                          Hola <b>${escapeHtml(firstName)}</b>,<br />
                          ${introHtml}
                        </div>

                        ${cardsHtml}

                        <div style="text-align:center; padding:16px 0 0;">
                          <a
                            href="${escapeHtml(buttonHref || BRAND_URL || "#")}" 
                            style="
                              display:inline-block;
                              text-decoration:none;
                              background:#e4ff00;
                              color:#111111;
                              font-family:Arial, Helvetica, sans-serif;
                              font-size:12px;
                              line-height:12px;
                              font-weight:800;
                              padding:12px 18px;
                              border-radius:999px;
                            "
                          >${escapeHtml(buttonLabel)}</a>
                        </div>

                        ${
                          noteHtml
                            ? `
                          <div
                            class="ap-copy"
                            style="
                              font-size:10px;
                              line-height:15px;
                              font-weight:600;
                              color:#111111;
                              text-align:center;
                              margin:18px auto 0;
                              max-width:220px;
                            "
                          >
                            ${noteHtml}
                          </div>
                        `
                            : ""
                        }
                      </td>
                    </tr>

                    ${buildFooterBlock()}
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `,
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

    ${normalizeItems(items)
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
      .join("")}

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

      ${list
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
        .join("")}
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
    "Tu turno fue confirmado con éxito.",
    "",
    `Día: ${ap?.date || "-"}`,
    `Horario: ${ap?.time || "-"} hs`,
    `Servicio: ${svc}`,
    "",
    "Si no podés asistir, recordá cancelarlo con anticipación desde tu perfil.",
  ].join("\n");

  const html = buildAppointmentVisualEmail({
    title: "Turno confirmado<br />con éxito.",
    preheader: "Tu turno fue confirmado",
    kind: "confirmed",
    user,
    items: [item],
    introHtml:
      "Tu turno fue confirmado correctamente.<br />Si no podés asistir, recordá cancelarlo con anticipación desde tu perfil.",
    noteHtml: `Ingresá a ${escapeHtml(BRAND_NAME)} para revisar el detalle.`,
    buttonLabel: `Ingresar a ${BRAND_NAME}`,
    buttonHref: BRAND_URL,
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

  const introHtml =
    refundFlag === null
      ? "Tu turno fue cancelado correctamente."
      : refundFlag
        ? "Tu turno fue cancelado correctamente.<br />Si correspondiera según la política de cancelación, el crédito ya fue reintegrado a tu cuenta."
        : "Tu turno fue cancelado correctamente.<br />Si correspondiera según la política de cancelación, el crédito ya fue reintegrado a tu cuenta.";

  const html = buildAppointmentVisualEmail({
    title: "Turno cancelado<br />con éxito.",
    preheader: "Tu turno fue cancelado",
    kind: "cancelled",
    user,
    items: [item],
    introHtml,
    noteHtml: `Ingresá a ${escapeHtml(BRAND_NAME)} para revisar el detalle.`,
    buttonLabel: `Ingresar a ${BRAND_NAME}`,
    buttonHref: BRAND_URL,
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

  const html = buildAppointmentVisualEmail({
    title: "Turnos confirmados<br />con éxito.",
    preheader: "Tus turnos fueron confirmados",
    kind: "confirmed",
    user,
    items: list,
    introHtml:
      "Tus turnos fueron confirmados correctamente.<br />Si no podés asistir, recordá cancelarlos con anticipación desde tu perfil.",
    noteHtml: `Ingresá a ${escapeHtml(BRAND_NAME)} para revisar el detalle.`,
    buttonLabel: `Ingresar a ${BRAND_NAME}`,
    buttonHref: BRAND_URL,
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

  const html = buildAppointmentVisualEmail({
    title: "Turnos cancelados<br />con éxito.",
    preheader: "Tus turnos fueron cancelados",
    kind: "cancelled",
    user,
    items: list,
    introHtml: "Tus turnos fueron cancelados correctamente.",
    noteHtml: `Ingresá a ${escapeHtml(BRAND_NAME)} para revisar el detalle.`,
    buttonLabel: `Ingresar a ${BRAND_NAME}`,
    buttonHref: BRAND_URL,
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

      ${normalizeItems([{ ...ap, serviceName: svc }])
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
        .join("")}

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
