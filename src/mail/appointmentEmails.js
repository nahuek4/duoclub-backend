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

const IMG_BASE = "https://api.duoclub.ar/images";

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

function duoFontStack() {
  return `'Helvetica Neue', Helvetica, Arial, sans-serif`;
}


function buildTopIcon(kind = "confirmed") {
  const iconFile = kind === "cancelled" ? "iconocheck.png" : "iconocheck.png";

  return `
    <img
      src="${IMG_BASE}/${iconFile}"
      width="40"
      height="40"
      alt=""
      style="
        display:block;
        width:40px;
        height:40px;
        border:0;
        outline:none;
        text-decoration:none;
      "
    />
  `;
}

function buildDuoMark() {
  return `
    <img
      src="${IMG_BASE}/logo.png"
      width="34"
      alt="${escapeHtml(BRAND_NAME)}"
      style="
        display:block;
        width:34px;
        height:auto;
        border:0;
        outline:none;
        text-decoration:none;
      "
    />
  `;
}

function buildHeroHeader({ title, kind = "confirmed" }) {
  return `
    <tr>
      <td style="padding:0;">
        <table
          role="presentation"
          cellpadding="0"
          cellspacing="0"
          width="100%"
          style="border-collapse:separate; border-spacing:0; width:100%;"
        >
          <tr>
            <td
              style="
                background:#050505;
                border-top-left-radius:28px;
                border-top-right-radius:28px;
                border-bottom-right-radius:0;
                border-bottom-left-radius:0;
                overflow:hidden;
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
                  <td style="padding:18px 18px 0;">
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
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="padding:14px 18px 18px;">
                    <div
                      class="ap-title"
                      style="
                        max-width:220px;
                        font-family:${duoFontStack()};
                        font-size:25px;
                        line-height:31px;
                        font-weight:900;
                        letter-spacing:-0.8px;
                        color:#ffffff;
                      "
                    >
                      ${title}
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="right" style="padding:0; font-size:0; line-height:0;">
              <div
                style="
                  width:115px;
                  height:36px;
                  background:#f3f3f3;
                  border-top-left-radius:28px;
                "
              ></div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
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
        margin:0 0 14px;
        background:#f3f3f3;
        border:1.5px solid #171717;
        border-radius:14px;
        overflow:hidden;
      "
    >
      <tr>
        <td style="width:11px; background:#050505; font-size:0; line-height:0;">&nbsp;</td>
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
                  padding:16px 16px 12px;
                  border-bottom:1px solid #d3d3d3;
                  font-family:${duoFontStack()};
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
                        font-family:${duoFontStack()};
                        font-size:12px;
                        line-height:16px;
                        font-weight:800;
                        color:#111111;
                        padding-right:12px;
                      "
                    >
                      ${escapeHtml(date)}
                    </td>
                    <td
                      valign="middle"
                      align="right"
                      style="
                        white-space:nowrap;
                        font-family:${duoFontStack()};
                        font-size:12px;
                        line-height:16px;
                        font-weight:800;
                        color:#111111;
                        border-left:1px solid #d3d3d3;
                        padding-left:12px;
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
                  padding:14px 16px 15px;
                  font-family:${duoFontStack()};
                  font-size:13px;
                  line-height:17px;
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


function buildAdminDataCard({ label, value, valueHtml = "" } = {}) {
  const content = valueHtml || escapeHtml(value || "-");
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
        background:#f3f3f3;
        border:1.5px solid #171717;
        border-radius:14px;
        overflow:hidden;
      "
    >
      <tr>
        <td style="width:11px; background:#050505; font-size:0; line-height:0;">&nbsp;</td>
        <td
          style="
            padding:13px 16px 14px;
            font-family:${duoFontStack()};
            color:#111111;
          "
        >
          <div
            style="
              font-size:10px;
              line-height:13px;
              font-weight:800;
              text-transform:uppercase;
              letter-spacing:0.9px;
              margin:0 0 5px;
              color:#6f6f6f;
            "
          >${escapeHtml(label || "Dato")}</div>

          <div
            style="
              font-size:13px;
              line-height:18px;
              font-weight:700;
              color:#111111;
              word-break:break-word;
            "
          >${content}</div>
        </td>
      </tr>
    </table>
  `;
}

function buildAdminDataCards(rows = []) {
  const validRows = (Array.isArray(rows) ? rows : []).filter(
    (row) => row && row.label && (row.value || row.valueHtml)
  );

  if (!validRows.length) return "";

  return validRows.map((row) => buildAdminDataCard(row)).join("");
}

function buildAdminAppointmentVisualEmail({
  title,
  preheader,
  kind = "confirmed",
  introHtml = "",
  detailCardsHtml = "",
  items = [],
  noteHtml = "",
}) {
  const cardsHtml = buildAppointmentCards(items);

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${title.replace(/<br\s*\/?>/gi, " ")}`,
    preheader,
    footerNote: "",
    bodyHtml: `
      <style>
        @media only screen and (max-width: 560px) {
          .ap-wrap {
            width:100% !important;
            max-width:370px !important;
          }
          .ap-title {
            font-size:24px !important;
            line-height:29px !important;
          }
          .ap-body {
            padding:16px 22px 28px !important;
          }
          .ap-copy {
            font-size:15px !important;
            line-height:22px !important;
          }
          .ap-note {
            font-size:13px !important;
            line-height:20px !important;
          }
          .ap-footer {
            padding:28px 22px 30px !important;
          }
        }
      </style>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
        <tr>
          <td align="center" style="padding:0;">
            <table
              role="presentation"
              cellpadding="0"
              cellspacing="0"
              width="100%"
              class="ap-wrap"
              style="max-width:372px; border-collapse:separate; border-spacing:0;"
            >
              <tr>
                <td
                  style="
                    background:#f3f3f3;
                    border-radius:28px;
                    overflow:hidden;
                  "
                >
                  <table
                    role="presentation"
                    cellpadding="0"
                    cellspacing="0"
                    width="100%"
                    style="
                      border-collapse:collapse;
                      width:100%;
                      background-color:#f3f3f3;
                    "
                  >
                    ${buildHeroHeader({ title, kind })}

                    <tr>
                      <td
                        class="ap-body"
                        style="
                          padding:12px 34px 30px;
                          font-family:${duoFontStack()};
                          color:#111111;
                        "
                      >
                        <div
                          class="ap-copy"
                          style="
                            font-size:17px;
                            line-height:28px;
                            font-weight:500;
                            color:#111111;
                            margin:0 0 18px;
                          "
                        >
                          ${introHtml}
                        </div>

                        ${detailCardsHtml}

                        ${cardsHtml}

                        ${
                          noteHtml
                            ? `
                          <div
                            class="ap-note"
                            style="
                              font-size:13px;
                              line-height:21px;
                              font-weight:600;
                              color:#111111;
                              text-align:center;
                              margin:22px auto 0;
                              max-width:255px;
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


function buildFooterBlock() {
  return `
    <tr>
      <td
        class="ap-footer"
        style="
          background:#050505;
          padding:28px 24px 30px;
          border-bottom-left-radius:28px;
          border-bottom-right-radius:28px;
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
                width:46%;
                font-family:${duoFontStack()};
                color:#ffffff;
              "
            >
              <div style="font-size:26px; line-height:24px; font-weight:900; letter-spacing:1px;">DUO</div>
              <div style="font-size:5px; line-height:8px; opacity:0.95; letter-spacing:1.4px; margin-top:4px;">HEALTH CLUB</div>
            </td>
            <td
              valign="bottom"
              align="right"
              style="
                width:54%;
                font-family:${duoFontStack()};
                color:#ffffff;
              "
            >
              <div style="font-size:12px; line-height:16px; font-weight:800; letter-spacing:2px;">DUOCLUB.AR</div>
              <div style="font-size:10px; line-height:15px; font-weight:400; opacity:0.96;">+549 249 420 7343</div>
              <div style="font-size:10px; line-height:15px; font-weight:400; opacity:0.96;">Av. Santamaría 54, Tandil.</div>
              <div style="margin-top:10px; font-size:0; line-height:0;">
                <span
                  style="
                    display:inline-block;
                    width:17px;
                    height:17px;
                    border-radius:50%;
                    background:#ffffff;
                    color:#050505;
                    font-family:${duoFontStack()};
                    font-size:9px;
                    line-height:17px;
                    text-align:center;
                    margin-left:6px;
                  "
                >ig</span>
                <span
                  style="
                    display:inline-block;
                    width:17px;
                    height:17px;
                    border-radius:50%;
                    background:#ffffff;
                    color:#050505;
                    font-family:${duoFontStack()};
                    font-size:10px;
                    line-height:17px;
                    text-align:center;
                    margin-left:6px;
                  "
                >f</span>
                <span
                  style="
                    display:inline-block;
                    width:17px;
                    height:17px;
                    border-radius:50%;
                    background:#ffffff;
                    color:#050505;
                    font-family:${duoFontStack()};
                    font-size:9px;
                    line-height:17px;
                    text-align:center;
                    margin-left:6px;
                  "
                >in</span>
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
          .ap-wrap {
            width:100% !important;
            max-width:370px !important;
          }
          .ap-title {
            font-size:24px !important;
            line-height:29px !important;
          }
          .ap-body {
            padding:16px 22px 28px !important;
          }
          .ap-copy {
            font-size:15px !important;
            line-height:22px !important;
          }
          .ap-note {
            font-size:13px !important;
            line-height:20px !important;
          }
          .ap-cta {
            font-size:14px !important;
            line-height:18px !important;
            padding:14px 18px !important;
          }
          .ap-footer {
            padding:28px 22px 30px !important;
          }
        }
      </style>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
        <tr>
          <td align="center" style="padding:0;">
            <table
              role="presentation"
              cellpadding="0"
              cellspacing="0"
              width="100%"
              class="ap-wrap"
              style="max-width:372px; border-collapse:separate; border-spacing:0;"
            >
              <tr>
                <td
                  style="
                    background:#f3f3f3;
                    border-radius:28px;
                    overflow:hidden;
                  "
                >
                  <table
                    role="presentation"
                    cellpadding="0"
                    cellspacing="0"
                    width="100%"
                    style="
                      border-collapse:collapse;
                      width:100%;
                      background-color:#f3f3f3;
                    "
                  >
                    ${buildHeroHeader({ title, kind })}

                    <tr>
                      <td
                        class="ap-body"
                        style="
                          padding:12px 34px 30px;
                          font-family:${duoFontStack()};
                          color:#111111;
                        "
                      >
                        <div
                          class="ap-copy"
                          style="
                            font-size:17px;
                            line-height:28px;
                            font-weight:500;
                            color:#111111;
                            margin:0 0 18px;
                          "
                        >
                          Hola <b>${escapeHtml(firstName)}</b>,<br />
                          ${introHtml}
                        </div>

                        ${cardsHtml}

                        <div style="text-align:center; padding:10px 0 0;">
                          <a
                            href="${escapeHtml(buttonHref || BRAND_URL || "#") }"
                            class="ap-cta"
                            style="
                              display:inline-block;
                              text-decoration:none;
                              background:#efff00;
                              color:#111111;
                              font-family:${duoFontStack()};
                              font-size:15px;
                              line-height:19px;
                              font-weight:800;
                              padding:15px 20px;
                              border-radius:999px;
                              box-shadow:0 7px 14px rgba(0,0,0,0.18);
                            "
                          >${escapeHtml(buttonLabel)}</a>
                        </div>

                        ${
                          noteHtml
                            ? `
                          <div
                            class="ap-note"
                            style="
                              font-size:13px;
                              line-height:21px;
                              font-weight:600;
                              color:#111111;
                              text-align:center;
                              margin:28px auto 0;
                              max-width:255px;
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
  const uName = getUserName(user);
  const uEmail = user?.email || "-";

  const title = isCancelled
    ? list.length > 1
      ? "Turnos cancelados<br />en admin."
      : "Turno cancelado<br />en admin."
    : list.length > 1
      ? "Turnos reservados<br />en admin."
      : "Turno reservado<br />en admin.";

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

  const introHtml = isCancelled
    ? `<b>${escapeHtml(uName)}</b> canceló ${
        list.length > 1 ? "sus turnos" : "un turno"
      }.<br />Revisá abajo el detalle completo.`
    : `<b>${escapeHtml(uName)}</b> reservó ${
        list.length > 1 ? "nuevos turnos" : "un turno"
      }.<br />Revisá abajo el detalle completo.`;

  const detailCardsHtml = buildAdminDataCards([
    { label: "Usuario", value: uName },
    { label: "Email", value: uEmail },
    refundDetail ? { label: "Reintegro", value: refundDetail } : null,
    detailText ? { label: "Detalle", value: detailText } : null,
  ]);

  return buildAdminAppointmentVisualEmail({
    title,
    preheader: `${uName} · ${isCancelled ? "cancelación" : "reserva"} de turno`,
    kind: isCancelled ? "cancelled" : "confirmed",
    introHtml,
    detailCardsHtml,
    items: list,
    noteHtml: `Mail automático de ${escapeHtml(BRAND_NAME)} para administración.`,
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
      "Tu turno fue confirmado correctamente.<br /><b>Si no podés asistir, recordá cancelarlo con anticipación desde tu perfil.</b>",
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
        ? "Tu turno fue cancelado correctamente.<br /><b>Si correspondiera según la política de cancelación, el crédito ya fue reintegrado a tu cuenta.</b>"
        : "Tu turno fue cancelado correctamente.<br /><b>Si correspondiera según la política de cancelación, el crédito ya fue reintegrado a tu cuenta.</b>";

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
t