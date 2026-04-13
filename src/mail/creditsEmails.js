// backend/src/mail/creditsEmails.js
import { ADMIN_EMAIL, BRAND_NAME, sendMail } from "./core.js";
import { escapeHtml } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";
import {
  buildExactMail,
  renderExactBodyText,
  renderAdminMetaPanel,
  renderAdminDetailPanel,
  renderRowCard,
} from "./ui.js";

/* =========================================================
   HELPERS
========================================================= */

function cleanStr(v, fallback = "-") {
  const s = String(v ?? "").trim();
  return s ? s : fallback;
}

function fullNameOf(user = {}) {
  return (
    `${cleanStr(user?.name, "")} ${cleanStr(user?.lastName, "")}`.trim() ||
    cleanStr(user?.fullName, "") ||
    cleanStr(user?.email, "") ||
    "Usuario"
  );
}

function normalizeItems(items = []) {
  const list = Array.isArray(items) ? items : [];

  return list
    .map((it) => {
      const serviceKey = String(it?.serviceKey || "")
        .trim()
        .toUpperCase();

      const hasDelta = it?.delta !== undefined && it?.delta !== null;
      const raw = hasDelta ? Number(it.delta) : Number(it.credits);

      if (!serviceKey || !Number.isFinite(raw) || raw === 0) return null;

      return {
        serviceKey,
        mode: hasDelta ? "delta" : "set",
        value: Math.trunc(raw),
      };
    })
    .filter(Boolean);
}

function serviceLabel(key) {
  const k = String(key || "").toUpperCase();
  if (k === "EP") return "Entrenamiento Personal";
  if (k === "RF") return "Reeducación Funcional";
  if (k === "RA") return "Rehabilitación Activa";
  if (k === "NUT") return "Nutrición";
  return k || "-";
}

function formatChange(it) {
  if (!it) return "-";

  if (it.mode === "delta") {
    const n = Number(it.value || 0);
    const sign = n > 0 ? "+" : "";
    return `${sign}${n}`;
  }

  return `Fijado en ${Number(it.value || 0)}`;
}

function itemsTextLines(items = []) {
  if (!items.length) return ["-"];
  return items.map(
    (it) => `• ${it.serviceKey} (${serviceLabel(it.serviceKey)}): ${formatChange(it)}`
  );
}

function renderCreditsChangesPanel(items = []) {
  const list = Array.isArray(items) ? items : [];

  const rows = list.length
    ? list
        .map((it) => {
          const left = `${it.serviceKey} · ${serviceLabel(it.serviceKey)}`;
          const right = formatChange(it);

          return renderRowCard({
            titleLeft: left,
            titleRight: right,
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
        Sin cambios para mostrar.
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
      ${rows}
    </div>
  `;
}

function buildCreditsEmail({
  title,
  preheader,
  icon = "✓",
  innerHtml,
}) {
  const exact = buildExactMail({
    brandName: BRAND_NAME,
    title,
    preheader,
    icon,
    innerHtml,
  });

  return buildEmailLayout({
    title: exact.title,
    preheader: exact.preheader,
    bodyHtml: exact.bodyHtml,
    footerNote: "",
  });
}

/* =========================================================
   USER — CAMBIO DE CRÉDITOS
========================================================= */

export async function sendCreditsChangedEmail(user = {}, items = [], meta = {}) {
  const to = user?.email;
  if (!to) return;

  const normalized = normalizeItems(items);
  if (!normalized.length) return;

  const uName = fullNameOf(user);
  const reason = cleanStr(meta?.reason, "");
  const actorName = cleanStr(meta?.actorName, "");
  const actorLabel = actorName || "Staff DUO";

  const subject = `Actualización de créditos - ${BRAND_NAME}`;

  const text = [
    `Hola ${uName},`,
    "",
    "Se actualizó tu saldo de créditos.",
    "",
    "Cambios:",
    ...itemsTextLines(normalized),
    "",
    reason ? `Motivo: ${reason}` : "",
    `Gestionado por: ${actorLabel}`,
  ]
    .filter(Boolean)
    .join("\n");

  const detailRows = [
    { label: "Gestionado por", value: actorLabel },
    ...(reason ? [{ label: "Motivo", value: reason }] : []),
  ];

  const html = buildCreditsEmail({
    title: "Créditos actualizados",
    preheader: "Tu saldo de créditos fue actualizado",
    icon: "✓",
    innerHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(uName)}</b>,<br/>Se actualizó tu saldo de créditos.`,
        {
          fontSize: 14,
          lineHeight: 19,
          weight: 700,
          maxWidth: 320,
          marginBottom: 14,
        }
      )}

      ${renderCreditsChangesPanel(normalized)}

      ${renderAdminDetailPanel(detailRows)}

      ${renderExactBodyText(
        "Ingresá a DUO para revisar el detalle actualizado en tu cuenta.",
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

  await sendMail(to, subject, text, html);
}

/* =========================================================
   ADMIN — CAMBIO DE CRÉDITOS
========================================================= */

export async function sendAdminCreditsChangedEmail(
  user = {},
  items = [],
  meta = {}
) {
  const to = ADMIN_EMAIL;
  if (!to) return;

  const normalized = normalizeItems(items);
  if (!normalized.length) return;

  const uName = fullNameOf(user);
  const uEmail = cleanStr(user?.email);
  const reason = cleanStr(meta?.reason, "");
  const actorName = cleanStr(meta?.actorName, "");
  const actorLabel = actorName || "Staff DUO";

  const subject = `Créditos actualizados — ${uName}`;

  const text = [
    "Se actualizó el saldo de créditos de un usuario.",
    "",
    `Usuario: ${uName}`,
    `Email: ${uEmail}`,
    "",
    "Cambios:",
    ...itemsTextLines(normalized),
    "",
    reason ? `Motivo: ${reason}` : "",
    `Gestionado por: ${actorLabel}`,
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildCreditsEmail({
    title: "Créditos actualizados",
    preheader: `Actualización de créditos de ${uName}`,
    icon: "✓",
    innerHtml: `
      ${renderAdminMetaPanel([
        { label: "Usuario", value: uName },
        { label: "Email", value: uEmail },
      ])}

      ${renderCreditsChangesPanel(normalized)}

      ${renderAdminDetailPanel([
        { label: "Gestionado por", value: actorLabel },
        ...(reason ? [{ label: "Motivo", value: reason }] : []),
      ])}
    `,
  });

  await sendMail(to, subject, text, html);
}

/* =========================================================
   USER — CONSUMO DE CRÉDITO
========================================================= */

export async function sendCreditConsumedEmail(user = {}, payload = {}) {
  const to = user?.email;
  if (!to) return;

  const uName = fullNameOf(user);
  const serviceKey = cleanStr(payload?.serviceKey, "").toUpperCase();
  const service = serviceLabel(serviceKey);
  const remaining = Number(payload?.remaining);
  const hasRemaining = Number.isFinite(remaining);

  const subject = `Se consumió un crédito - ${BRAND_NAME}`;

  const text = [
    `Hola ${uName},`,
    "",
    "Se consumió un crédito de tu cuenta.",
    "",
    `Servicio: ${service}`,
    hasRemaining ? `Créditos restantes: ${remaining}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const html = buildCreditsEmail({
    title: "Crédito consumido",
    preheader: "Se consumió un crédito de tu cuenta",
    icon: "✓",
    innerHtml: `
      ${renderExactBodyText(
        `Hola <b>${escapeHtml(uName)}</b>,<br/>Se consumió un crédito de tu cuenta.`,
        {
          fontSize: 14,
          lineHeight: 19,
          weight: 700,
          maxWidth: 320,
          marginBottom: 14,
        }
      )}

      ${renderCreditsChangesPanel([
        {
          serviceKey,
          mode: "delta",
          value: -1,
        },
      ])}

      ${renderAdminDetailPanel([
        { label: "Servicio", value: service },
        ...(hasRemaining
          ? [{ label: "Créditos restantes", value: String(remaining) }]
          : []),
      ])}
    `,
  });

  await sendMail(to, subject, text, html);
}