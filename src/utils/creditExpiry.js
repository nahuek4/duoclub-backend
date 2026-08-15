const TZ = "America/Argentina/Buenos_Aires";

function pad2(value) {
  return String(value).padStart(2, "0");
}

function clean(value) {
  return String(value || "").trim();
}

export function argentinaDateParts(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("INVALID_DATE");
  }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
  };
}

export function monthKeyFromArgentinaDate(value = new Date()) {
  const parts = argentinaDateParts(value);
  return `${parts.year}-${pad2(parts.month)}`;
}

export function assertMonthKey(value) {
  const monthKey = clean(value);
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new Error("INVALID_MONTH_KEY");

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!year || month < 1 || month > 12) throw new Error("INVALID_MONTH_KEY");

  return { monthKey, year, month };
}

export function nextMonthKey(value) {
  const { year, month } = assertMonthKey(value);
  if (month === 12) return `${year + 1}-01`;
  return `${year}-${pad2(month + 1)}`;
}

/**
 * Vencimiento DUO: 00:00 del día 1 del mes siguiente,
 * en horario de Argentina.
 *
 * Ejemplo:
 *   período 2026-08 -> 2026-09-01 00:00:00 -03:00
 */
export function creditExpiryForMonthKey(value) {
  const next = nextMonthKey(value);
  return new Date(`${next}-01T00:00:00.000-03:00`);
}

export function creditExpiryForDate(value = new Date()) {
  return creditExpiryForMonthKey(monthKeyFromArgentinaDate(value));
}

export function isCreditLotExpired(lot, now = new Date()) {
  if (!lot?.expiresAt) return false;
  const expiresAt = new Date(lot.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return false;
  return expiresAt <= now;
}
