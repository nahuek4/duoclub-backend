import "dotenv/config";

const DEFAULT_SITE = "https://www.damianvillaverde.com";
const DEFAULT_API = "https://api.damianvillaverde.com";

function configuredUrl(value, fallback) {
  return String(value || "").trim().replace(/\/+$/, "") || fallback;
}

export const SITE_URL = configuredUrl(process.env.BRAND_URL, DEFAULT_SITE);
export const BACKEND_URL = configuredUrl(process.env.BACKEND_URL, DEFAULT_API);
export const MAIL_IMAGE_BASE = `${BACKEND_URL}/images`;

export function agendaBase(value = process.env.FRONTEND_URL) {
  const base = configuredUrl(value, SITE_URL);
  return `${base.replace(/\/(?:agenda|prueba)$/i, "")}/prueba`;
}
