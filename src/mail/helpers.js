// backend/src/mail/helpers.js

export const EMAIL_FONT =
  "'Helvetica Now Display', 'Helvetica Neue', Helvetica, Arial, sans-serif";

/* =========================================================
   Base
========================================================= */

export function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function cleanStr(v, fallback = "-") {
  const s = String(v ?? "").trim();
  return s ? s : fallback;
}

/* =========================================================
   Fecha / hora
========================================================= */

export function prettyDateAR(dateStr) {
  try {
    if (!dateStr) return "-";

    const [y, m, d] = String(dateStr).split("-").map(Number);
    const dt = new Date(y, (m || 1) - 1, d || 1);

    return dt.toLocaleDateString("es-AR", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "2-digit",
    });
  } catch {
    return String(dateStr || "-");
  }
}

export function formatARDateTime(dateLike) {
  try {
    const d = dateLike ? new Date(dateLike) : null;
    if (!d || Number.isNaN(d.getTime())) {
      return { date: "-", time: "-" };
    }

    const date = d.toLocaleDateString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

    const time = d.toLocaleTimeString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      hour: "2-digit",
      minute: "2-digit",
    });

    return { date, time };
  } catch {
    return { date: "-", time: "-" };
  }
}

/* =========================================================
   Dinero
========================================================= */

export function moneyARS(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "-");

  try {
    return n.toLocaleString("es-AR", {
      style: "currency",
      currency: "ARS",
    });
  } catch {
    return `$${n}`;
  }
}

/* =========================================================
   Legacy rows (compatibilidad)
   Ojo: estos helpers quedan para mails viejos o fallback.
   El look principal nuevo vive en ui.js
========================================================= */

export function kvRow(label, value, opts = {}) {
  const isLast = !!opts?.isLast;
  const border = isLast ? "none" : "1px solid #eeeeee";

  return `
    <tr>
      <td style="
        padding:11px 12px;
        color:#6b7280;
        font-size:13px;
        line-height:18px;
        font-weight:700;
        width:165px;
        vertical-align:top;
        border-bottom:${border};
        font-family:${EMAIL_FONT};
      ">
        ${escapeHtml(label)}
      </td>
      <td style="
        padding:11px 12px;
        color:#111111;
        font-size:13px;
        line-height:18px;
        font-weight:700;
        vertical-align:top;
        border-bottom:${border};
        font-family:${EMAIL_FONT};
      ">
        ${escapeHtml(value)}
      </td>
    </tr>
  `;
}

export function kvRowRaw(label, htmlValue, opts = {}) {
  const isLast = !!opts?.isLast;
  const border = isLast ? "none" : "1px solid #eeeeee";

  return `
    <tr>
      <td style="
        padding:11px 12px;
        color:#6b7280;
        font-size:13px;
        line-height:18px;
        font-weight:700;
        width:165px;
        vertical-align:top;
        border-bottom:${border};
        font-family:${EMAIL_FONT};
      ">
        ${escapeHtml(label)}
      </td>
      <td style="
        padding:11px 12px;
        color:#111111;
        font-size:13px;
        line-height:18px;
        font-weight:700;
        vertical-align:top;
        border-bottom:${border};
        font-family:${EMAIL_FONT};
      ">
        ${String(htmlValue ?? "")}
      </td>
    </tr>
  `;
}

/* =========================================================
   Pills / estados
========================================================= */

export function pill(status) {
  const s = String(status || "").toLowerCase();

  if (s === "approved" || s === "paid" || s === "confirmed") {
    return { bg: "#e9f7ef", tx: "#0b6b2a", label: "CONFIRMADO" };
  }

  if (s === "pending") {
    return { bg: "#fff6db", tx: "#7a5200", label: "PENDIENTE" };
  }

  if (s === "cancelled" || s === "rejected" || s === "failed") {
    return { bg: "#ffe9ea", tx: "#a00010", label: "CANCELADO" };
  }

  return {
    bg: "#eef1f5",
    tx: "#334155",
    label: String(status || "ESTADO").toUpperCase(),
  };
}

/* =========================================================
   Utils chicos reutilizables
========================================================= */

export function boolLabel(v) {
  if (v === true) return "SI";
  if (v === false) return "NO";
  return cleanStr(v);
}

export function safeUpper(v, fallback = "-") {
  const s = cleanStr(v, fallback);
  return s === "-" ? s : s.toUpperCase();
}