// backend/src/lib/credits.js

import { EP_NAME, RA_NAME, RF_NAME } from "./slotCapacity.js";

// Normaliza nombre para comparar (sin tildes, lower)
function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// Mapea nombre de servicio (UI/DB) a key de creditLots
export function serviceToKey(serviceName) {
  const n = norm(serviceName);

  if (n === norm(EP_NAME)) return "EP";
  if (n === norm(RA_NAME)) return "RA";
  if (n === norm(RF_NAME)) return "RF";

  // fallback: si guardás "EP", "RA", etc en algún lado
  if (["ep", "ra", "rf"].includes(n.toUpperCase())) return n.toUpperCase();

  return "ALL";
}

// Recalcula cache user.credits a partir de creditLots
export function recalcUserCredits(user) {
  if (!user) return 0;
  const now = new Date();

  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
  let total = 0;

  for (const lot of lots) {
    const rem = Number(lot?.remaining || 0);
    if (rem <= 0) continue;

    const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) continue;

    total += rem;
  }

  user.credits = total;
  return total;
}

// Elige el lote a consumir (prioridad: específico del servicio, luego ALL; menor vencimiento primero)
export function pickLotToConsume(user, serviceKey) {
  if (!user) return null;
  const sk = String(serviceKey || "ALL").toUpperCase().trim();
  const now = new Date();

  const lots = Array.isArray(user.creditLots) ? user.creditLots : [];
  const active = lots
    .filter((lot) => Number(lot?.remaining || 0) > 0)
    .filter((lot) => {
      const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
      return !exp || exp > now;
    });

  const rank = (lot) => {
    const exp = lot?.expiresAt ? new Date(lot.expiresAt).getTime() : Number.MAX_SAFE_INTEGER;
    return exp;
  };

  const specific = active
    .filter((lot) => String(lot?.serviceKey || "").toUpperCase().trim() === sk)
    .sort((a, b) => rank(a) - rank(b));

  if (specific.length) return specific[0];

  const all = active
    .filter((lot) => String(lot?.serviceKey || "").toUpperCase().trim() === "ALL")
    .sort((a, b) => rank(a) - rank(b));

  return all[0] || null;
}
