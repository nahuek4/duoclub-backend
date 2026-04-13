// backend/src/mail/orderEmails.js
import { ADMIN_EMAIL, BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { escapeHtml, moneyARS } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";
import {
  buildExactMail,
  renderExactBodyText,
  renderPrimaryButton,
  renderAdminMetaPanel,
  renderAdminDetailPanel,
  renderRowCard,
} from "./ui.js";

/* =========================================================
   Helpers ORDER
========================================================= */

function orderSummary(order = {}, user = null) {
  const orderId = order?._id?.toString?.() || order?.id || "-";
  const publicId = order?.publicId || order?.code || order?.number || orderId;

  const createdAt = order?.createdAt ? new Date(order.createdAt) : null;

  const createdDate = createdAt
    ? createdAt.toLocaleDateString("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
    : "-";

  const createdTime = createdAt
    ? createdAt.toLocaleTimeString("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "-";

  const uName =
    `${user?.name || ""} ${user?.lastName || ""}`.trim() ||
    user?.fullName ||
    user?.email ||
    "-";

  const uEmail = user?.email || order?.email || "-";

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
    publicId,
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

function serviceLabel(key) {
  const k = String(key || "").toUpperCase();
  if (k === "EP") return "Entrenamiento Personal";
  if (k === "RF") return "Reeducación Funcional";
  if (k === "RA") return "Rehabilitación Activa";
  if (k === "NUT") return "Nutrición";
  return k || "-";
}

function renderItemsPanel(items = []) {
  const list = Array.isArray(items) ? items : [];

  const cards = list.length
    ? list
        .map((it) => {
          const kind = String(it?.kind || "").toUpperCase();
          const qty = Math.max(1, Number(it?.qty) || 1);

          if (kind === "CREDITS") {
            const svc = String(it?.serviceKey || "EP").toUpperCase();
            const cr = Number(it?.credits) || 0;

            return renderRowCard({
              titleLeft: `Créditos · ${svc}`,
              titleRight: `x${String(qty)}`,
              subtitle: `<span style="color:#ffffff;">${escapeHtml(
                `${cr} crédito/s · ${serviceLabel(svc)}`
              )}</span>`,
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
            titleLeft: String(name),
            titleRight: `x${String(qty)}`,
            subtitle: "",
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
        Sin items para mostrar.
      </div>
    `;

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
      ${cards}
    </div>
  `;
}

function buildOrderUserEmail({
  title,
  preheader,
  icon = "✓",
  introHtml = "",
  order,
  user,
  ctaLabel = "",
  ctaHref = "",
  afterHtml = "",
}) {
  const s = orderSummary(order, user);

  const exact = buildExactMail({
    brandName: BRAND_NAME,
    title,
    preheader,
    icon,
    innerHtml: `
      ${introHtml}

      ${renderItemsPanel(s.items)}

      ${renderAdminDetailPanel([
        { label: "Pedido", value: `#${s.publicId}` },
        { label: "Estado", value: statusLabel(s.statusRaw) },
        { label: "Total", value: s.totalFinal },
      ])}

      ${ctaLabel && ctaHref ? renderPrimaryButton(ctaLabel, ctaHref) : ""}

      ${afterHtml}
    `,
  });

  return buildEmailLayout({
    title: exact.title,
    preheader: exact.preheader,
    bodyHtml: exact.bodyHtml,
    footerNote: "",
  });
}

function buildOrderAdminEmail({
  title,
  preheader,
  icon = "✓",
  order,
  user,
  extraRows = [],
}) {
  const s = orderSummary(order, user);

  const exact = buildExactMail({
    brandName: BRAND_NAME,
    title,
    preheader,
    icon,
    innerHtml: `
      ${renderAdminMetaPanel([
        { label: "Usuario", value: s.uName },
        { label: "Email", value: s.uEmail },
      ])}

      ${renderAdminDetailPanel([
        { label: "Pedido", value: `#${s.publicId}` },
        { label: "Creado", value: `${s.createdDate} ${s.createdTime}` },
        { label: "Estado", value: statusLabel(s.statusRaw) },
        { label: "Pago", value: s.pm },
        { label: "Total", value: s.totalFinal },
        ...extraRows,
      ])}

      ${renderItemsPanel(s.items)}
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

export async function sendOrderPendingEmail(order = {}, user = null, opts = {}) {
  const s = orderSummary(order, user);
  if (!s.uEmail || s.uEmail === "-") return;

  const paymentUrl =
    opts?.paymentUrl ||
    order?.paymentUrl ||
    order?.checkoutUrl ||
    BRAND_URL;

  const subject = `🛒 Pedido generado - ${BRAND_NAME}`;

  const text = [
    `Hola ${s.uName},`,
    "",
    "Tu pedido fue generado correctamente.",
    "Ahora falta coordinar o completar el pago para acreditarlo.",
    "",
    `Pedido: #${s.publicId}`,
    `Estado: ${statusLabel(s.statusRaw)}`,
    `Total: ${s.totalFinal}`,
    "",
    "Detalle:",
    ...(s.items.length ? s.items.map((it) => `- ${itemLine(it)}`) : ["- Sin items"]),
    "",
    `Link: ${paymentUrl}`,
  ].join("\n");

  const html = buildOrderUserEmail({
    title: "Pedido generado\ncon éxito.",
    preheader: "Tu pedido fue generado correctamente",
    icon: "✓",
    order,
    user,
    introHtml: renderExactBodyText(
      `Hola <b>${escapeHtml(s.uName)}</b>,<br/>Tu pedido fue generado correctamente.<br/>Ahora falta coordinar o completar el pago para acreditarlo.`,
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 14,
      }
    ),
    ctaLabel: "Coordinar pago",
    ctaHref: paymentUrl,
    afterHtml: renderExactBodyText(
      "Ingresá a DUO para revisar el detalle o avanzar con el pago.",
      {
        fontSize: 12,
        lineHeight: 17,
        weight: 600,
        maxWidth: 320,
        marginTop: 8,
        marginBottom: 0,
      }
    ),
  });

  await sendMail(s.uEmail, subject, text, html);
}

export async function sendOrderPaidEmail(order = {}, user = null) {
  const s = orderSummary(order, user);
  if (!s.uEmail || s.uEmail === "-") return;

  const accessUrl = BRAND_URL;

  const subject = `💳 Pago aprobado - ${BRAND_NAME}`;

  const text = [
    `Hola ${s.uName},`,
    "",
    "Tu pago fue aprobado correctamente.",
    "Tu compra ya impacta en tu cuenta.",
    "",
    `Pedido: #${s.publicId}`,
    `Estado: ${statusLabel("paid")}`,
    `Total: ${s.totalFinal}`,
    "",
    "Detalle:",
    ...(s.items.length ? s.items.map((it) => `- ${itemLine(it)}`) : ["- Sin items"]),
    "",
    `Acceso: ${accessUrl}`,
  ].join("\n");

  const html = buildOrderUserEmail({
    title: "Pago aprobado\ncon éxito.",
    preheader: "Tu pago fue aprobado",
    icon: "✓",
    order: { ...order, status: "paid" },
    user,
    introHtml: renderExactBodyText(
      `Hola <b>${escapeHtml(s.uName)}</b>,<br/>Tu pago fue aprobado correctamente.<br/>Tu compra ya impacta en tu cuenta.`,
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 14,
      }
    ),
    ctaLabel: `Ingresar a ${BRAND_NAME}`,
    ctaHref: accessUrl,
    afterHtml: renderExactBodyText(
      "Ingresá a DUO para revisar el detalle.",
      {
        fontSize: 12,
        lineHeight: 17,
        weight: 600,
        maxWidth: 320,
        marginTop: 8,
        marginBottom: 0,
      }
    ),
  });

  await sendMail(s.uEmail, subject, text, html);
}

export async function sendOrderCancelledEmail(order = {}, user = null) {
  const s = orderSummary(order, user);
  if (!s.uEmail || s.uEmail === "-") return;

  const subject = `❌ Pedido cancelado - ${BRAND_NAME}`;

  const text = [
    `Hola ${s.uName},`,
    "",
    "Tu pedido fue cancelado.",
    "",
    `Pedido: #${s.publicId}`,
    `Estado: ${statusLabel("cancelled")}`,
    `Total: ${s.totalFinal}`,
    "",
    "Si necesitás ayuda, ingresá a DUO o respondé este email.",
  ].join("\n");

  const html = buildOrderUserEmail({
    title: "Pedido cancelado",
    preheader: "Tu pedido fue cancelado",
    icon: "✕",
    order: { ...order, status: "cancelled" },
    user,
    introHtml: renderExactBodyText(
      `Hola <b>${escapeHtml(s.uName)}</b>,<br/>Tu pedido fue cancelado.`,
      {
        fontSize: 14,
        lineHeight: 19,
        weight: 700,
        maxWidth: 320,
        marginBottom: 14,
      }
    ),
    ctaLabel: `Ingresar a ${BRAND_NAME}`,
    ctaHref: BRAND_URL,
    afterHtml: renderExactBodyText(
      "Ingresá a DUO para revisar el detalle.",
      {
        fontSize: 12,
        lineHeight: 17,
        weight: 600,
        maxWidth: 320,
        marginTop: 8,
        marginBottom: 0,
      }
    ),
  });

  await sendMail(s.uEmail, subject, text, html);
}

/* =========================================================
   ADMIN emails
========================================================= */

export async function sendAdminOrderPendingEmail(order = {}, user = null) {
  if (!ADMIN_EMAIL) return;

  const s = orderSummary(order, user);

  const subject = `🛒 Nuevo pedido — ${s.uName} · #${s.publicId}`;

  const text = [
    "Nuevo pedido generado",
    "",
    `Usuario: ${s.uName}`,
    `Email: ${s.uEmail}`,
    `Pedido: #${s.publicId}`,
    `Creado: ${s.createdDate} ${s.createdTime}`,
    `Estado: ${statusLabel(s.statusRaw)}`,
    `Pago: ${s.pm}`,
    `Total: ${s.totalFinal}`,
    "",
    "Detalle:",
    ...(s.items.length ? s.items.map((it) => `- ${itemLine(it)}`) : ["- Sin items"]),
  ].join("\n");

  const html = buildOrderAdminEmail({
    title: "Nuevo pedido",
    preheader: `Nuevo pedido de ${s.uName}`,
    icon: "✓",
    order,
    user,
  });

  await sendMail(ADMIN_EMAIL, subject, text, html);
}

export async function sendAdminOrderPaidEmail(order = {}, user = null) {
  if (!ADMIN_EMAIL) return;

  const s = orderSummary(order, user);

  const subject = `💳 Pago aprobado — ${s.uName} · #${s.publicId}`;

  const text = [
    "Pago aprobado",
    "",
    `Usuario: ${s.uName}`,
    `Email: ${s.uEmail}`,
    `Pedido: #${s.publicId}`,
    `Creado: ${s.createdDate} ${s.createdTime}`,
    `Estado: ${statusLabel("paid")}`,
    `Pago: ${s.pm}`,
    `Total: ${s.totalFinal}`,
    "",
    "Detalle:",
    ...(s.items.length ? s.items.map((it) => `- ${itemLine(it)}`) : ["- Sin items"]),
  ].join("\n");

  const html = buildOrderAdminEmail({
    title: "Pago aprobado",
    preheader: `Pago aprobado de ${s.uName}`,
    icon: "✓",
    order: { ...order, status: "paid" },
    user,
  });

  await sendMail(ADMIN_EMAIL, subject, text, html);
}

export async function sendAdminOrderCancelledEmail(order = {}, user = null) {
  if (!ADMIN_EMAIL) return;

  const s = orderSummary(order, user);

  const subject = `🧾 Pedido cancelado — ${s.uName} · #${s.publicId}`;

  const text = [
    "Pedido cancelado",
    "",
    `Usuario: ${s.uName}`,
    `Email: ${s.uEmail}`,
    `Pedido: #${s.publicId}`,
    `Creado: ${s.createdDate} ${s.createdTime}`,
    `Estado: ${statusLabel("cancelled")}`,
    `Pago: ${s.pm}`,
    `Total: ${s.totalFinal}`,
  ].join("\n");

  const html = buildOrderAdminEmail({
    title: "Pedido cancelado",
    preheader: `Pedido cancelado de ${s.uName}`,
    icon: "✕",
    order: { ...order, status: "cancelled" },
    user,
  });

  await sendMail(ADMIN_EMAIL, subject, text, html);
}