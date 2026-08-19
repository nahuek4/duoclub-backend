// backend/src/mail/helpers.js

export const EMAIL_FONT =
  "'Helvetica Now Display', 'Helvetica Neue', Helvetica, Arial, sans-serif";

export function escapeHtml(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

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
