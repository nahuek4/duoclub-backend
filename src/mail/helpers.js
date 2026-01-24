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

export function moneyARS(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? "-");
  try {
    return n.toLocaleString("es-AR", { style: "currency", currency: "ARS" });
  } catch {
    return `$${n}`;
  }
}

export function kvRow(label, value) {
  return `
    <tr>
      <td style="padding:8px 10px; color:#555; font-size:13px; width:170px; border-bottom:1px solid #eee;">
        ${escapeHtml(label)}
      </td>
      <td style="padding:8px 10px; color:#111; font-size:13px; border-bottom:1px solid #eee;">
        ${escapeHtml(value)}
      </td>
    </tr>
  `;
}

export function pill(status) {
  const s = String(status || "").toLowerCase();
  if (s === "approved" || s === "paid") {
    return { bg: "#e9f7ef", tx: "#0b6b2a", label: "PAGADO" };
  }
  if (s === "pending") {
    return { bg: "#fff6db", tx: "#7a5200", label: "PENDIENTE" };
  }
  if (s === "cancelled" || s === "rejected" || s === "failed") {
    return { bg: "#ffe9ea", tx: "#a00010", label: "RECHAZADO" };
  }
  return { bg: "#eef1f5", tx: "#334155", label: String(status || "ESTADO") };
}
