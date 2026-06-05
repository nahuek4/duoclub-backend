// backend/src/mail/recipients.js
import { ADMIN_EMAIL } from "./core.js";

export const TRAINING_ZONE_EMAIL = String(
  process.env.TRAINING_ZONE_EMAIL || "duoclub.ar@gmail.com"
).trim();

export const PERFORMANCE_ZONE_EMAIL = String(
  process.env.PERFORMANCE_ZONE_EMAIL || "villaverdefit@gmail.com"
).trim();

function uniqueEmails(list = []) {
  return [
    ...new Set(
      (Array.isArray(list) ? list : [list])
        .flat(Infinity)
        .map((x) => String(x || "").trim())
        .filter(Boolean)
    ),
  ];
}

function stripAccents(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function normalizeServiceKey(value = "") {
  const raw = stripAccents(value).trim().toUpperCase();

  if (!raw) return "";

  if (raw === "EP") return "EP";
  if (raw === "RA" || raw === "AR") return "RA";
  if (raw === "RF") return "RF";
  if (raw === "KD" || raw === "KINEDEPO" || raw === "KINE-DEPO") return "KD";
  if (raw === "NUT") return "NUT";
  if (raw === "PE") return "PE";

  if (raw.includes("ENTRENAMIENTO PERSONAL")) return "EP";
  if (raw.includes("REHABILITACION ACTIVA")) return "RA";
  if (raw.includes("REEDUCACION FUNCIONAL")) return "RF";
  if (raw.includes("REHAB & PERFORMANCE") || raw.includes("REHAB AND PERFORMANCE")) return "RF";
  if (raw.includes("KINEFILAXIA") || raw.includes("KINEDEPO") || raw.includes("KINE-DEPO")) return "KD";
  if (raw.includes("NUTRICION")) return "NUT";
  if (raw.includes("PRIMERA EVALUACION")) return "PE";

  return raw;
}

export function zoneEmailForService(serviceKey = "") {
  const key = normalizeServiceKey(serviceKey);

  if (key === "EP") return TRAINING_ZONE_EMAIL;

  if (["RA", "RF", "KD"].includes(key)) {
    return PERFORMANCE_ZONE_EMAIL;
  }

  return "";
}

export function adminRecipientsForService(serviceKey = "", opts = {}) {
  const includeMainAdmin = opts?.includeMainAdmin !== false;

  return uniqueEmails([
    includeMainAdmin ? ADMIN_EMAIL : "",
    zoneEmailForService(serviceKey),
  ]);
}

export function serviceKeyFromAppointment(ap = {}, fallback = "") {
  return normalizeServiceKey(
    ap?.serviceKey ||
      ap?.service ||
      ap?.serviceName ||
      ap?.type ||
      fallback
  );
}

export function adminRecipientsForAppointment(ap = {}, fallback = "", opts = {}) {
  const key = serviceKeyFromAppointment(ap, fallback);
  return adminRecipientsForService(key, opts);
}

function serviceKeysFromOrder(order = {}) {
  const items = Array.isArray(order?.items) ? order.items : [];

  const keys = items
    .flatMap((it = {}) => [
      it?.serviceKey,
      it?.service,
      it?.serviceName,
      it?.label,
      it?.name,
      it?.title,
    ])
    .map(normalizeServiceKey)
    .filter(Boolean);

  const fallbackKeys = [
    order?.serviceKey,
    order?.service,
    order?.serviceName,
    order?.label,
    order?.name,
    order?.title,
  ]
    .map(normalizeServiceKey)
    .filter(Boolean);

  return uniqueEmails([...keys, ...fallbackKeys]);
}

export function adminRecipientsForOrder(order = {}, opts = {}) {
  const includeMainAdmin = opts?.includeMainAdmin !== false;
  const serviceKeys = serviceKeysFromOrder(order);
  const zoneEmails = serviceKeys.map(zoneEmailForService).filter(Boolean);

  return uniqueEmails([
    includeMainAdmin ? ADMIN_EMAIL : "",
    ...zoneEmails,
  ]);
}

export function adminRecipientsForServiceItems(items = [], opts = {}) {
  const includeMainAdmin = opts?.includeMainAdmin !== false;
  const serviceKeys = (Array.isArray(items) ? items : [])
    .map((it = {}) => normalizeServiceKey(it?.serviceKey || it?.service || it?.serviceName || it?.label || it?.name || it?.title))
    .filter(Boolean);

  const zoneEmails = serviceKeys.map(zoneEmailForService).filter(Boolean);

  return uniqueEmails([
    includeMainAdmin ? ADMIN_EMAIL : "",
    ...zoneEmails,
  ]);
}
