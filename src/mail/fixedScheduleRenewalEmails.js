import { BRAND_NAME, BRAND_URL, sendMail } from "./core.js";
import { escapeHtml } from "./helpers.js";
import { buildEmailLayout } from "./layout.js";

export async function sendFixedScheduleRenewalEmail({ user, serviceName, periodKey, appointments }) {
  const email = String(user?.email || "").trim();
  if (!email || /@[^@]*\.invalid$/i.test(email)) {
    return { skipped: true, reason: "MISSING_OR_TEST_EMAIL" };
  }
  const period = new Intl.DateTimeFormat("es-AR", {
    month: "long", year: "numeric", timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date(`${periodKey}-01T12:00:00-03:00`));
  const name = String(user?.name || "").trim() || "Hola";
  const rows = appointments.map(ap => {
    const [y, m, d] = ap.date.split("-");
    return `${d}/${m}/${y} · ${ap.time} hs`;
  });
  const url = `${String(BRAND_URL).replace(/\/+$/, "")}/agenda`;
  const subject = `${BRAND_NAME} · Se renovaron tus turnos fijos`;
  const text = `Hola ${name},\n\nSe renovaron tus turnos fijos de ${serviceName} para ${period}.\n\n${rows.join("\n")}\n\nPodés consultar tus turnos en ${url}.\nSi necesitás hacer un cambio, comunicate con DUO.`;
  const html = buildEmailLayout({
    title: subject,
    preheader: `Tus turnos de ${serviceName} para ${period} ya están disponibles.`,
    bodyHtml: `<div style="text-align:left;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#111">
      <p style="font-size:14px;letter-spacing:2px">${escapeHtml(BRAND_NAME)}</p>
      <h1 style="font-size:30px;line-height:1.15">Se renovaron tus<br>turnos fijos</h1>
      <p>Hola ${escapeHtml(name)},</p>
      <p>Tus turnos fijos de <strong>${escapeHtml(serviceName)}</strong> para <strong>${escapeHtml(period)}</strong> ya están disponibles.</p>
      <div style="background:#f1f1ee;border-radius:12px;padding:16px;line-height:1.8">${rows.map(row => escapeHtml(row)).join("<br>")}</div>
      <p><a href="${escapeHtml(url)}" style="display:inline-block;background:#111;color:#fff;padding:14px 22px;border-radius:24px;text-decoration:none">Ver mis turnos</a></p>
      <p>Si necesitás hacer un cambio, comunicate con DUO.</p>
    </div>`,
    footerNote: "Este correo confirma la renovación de tus horarios fijos.",
  });
  await sendMail(email, subject, text, html);
  return { sent: true };
}
