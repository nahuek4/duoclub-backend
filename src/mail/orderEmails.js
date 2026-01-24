// backend/src/mail/orderEmails.js
import { ADMIN_EMAIL, BRAND_NAME, sendMail } from "./core.js";
import { escapeHtml, kvRow, moneyARS, pill } from "./helpers.js";
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
   CASH creado (pendiente) — USER
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
