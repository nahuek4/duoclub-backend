// backend/src/mail/recipients.js
// Routing central de mails operativos por área.
//
// DUO TRAINING
//   EP -> training.by.duo@gmail.com
//
// DUO PERFORMANCE
//   RA / RF / SYN -> performance.by.duo@gmail.com
//
// Los mails generales que no pueden asociarse a un servicio siguen usando
// ADMIN_EMAIL como fallback. Los mails ligados a un servicio NO copian al
// ADMIN_EMAIL general salvo que una llamada lo pida explícitamente con
// { includeMainAdmin: true }.

import { ADMIN_EMAIL } from "./core.js";

export const TRAINING_ZONE_EMAIL = String(
  process.env.TRAINING_ZONE_EMAIL || "training.by.duo@gmail.com"
).trim();

export const PERFORMANCE_ZONE_EMAIL = String(
  process.env.PERFORMANCE_ZONE_EMAIL || "performance.by.duo@gmail.com"
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
    .replace(/[\u0300-\u036f]/g, "");
}

export function normalizeServiceKey(value = "") {
  const raw = stripAccents(value).trim().toUpperCase();

  if (!raw) return "";

  if (raw === "EP") return "EP";
  if (raw === "RA" || raw === "AR") return "RA";
  if (raw === "RF") return "RF";
  if (raw === "SYN" || raw === "SYNERGY" || raw === "SINERGIA") return "SYN";

  // Compatibilidad histórica. No habilita operatoria nueva.
  if (raw === "KD" || raw === "KINEDEPO" || raw === "KINE-DEPO") return "KD";
  if (raw === "NUT") return "NUT";
  if (raw === "PE") return "PE";

  if (raw.includes("ENTRENAMIENTO PERSONAL")) return "EP";
  if (raw.includes("REHABILITACION ACTIVA")) return "RA";
  if (raw.includes("REEDUCACION FUNCIONAL")) return "RF";

  if (
    raw.includes("REHAB & PERFORMANCE") ||
    raw.includes("REHAB AND PERFORMANCE")
  ) {
    return "RF";
  }

  if (raw.includes("SYNERGY") || raw.includes("SINERGIA")) return "SYN";

  // Compatibilidad histórica.
  if (
    raw.includes("KINEFILAXIA") ||
    raw.includes("KINEDEPO") ||
    raw.includes("KINE-DEPO")
  ) {
    return "KD";
  }

  if (raw.includes("NUTRICION")) return "NUT";
  if (raw.includes("PRIMERA EVALUACION")) return "PE";

  return raw;
}

/**
 * Devuelve el mail del área operativa correspondiente al servicio.
 *
 * EP             -> TRAINING
 * RA / RF / SYN  -> PERFORMANCE
 * KD legacy      -> PERFORMANCE, solo para registros históricos que todavía
 *                   puedan disparar alguna notificación antigua.
 */
export function zoneEmailForService(serviceKey = "") {
  const key = normalizeServiceKey(serviceKey);

  if (key === "EP") {
    return TRAINING_ZONE_EMAIL;
  }

  if (["RA", "RF", "SYN", "KD"].includes(key)) {
    return PERFORMANCE_ZONE_EMAIL;
  }

  return "";
}

/**
 * Destinatarios administrativos de UN servicio.
 *
 * Por defecto, si hay área reconocida, SOLO recibe esa área.
 * ADMIN_EMAIL se usa como fallback si no se reconoce el servicio.
 *
 * Se puede pedir una copia extra al admin general con:
 *   { includeMainAdmin: true }
 */
export function adminRecipientsForService(serviceKey = "", opts = {}) {
  const zoneEmail = zoneEmailForService(serviceKey);
  const includeMainAdmin = opts?.includeMainAdmin === true;

  if (zoneEmail) {
    return uniqueEmails([
      zoneEmail,
      includeMainAdmin ? ADMIN_EMAIL : "",
    ]);
  }

  return uniqueEmails([ADMIN_EMAIL]);
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

/**
 * Turnos:
 * - EP -> Training
 * - RA/RF/SYN -> Performance
 */
export function adminRecipientsForAppointment(
  ap = {},
  fallback = "",
  opts = {}
) {
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

  return [...new Set([...keys, ...fallbackKeys])];
}

/**
 * Órdenes:
 * - solo EP -> Training
 * - solo RA/RF/SYN -> Performance
 * - una orden excepcional con servicios de ambas áreas -> ambas casillas
 * - sin servicio identificable -> ADMIN_EMAIL fallback
 */
export function adminRecipientsForOrder(order = {}, opts = {}) {
  const includeMainAdmin = opts?.includeMainAdmin === true;
  const serviceKeys = serviceKeysFromOrder(order);
  const zoneEmails = serviceKeys.map(zoneEmailForService).filter(Boolean);

  if (zoneEmails.length) {
    return uniqueEmails([
      ...zoneEmails,
      includeMainAdmin ? ADMIN_EMAIL : "",
    ]);
  }

  return uniqueEmails([ADMIN_EMAIL]);
}

/**
 * Cambios manuales de sesiones/créditos:
 * mismo routing que las órdenes.
 */
export function adminRecipientsForServiceItems(items = [], opts = {}) {
  const includeMainAdmin = opts?.includeMainAdmin === true;

  const serviceKeys = (Array.isArray(items) ? items : [])
    .map((it = {}) =>
      normalizeServiceKey(
        it?.serviceKey ||
          it?.service ||
          it?.serviceName ||
          it?.label ||
          it?.name ||
          it?.title
      )
    )
    .filter(Boolean);

  const zoneEmails = serviceKeys.map(zoneEmailForService).filter(Boolean);

  if (zoneEmails.length) {
    return uniqueEmails([
      ...zoneEmails,
      includeMainAdmin ? ADMIN_EMAIL : "",
    ]);
  }

  return uniqueEmails([ADMIN_EMAIL]);
}
