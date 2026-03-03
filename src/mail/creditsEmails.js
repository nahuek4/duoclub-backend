import { ADMIN_EMAIL, BRAND_NAME, sendMail } from "./core.js";
import { escapeHtml, kvRow } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";

/* =========================================================
   HELPERS
========================================================= */

function cleanStr(v, fallback = "-") {
  const s = String(v ?? "").trim();
  return s ? s : fallback;
}

function fullNameOf(user = {}) {
  const full =
    `${cleanStr(user?.name, "")} ${cleanStr(user?.lastName, "")}`.trim() ||
    cleanStr(user?.fullName, "") ||
    cleanStr(user?.email, "") ||
    "Usuario";

  return full;
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

function itemsHtmlRows(items = []) {
  if (!items.length) {
    return kvRow("Cambios", "-");
  }

  return items
    .map((it) =>
      kvRow(
        `${it.serviceKey} · ${serviceLabel(it.serviceKey)}`,
        formatChange(it)
      )
    )
    .join("");
}

/* =========================================================
   USER MAIL
========================================================= */

export async function sendUserCreditsAssignedEmail({
  user = null,
  items = [],
  actorName = "",
} = {}) {
  const to = cleanStr(user?.email, "").trim();
  if (!to) return;

  const fullName = fullNameOf(user);
  const safeItems = normalizeItems(items);
  if (!safeItems.length) return;

  const subject = `🎟️ Actualizamos tus sesiones - ${BRAND_NAME}`;

  const text = [
    `Hola ${fullName},`,
    "",
    "Te informamos que se actualizaron tus sesiones/créditos.",
    "",
    ...itemsTextLines(safeItems),
    "",
    actorName ? `Gestionado por: ${actorName}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const bodyHtml = `
    <div style="font-size:18px; font-weight:800; margin-bottom:10px;">
      Sesiones actualizadas
    </div>

    <div style="color:#333; margin-bottom:12px;">
      Hola <b>${escapeHtml(fullName)}</b>, se actualizaron tus sesiones/créditos.
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${itemsHtmlRows(safeItems)}
      </table>
    </div>

    ${
      actorName
        ? `
      <div style="margin-top:14px; font-size:12px; color:#666;">
        Gestionado por: <b>${escapeHtml(actorName)}</b>
      </div>
    `
        : ""
    }
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Sesiones actualizadas`,
    preheader: `Actualizamos tus sesiones`,
    bodyHtml,
  });

  await sendMail(to, subject, text, html);
}

/* =========================================================
   ADMIN MAIL
========================================================= */

export async function sendAdminCreditsAssignedEmail({
  user = null,
  items = [],
  actorName = "",
} = {}) {
  const to = cleanStr(ADMIN_EMAIL, "").trim();
  if (!to) return;

  const fullName = fullNameOf(user);
  const userEmail = cleanStr(user?.email);
  const userPhone = cleanStr(user?.phone);
  const safeItems = normalizeItems(items);
  if (!safeItems.length) return;

  const subject = `🧾 Créditos actualizados — ${fullName}`;

  const text = [
    "Se actualizaron sesiones/créditos de un usuario.",
    "",
    `Usuario: ${fullName}`,
    `Email: ${userEmail}`,
    `Teléfono: ${userPhone}`,
    "",
    ...itemsTextLines(safeItems),
    "",
    actorName ? `Gestionado por: ${actorName}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const bodyHtml = `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">
      <div style="font-size:18px; font-weight:800;">Créditos actualizados</div>
      <div style="margin-left:auto; background:#e9f7ef; color:#0b6b2a; padding:6px 10px; border-radius:999px; font-size:12px; font-weight:800;">
        ADMIN
      </div>
    </div>

    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${kvRow("Usuario", fullName)}
        ${kvRow("Email", userEmail)}
        ${kvRow("Teléfono", userPhone)}
        ${actorName ? kvRow("Gestionado por", actorName) : ""}
      </table>
    </div>

    <div style="margin-top:14px; font-size:13px; font-weight:900;">Cambios aplicados</div>
    <div style="border:1px solid #eee; border-radius:14px; overflow:hidden; margin-top:8px;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;">
        ${itemsHtmlRows(safeItems)}
      </table>
    </div>
  `;

  const html = buildEmailLayout({
    title: `${BRAND_NAME} · Créditos actualizados`,
    preheader: `Se actualizaron créditos de ${fullName}`,
    bodyHtml,
  });

  await sendMail(to, subject, text, html);
}