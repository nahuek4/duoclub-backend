// backend/src/mail/orderEmails.js
import { ADMIN_EMAIL, BRAND_NAME, sendMail } from "./core.js";
import { EMAIL_FONT, escapeHtml, moneyARS } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";

/* =========================================================
   Helpers ORDER
========================================================= */

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
  const statusRaw = String(order?.status || "pending").toLowerCase();

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
    statusRaw,
    totalFinal,
    items,
    itemsCount,
  };
}

function statusLabel(statusRaw = "") {
  const s = String(statusRaw || "").toLowerCase();
  if (s === "paid") return "Pagado";
  if (s === "pending") return "Pendiente";
  if (s === "cancelled" || s === "canceled") return "Cancelado";
  if (s === "refunded") return "Reintegrado";
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "-";
}

function itemLine(it = {}) {
  const kind = String(it?.kind || "").toUpperCase();
  const qty = Math.max(1, Number(it?.qty) || 1);

  if (kind === "CREDITS") {
    const svc = String(it?.serviceKey || "EP").toUpperCase();
    const cr = Number(it?.credits) || 0;
    return `Créditos ${cr} (${svc}) x${qty}`;
  }

  if (kind === "MEMBERSHIP") {
    const months = qty;
    return `Membresía DUO+ (${months} mes/es)`;
  }

  const name = it?.label || it?.name || it?.title || "Item";
  return `${name} x${qty}`;
}

/* =========================================================
   UI (MISMO LOOK QUE TURNOS)
========================================================= */

function renderExactUserShell(innerHtml) {
  return `
    <style>
      @media only screen and (max-width: 560px) {
        .mail-shell { padding:16px 8px 22px !important; }
        .mail-title { font-size:18px !important; line-height:19px !important; margin:0 auto 16px !important; }
        .panel { padding:12px !important; }
        .row-card { padding:9px 10px !important; }
        .row-k { font-size:14px !important; line-height:16px !important; }
        .row-v { font-size:13px !important; line-height:15px !important; }
        .status-icon { width:54px !important; height:54px !important; line-height:54px !important; font-size:34px !important; }
      }
    </style>

    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; font-family:${EMAIL_FONT};">
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
    <div
      class="status-icon"
      style="
        width:58px;
        height:58px;
        margin:0 auto 0;
        border-radius:999px;
        background:#0a0a0a;
        color:#ffffff;
        font-size:38px;
        line-height:58px;
        font-weight:900;
        font-family:${EMAIL_FONT};
        text-align:center;
      "
    >${escapeHtml(symbol)}</div>
  `;
}

function renderExactTitle(text, maxWidth = 300) {
  return `
    <div
      class="mail-title"
      style="
        font-size:19px;
        line-height:20px;
        font-weight:900;
        margin:0 auto 18px;
        max-width:${maxWidth}px;
        font-family:${EMAIL_FONT};
        color:#111111;
        white-space:pre-line;
        letter-spacing:-0.2px;
      "
    >
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

function panelOpen() {
  return `
    <div
      class="panel"
      style="
        background:#0a0a0a;
        border-radius:6px;
        padding:14px;
        margin:0 auto 22px;
        max-width:100%;
        text-align:left;
      "
    >
  `;
}
function panelClose() {
  return `</div>`;
}

/** row admin/user meta inside black panel */
function panelRow(label, valueHtml) {
  return `
    <div style="margin:0 0 10px; text-align:left;">
      <div style="
        font-family:${EMAIL_FONT};
        font-size:12px;
        line-height:14px;
        font-weight:900;
        color:#e4ff00;
        text-transform:uppercase;
        letter-spacing:0.2px;
        margin-bottom:4px;
      ">${escapeHtml(label)}</div>
      <div style="
        font-family:${EMAIL_FONT};
        font-size:14px;
        line-height:18px;
        font-weight:700;
        color:#ffffff;
        word-break:break-word;
      ">${valueHtml}</div>
    </div>
  `;
}

/** card style like appointments card but adapted */
function renderRowCard({ titleLeft, titleRight = "", subtitle = "" }) {
  return `
    <div
      class="row-card"
      style="
        border:1px solid #e4ff00;
        border-radius:8px;
        padding:10px 12px;
        margin:0 0 11px;
        text-align:left;
        background:#0b0b0b;
      "
    >
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr>
          <td
            class="row-k"
            style="
              font-family:${EMAIL_FONT};
              font-size:15px;
              line-height:17px;
              font-weight:900;
              color:#e4ff00;
              padding:0;
            "
          >
            ${escapeHtml(titleLeft)}
          </td>
          <td
            align="right"
            class="row-k"
            style="
              font-family:${EMAIL_FONT};
              font-size:15px;
              line-height:17px;
              font-weight:900;
              color:#e4ff00;
              padding:0;
              white-space:nowrap;
            "
          >
            ${escapeHtml(titleRight)}
          </td>
        </tr>
        ${
          subtitle
            ? `
          <tr>
            <td
              colspan="2"
              class="row-v"
              style="
                padding-top:4px;
                font-family:${EMAIL_FONT};
                font-size:14px;
                line-height:16px;
                font-weight:700;
                color:#ffffff;
              "
            >
              ${subtitle}
            </td>
          </tr>`
            : ""
        }
      </table>
    </div>
  `;
}

function renderItemsPanel(items = []) {
  const list = Array.isArray(items) ? items : [];

  const cards = list.length
    ? list
        .map((it, idx) => {
          const kind = String(it?.kind || "").toUpperCase();
          const qty = Math.max(1, Number(it?.qty) || 1);

          if (kind === "CREDITS") {
            const svc = String(it?.serviceKey || "EP").toUpperCase();
            const cr = Number(it?.credits) || 0;
            return renderRowCard({
              titleLeft: `Créditos · ${svc}`,
              titleRight: `x${String(qty)}`,
              subtitle: `<span style="color:#ffffff;">${escapeHtml(
                String(cr)
              )} crédito/s</span>`,
            });
          }

          if (kind === "MEMBERSHIP") {
            return renderRowCard({
              titleLeft: "Membresía · DUO+",
              titleRight: `${String(qty)} mes/es`,
              subtitle: `<span style="color:#ffffff;">Extensión / compra</span>`,
            });
          }

          const name = it?.label || it?.name || it?.title || "Item";
          return renderRowCard({
            titleLeft: escapeHtml(String(name)),
            titleRight: `x${String(qty)}`,
            subtitle: `<span style="color:#ffffff;">${escapeHtml(
              String(it?.kind || "ITEM")
            )}</span>`,
          });
        })
        .join("")
    : renderExactBodyText("Sin items para mostrar.", {
        fontSize: 14,
        lineHeight: 18,
        weight: 700,
        maxWidth: 320,
        marginBottom: 0,
      });

  return `${panelOpen()}${cards}${panelClose()}`;
}

function buildExactOrderHtml({
  title,
  icon = "✓",
  preheader,
  introHtml = "",
  metaRowsHtml = "",
  items = [],
  footerHintHtml = "",
}) {
  const innerHtml = `
    ${renderExactStatusIcon(icon)}
    ${renderExactTitle(title, 285)}
    ${introHtml ? renderExactBodyText(introHtml, { fontSize: 14, lineHeight: 19, weight: 700, maxWidth: 330, marginBottom: 16 }) : ""}
    ${metaRowsHtml ? `${panelOpen()}${metaRowsHtml}${panelClose()}` : ""}
    ${renderItemsPanel(items)}
    ${footerHintHtml ? renderExactBodyText(footerHintHtml, { fontSize: 12, lineHeight: 17, weight: 700, maxWidth: 330, marginBottom: 0 }) : ""}
  `;

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${title}`,
    preheader: preheader || title,
    bodyHtml: renderExactUserShell(innerHtml),
    footerNote: "",
  });
}

/* =========================================================
   Pedidos (ORDER) — ADMIN + USER
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
    `Estado: ${statusLabel(s.statusRaw)}`,
    `Total: ${s.totalFinal}`,
    "",
    "Items:",
    ...(s.items.length
      ? s.items.map((it, i) => `${i + 1}. ${itemLine(it)}`)
      : ["(sin items)"]),
  ].join("\n");

  const metaRows = [
    panelRow("Pedido", `<span style="color:#ffffff;">#${escapeHtml(s.orderId)}</span>`),
    panelRow("Usuario", `<span style="color:#ffffff;">${escapeHtml(s.uName)}</span>`),
    panelRow("Email", `<span style="color:#ffffff;">${escapeHtml(s.uEmail)}</span>`),
    panelRow("Pago", `<span style="color:#ffffff;">${escapeHtml(s.pm)}</span>`),
    panelRow("Estado", `<span style="color:#ffffff;">${escapeHtml(statusLabel(s.statusRaw))}</span>`),
    panelRow("Total", `<span style="color:#ffffff;">${escapeHtml(s.totalFinal)}</span>`),
    panelRow("Creado", `<span style="color:#ffffff;">${escapeHtml(`${s.createdDate} ${s.createdTime}`)}</span>`),
    panelRow("Items", `<span style="color:#ffffff;">${escapeHtml(String(s.itemsCount))}</span>`),
  ].join("");

  const html = buildExactOrderHtml({
    title: "Nuevo pedido",
    icon: "✓",
    preheader: `Nuevo pedido #${s.orderId} · ${s.uName} · ${s.totalFinal}`,
    introHtml: `Se generó un nuevo pedido.`,
    metaRowsHtml: metaRows,
    items: s.items,
    footerHintHtml: "",
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
    `Estado: ${statusLabel("paid")}`,
    `Total: ${s.totalFinal}`,
  ].join("\n");

  const metaRows = [
    panelRow("Pedido", `<span style="color:#ffffff;">#${escapeHtml(s.orderId)}</span>`),
    panelRow("Usuario", `<span style="color:#ffffff;">${escapeHtml(s.uName)}</span>`),
    panelRow("Email", `<span style="color:#ffffff;">${escapeHtml(s.uEmail)}</span>`),
    panelRow("Pago", `<span style="color:#ffffff;">${escapeHtml(s.pm)}</span>`),
    panelRow("Total", `<span style="color:#ffffff;">${escapeHtml(s.totalFinal)}</span>`),
  ].join("");

  const html = buildExactOrderHtml({
    title: "Pedido pagado",
    icon: "✓",
    preheader: `Pedido #${s.orderId} pagado · ${s.uName} · ${s.totalFinal}`,
    introHtml: `El pedido fue marcado como <b>pagado</b>.`,
    metaRowsHtml: metaRows,
    items: s.items,
    footerHintHtml: "",
  });

  await sendMail(to, subject, text, html);
}

export async function sendUserOrderCreatedEmail(order = {}, user = null) {
  if (!user?.email) return;

  const s = orderSummary(order, user);

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

  const metaRows = [
    panelRow("Pedido", `<span style="color:#ffffff;">#${escapeHtml(s.orderId)}</span>`),
    panelRow("Pago", `<span style="color:#ffffff;">${escapeHtml(s.pm)}</span>`),
    panelRow("Total", `<span style="color:#ffffff;">${escapeHtml(s.totalFinal)}</span>`),
    panelRow("Estado", `<span style="color:#ffffff;">Pendiente</span>`),
  ].join("");

  const html = buildExactOrderHtml({
    title: "Pedido recibido",
    icon: "✓",
    preheader: `Pedido #${s.orderId} recibido · ${s.totalFinal}`,
    introHtml: `Hola <b>${escapeHtml(user?.name || "")}</b>, recibimos tu pedido correctamente.`,
    metaRowsHtml: metaRows,
    items: s.items,
    footerHintHtml:
      "Cuando el staff confirme el pago (efectivo), tu compra se acreditará automáticamente.",
  });

  await sendMail(user.email, subject, text, html);
}

export async function sendUserOrderPaidEmail(order = {}, user = null) {
  if (!user?.email) return;

  const s = orderSummary(order, user);

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

  const metaRows = [
    panelRow("Pedido", `<span style="color:#ffffff;">#${escapeHtml(s.orderId)}</span>`),
    panelRow("Pago", `<span style="color:#ffffff;">${escapeHtml(s.pm)}</span>`),
    panelRow("Total", `<span style="color:#ffffff;">${escapeHtml(s.totalFinal)}</span>`),
    panelRow("Estado", `<span style="color:#ffffff;">Pagado</span>`),
  ].join("");

  const html = buildExactOrderHtml({
    title: "Pago aprobado",
    icon: "✓",
    preheader: `Pago aprobado · Pedido #${s.orderId} · ${s.totalFinal}`,
    introHtml: `Hola <b>${escapeHtml(user?.name || "")}</b>, tu pago fue aprobado y tu compra se acreditó.`,
    metaRowsHtml: metaRows,
    items: s.items,
    footerHintHtml: "Ya podés ver el impacto (créditos/membresía) en tu cuenta.",
  });

  await sendMail(user.email, subject, text, html);
}

/* =========================================================
   CASH creado (pendiente) — USER
========================================================= */

export async function sendUserOrderCashCreatedEmail(order = {}, user = null) {
  if (!user?.email) return;

  const s = orderSummary(order, user);

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

  const metaRows = [
    panelRow("Pedido", `<span style="color:#ffffff;">#${escapeHtml(s.orderId)}</span>`),
    panelRow("Pago", `<span style="color:#ffffff;">Efectivo</span>`),
    panelRow("Total", `<span style="color:#ffffff;">${escapeHtml(s.totalFinal)}</span>`),
    panelRow("Estado", `<span style="color:#ffffff;">Pendiente</span>`),
  ].join("");

  const html = buildExactOrderHtml({
    title: "Pedido generado (Efectivo)",
    icon: "✓",
    preheader: `Pedido #${s.orderId} generado · ${s.totalFinal}`,
    introHtml: `Hola <b>${escapeHtml(user?.name || "")}</b>, generamos tu pedido correctamente.`,
    metaRowsHtml: metaRows,
    items: s.items,
    footerHintHtml:
      "Coordiná el pago con el staff. Cuando se confirme, se acreditará automáticamente.",
  });

  await sendMail(user.email, subject, text, html);
}