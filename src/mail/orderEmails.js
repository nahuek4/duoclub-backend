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

function paymentMethodLabel(raw = "") {
  const v = String(raw || "").trim().toUpperCase();
  if (!v || v === "-") return "-";
  if (v === "EFECTIVO") return "Efectivo";
  if (v === "MERCADOPAGO") return "Mercado Pago";
  if (v === "TRANSFERENCIA") return "Transferencia";
  if (v === "CHECKOUT_PRO") return "Checkout Pro";
  return v.charAt(0) + v.slice(1).toLowerCase();
}

function orderItemVisualData(it = {}) {
  const kind = String(it?.kind || "").toUpperCase();
  const qty = Math.max(1, Number(it?.qty) || 1);

  if (kind === "CREDITS") {
    const svc = String(it?.serviceKey || "EP").toUpperCase();
    const credits = Number(it?.credits) || 0;
    return {
      title: serviceLabel(svc),
      subtitle: `${credits} crédito${credits === 1 ? "" : "s"}/s`,
      qty,
    };
  }

  if (kind === "MEMBERSHIP") {
    return {
      title: "Membresía DUO+",
      subtitle: `${qty} mes/es`,
      qty,
    };
  }

  return {
    title: String(it?.label || it?.name || it?.title || "Item"),
    subtitle: qty > 1 ? `${qty} unidades` : "1 unidad",
    qty,
  };
}

function renderPaymentItemsList(items = []) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    return `
      <div style="
        font-family:Arial, Helvetica, sans-serif;
        font-size:13px;
        line-height:18px;
        color:#111111;
        text-align:center;
        padding:8px 0 0;
      ">Sin items para mostrar.</div>
    `;
  }

  return list
    .map((it) => {
      const item = orderItemVisualData(it);
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
            position:relative;
          "
        >
          <tr>
            <td style="padding:0 0 0 16px; position:relative;">
              <div
                style="
                  background:#f3f3f3;
                  border:1.5px solid #111111;
                  border-radius:8px;
                  overflow:hidden;
                  position:relative;
                "
              >
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                  <tr>
                    <td style="width:8px; background:#050505; font-size:0; line-height:0;">&nbsp;</td>
                    <td style="padding:10px 12px 10px 10px; font-family:Arial, Helvetica, sans-serif; color:#111111;">
                      <div style="font-size:12px; line-height:15px; font-weight:500;">${escapeHtml(item.title)}</div>
                      <div style="font-size:13px; line-height:16px; font-weight:900;">${escapeHtml(item.subtitle)}</div>
                    </td>
                  </tr>
                </table>
              </div>
              <div
                style="
                  position:relative;
                  width:0;
                  height:0;
                "
              >
                <div
                  style="
                    position:absolute;
                    right:-2px;
                    top:-46px;
                    width:18px;
                    height:18px;
                    border-radius:999px;
                    background:#dfff00;
                    border:1.5px solid #111111;
                    font-family:Arial, Helvetica, sans-serif;
                    font-size:10px;
                    line-height:16px;
                    font-weight:900;
                    text-align:center;
                    color:#111111;
                  "
                >x${escapeHtml(String(item.qty))}</div>
              </div>
            </td>
          </tr>
        </table>
      `;
    })
    .join("");
}

function renderPaymentSummaryBox(s, forcedStatus = null) {
  const status = forcedStatus || statusLabel(s.statusRaw);
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
        background:#f3f3f3;
        border-radius:12px;
        overflow:hidden;
        margin:0 0 14px;
      "
    >
      <tr>
        <td style="background:#050505; padding:6px 12px; font-family:Arial, Helvetica, sans-serif; font-size:9px; line-height:11px; font-weight:900; color:#ffffff; text-transform:uppercase;">
          NO DE ORDEN #${escapeHtml(String(s.publicId))}
        </td>
      </tr>
      <tr>
        <td style="padding:14px 14px 10px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%; font-family:Arial, Helvetica, sans-serif; color:#111111;">
            <tr>
              <td style="padding:0 0 10px; border-bottom:1px solid #d0d0d0; font-size:13px; line-height:16px; font-weight:900;">FORMA DE PAGO: ${escapeHtml(paymentMethodLabel(s.pm))}</td>
            </tr>
            <tr>
              <td style="padding:10px 0; border-bottom:1px solid #d0d0d0; font-size:13px; line-height:16px; font-weight:900;">TOTAL: ${escapeHtml(s.totalFinal)}</td>
            </tr>
            <tr>
              <td style="padding:10px 0 0; font-size:13px; line-height:16px; font-weight:900;">ESTADO: ${escapeHtml(status)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
}

function buildPaymentUserVisualEmail({
  title,
  preheader,
  heading,
  name,
  introHtml,
  order,
  user,
  ctaLabel = "",
  ctaHref = "",
  footerNote = "",
  helperLinkText = "",
  helperLinkHref = "",
  forcedStatus = null,
}) {
  const s = orderSummary(order, user);
  const linkHref = ctaHref || BRAND_URL || "#";

  return buildEmailLayout({
    title: `${BRAND_NAME} · ${title}`,
    preheader,
    footerNote: "",
    bodyHtml: `
      <style>
        @media only screen and (max-width: 560px) {
          .duo-pay-wrap { max-width: 100% !important; }
          .duo-pay-card { border-radius: 0 0 22px 22px !important; }
          .duo-pay-content { padding: 30px 26px 34px !important; }
          .duo-pay-logo { padding-bottom: 34px !important; }
          .duo-pay-heading { font-size: 22px !important; line-height: 26px !important; }
          .duo-pay-copy { font-size: 14px !important; line-height: 21px !important; }
          .duo-pay-btn-row { padding-top: 24px !important; }
          .duo-pay-footer-note, .duo-pay-help { font-size: 11px !important; line-height: 17px !important; }
          .duo-pay-footer { padding: 36px 32px 38px !important; border-radius: 0 0 22px 22px !important; }
          .duo-footer-brand { font-size: 22px !important; line-height: 22px !important; letter-spacing: 6px !important; }
          .duo-footer-info { font-size: 9px !important; line-height: 13px !important; }
        }
      </style>

      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        <tr>
          <td align="center" style="padding:0;">
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" class="duo-pay-wrap" style="max-width:430px; border-collapse:separate; border-spacing:0;">
              <tr>
                <td class="duo-pay-card" style="background:#f3f3f3; border-radius:0 0 28px 28px; overflow:hidden; font-family:Arial, Helvetica, sans-serif; color:#111111;">
                  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                    <tr>
                      <td class="duo-pay-content" style="background:#f3f3f3; padding:34px 28px 34px; font-family:Arial, Helvetica, sans-serif; color:#111111;">
                        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                          <tr>
                            <td class="duo-pay-logo" align="center" style="padding:0 0 36px;">
                              <div style="font-family:Arial, Helvetica, sans-serif; font-size:34px; line-height:34px; font-weight:900; color:#050505; letter-spacing:-3px;">ᗡ◖</div>
                            </td>
                          </tr>
                          <tr>
                            <td style="padding:0 0 14px;">
                              <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
                                <tr>
                                  <td valign="middle" style="width:24px; padding:0 10px 0 0;">
                                    <div style="width:19px; height:19px; border:2px solid #111111; border-radius:999px; font-size:11px; line-height:17px; text-align:center; font-weight:900; color:#111111;">$</div>
                                  </td>
                                  <td class="duo-pay-heading" valign="middle" style="font-family:Arial, Helvetica, sans-serif; font-size:24px; line-height:28px; font-weight:900; color:#111111; letter-spacing:-0.6px;">${escapeHtml(heading)}</td>
                                </tr>
                              </table>
                            </td>
                          </tr>
                          <tr>
                            <td style="padding:0 0 16px;"><div style="height:1px; background:#c9c9c9; width:100%;"></div></td>
                          </tr>
                          <tr>
                            <td class="duo-pay-copy" style="font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:20px; font-weight:400; color:#111111; text-align:left; padding:0 0 22px;">
                              Hola <b>${escapeHtml(name)}</b>,<br />
                              ${introHtml}
                            </td>
                          </tr>
                          <tr>
                            <td style="padding:0 0 10px;">${renderPaymentSummaryBox(s, forcedStatus)}</td>
                          </tr>
                          <tr>
                            <td style="padding:0 0 8px; border-top:2px dashed #9d9d9d;"></td>
                          </tr>
                          <tr>
                            <td style="padding:2px 0 8px;">${renderPaymentItemsList(s.items)}</td>
                          </tr>
                          <tr>
                            <td style="padding:0 0 12px; border-bottom:2px dashed #9d9d9d;"></td>
                          </tr>
                          <tr>
                            <td style="padding:0 0 0;">
                              <div style="width:100%; height:18px; background:#050505; border-radius:0 0 10px 10px;"></div>
                            </td>
                          </tr>
                          ${ctaLabel && linkHref ? `
                          <tr>
                            <td class="duo-pay-btn-row" align="center" style="padding:30px 0 0;">
                              <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse; margin:0 auto;">
                                <tr>
                                  <td align="center" style="background:#dfff00; border-radius:999px; box-shadow:0 10px 14px rgba(0,0,0,0.18);">
                                    <a href="${escapeHtml(linkHref)}" style="display:inline-block; padding:13px 21px; font-family:Arial, Helvetica, sans-serif; font-size:15px; line-height:16px; font-weight:800; color:#111111; text-decoration:none;">${escapeHtml(ctaLabel)}</a>
                                  </td>
                                </tr>
                              </table>
                            </td>
                          </tr>` : ''}
                          ${footerNote ? `
                          <tr>
                            <td class="duo-pay-footer-note" style="font-family:Arial, Helvetica, sans-serif; font-size:11px; line-height:16px; font-weight:600; color:#111111; text-align:center; padding:18px 0 0;">
                              ${footerNote}
                            </td>
                          </tr>` : ''}
                          ${helperLinkText && helperLinkHref ? `
                          <tr>
                            <td class="duo-pay-help" style="font-family:Arial, Helvetica, sans-serif; font-size:11px; line-height:16px; font-weight:600; color:#111111; text-align:center; padding:16px 0 0;">
                              ¿Necesitás ayuda para coordinar el pago?<br />
                              <a href="${escapeHtml(helperLinkHref)}" style="color:#2b59ff; text-decoration:underline;">${helperLinkText}</a>
                            </td>
                          </tr>` : ''}
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td class="duo-pay-footer" style="background:#050505; padding:40px 48px 42px; border-radius:0 0 28px 28px; font-family:Arial, Helvetica, sans-serif;">
                        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse; width:100%;">
                          <tr>
                            <td valign="middle" style="width:42%; color:#ffffff; font-family:Arial, Helvetica, sans-serif;">
                              <div class="duo-footer-brand" style="font-size:23px; line-height:23px; font-weight:900; letter-spacing:7px;">DUO</div>
                              <div style="font-size:4px; line-height:7px; font-weight:700; letter-spacing:1.8px; margin-top:4px; opacity:0.95;">HEALTH CLUB</div>
                            </td>
                            <td valign="middle" align="right" class="duo-footer-info" style="width:58%; color:#ffffff; font-family:Arial, Helvetica, sans-serif; font-size:9px; line-height:13px; font-weight:500; letter-spacing:0.2px;">
                              <div style="font-weight:900; letter-spacing:2.8px;">DUOCLUB.AR</div>
                              <div>+54 249 420 7343</div>
                              <div>Av. Santamaría 54, Tandil.</div>
                              <div style="padding-top:6px; font-size:10px; line-height:10px; letter-spacing:4px;">◎ f in</div>
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
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
    "Generamos tu pedido correctamente.",
    "Para finalizar la compra, coordiná el pago con el staff.",
    "Una vez confirmado, los créditos se acreditarán automáticamente en tu cuenta.",
    "",
    `Pedido: #${s.publicId}`,
    `Forma de pago: ${paymentMethodLabel(s.pm)}`,
    `Estado: ${statusLabel(s.statusRaw)}`,
    `Total: ${s.totalFinal}`,
    "",
    "Detalle:",
    ...(s.items.length ? s.items.map((it) => `- ${itemLine(it)}`) : ["- Sin items"]),
    "",
    `Link: ${paymentUrl}`,
  ].join("\n");

  const html = buildPaymentUserVisualEmail({
    title: "Pedido generado",
    preheader: "Tu pedido fue generado correctamente",
    heading: "Pedido generado",
    name: s.uName,
    introHtml: `Generamos tu pedido correctamente.<br /><b>Para finalizar la compra, coordiná el pago con el staff.</b><br />Una vez confirmado, los créditos se acreditarán automáticamente en tu cuenta.`,
    order,
    user,
    ctaLabel: "Coordinar pago",
    ctaHref: paymentUrl,
    helperLinkText: "Podés comunicarte con nuestro equipo desde este enlace",
    helperLinkHref: paymentUrl,
    forcedStatus: "Pendiente",
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
    "Tu pago fue aprobado y tu compra se acreditó correctamente.",
    "",
    `Pedido: #${s.publicId}`,
    `Forma de pago: ${paymentMethodLabel(s.pm)}`,
    `Estado: ${statusLabel("paid")}`,
    `Total: ${s.totalFinal}`,
    "",
    "Detalle:",
    ...(s.items.length ? s.items.map((it) => `- ${itemLine(it)}`) : ["- Sin items"]),
    "",
    `Acceso: ${accessUrl}`,
  ].join("\n");

  const html = buildPaymentUserVisualEmail({
    title: "Pago aprobado",
    preheader: "Tu pago fue aprobado",
    heading: "Pago aprobado",
    name: s.uName,
    introHtml: `Tu pago fue aprobado y tu compra<br />se acreditó correctamente.`,
    order: { ...order, status: "paid" },
    user,
    ctaLabel: `Ingresar a ${BRAND_NAME}`,
    ctaHref: accessUrl,
    footerNote: "Ya podés ver el impacto (créditos/membresía) en tu cuenta.",
    forcedStatus: "Pagado",
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
    `Forma de pago: ${paymentMethodLabel(s.pm)}`,
    `Estado: ${statusLabel(s.statusRaw)}`,
    `Total: ${s.totalFinal}`,
    "",
    "Detalle:",
    ...(s.items.length ? s.items.map((it) => `- ${itemLine(it)}`) : ["- Sin items"]),
  ].join("\n");

  const html = buildPaymentUserVisualEmail({
    title: "Nuevo pedido",
    preheader: `Nuevo pedido de ${s.uName}`,
    heading: "Pedido generado",
    name: s.uName,
    introHtml: `Se generó un nuevo pedido correctamente.<br /><b>Revisá el detalle completo a continuación.</b>`,
    order,
    user,
    footerNote: "Mail automático de DUO para administración.",
    forcedStatus: statusLabel(s.statusRaw),
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
    `Forma de pago: ${paymentMethodLabel(s.pm)}`,
    `Estado: ${statusLabel("paid")}`,
    `Total: ${s.totalFinal}`,
    "",
    "Detalle:",
    ...(s.items.length ? s.items.map((it) => `- ${itemLine(it)}`) : ["- Sin items"]),
  ].join("\n");

  const html = buildPaymentUserVisualEmail({
    title: "Pago aprobado",
    preheader: `Pago aprobado de ${s.uName}`,
    heading: "Pago aprobado",
    name: s.uName,
    introHtml: `El pago del pedido fue aprobado correctamente.<br /><b>La compra ya quedó acreditada.</b>`,
    order: { ...order, status: "paid" },
    user,
    footerNote: "Mail automático de DUO para administración.",
    forcedStatus: "Pagado",
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
    `Forma de pago: ${paymentMethodLabel(s.pm)}`,
    `Estado: ${statusLabel("cancelled")}`,
    `Total: ${s.totalFinal}`,
    "",
    "Detalle:",
    ...(s.items.length ? s.items.map((it) => `- ${itemLine(it)}`) : ["- Sin items"]),
  ].join("\n");

  const html = buildPaymentUserVisualEmail({
    title: "Pedido cancelado",
    preheader: `Pedido cancelado de ${s.uName}`,
    heading: "Pedido cancelado",
    name: s.uName,
    introHtml: `El pedido fue cancelado.<br /><b>Revisá el detalle completo a continuación.</b>`,
    order: { ...order, status: "cancelled" },
    user,
    footerNote: "Mail automático de DUO para administración.",
    forcedStatus: "Cancelado",
  });

  await sendMail(ADMIN_EMAIL, subject, text, html);
}