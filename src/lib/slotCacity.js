// backend/src/lib/slotCapacity.js

export const TOTAL_CAP = 6;

export const EP_NAME = "Entrenamiento Personal";
export const RA_NAME = "Rehabilitacion Activa";
export const RF_NAME = "Reeducacion Funcional";

/**
 * Reglas pedidas:
 * - EP tiene cupo base 4.
 * - A las 2hs exactas antes del turno:
 *    - si NO hay RF y NO hay RA => EP puede subir hasta 6
 *    - si hay RF => EP puede subir hasta 5
 *    - si solo hay RA => EP queda en 4
 * - Siempre limitado por cupo total 6 (restando RF/RA).
 */
export function calcEpCap({ hoursToStart, hasRF, hasRA, otherCount }) {
  let cap = 4;

  if (hoursToStart <= 2) {
    if (!hasRF && !hasRA) cap = 6;
    else if (hasRF) cap = 5;
    else cap = 4;
  }

  // nunca exceder el cupo total disponible luego de reservar RF/RA
  const totalLimit = Math.max(0, TOTAL_CAP - Number(otherCount || 0));
  cap = Math.min(cap, totalLimit);

  return Math.max(0, cap);
}

/**
 * Devuelve métricas del slot (para UI / waitlist / validaciones).
 */
export function analyzeSlot(existingReserved, slotDate) {
  const list = Array.isArray(existingReserved) ? existingReserved : [];

  const epCount = list.filter((a) => String(a?.service || "") === EP_NAME).length;
  const rfCount = list.filter((a) => String(a?.service || "") === RF_NAME).length;
  const raCount = list.filter((a) => String(a?.service || "") === RA_NAME).length;

  const hasRF = rfCount > 0;
  const hasRA = raCount > 0;

  const otherCount = rfCount + raCount;
  const totalCount = list.length;

  const hoursToStart = slotDate
    ? (slotDate.getTime() - Date.now()) / (1000 * 60 * 60)
    : 999;

  const epCap = calcEpCap({ hoursToStart, hasRF, hasRA, otherCount });

  const totalHasRoom = totalCount < TOTAL_CAP;
  const epHasRoom = epCount < epCap;

  return {
    totalCount,
    otherCount,
    epCount,
    rfCount,
    raCount,
    hasRF,
    hasRA,
    hoursToStart,
    epCap,
    totalHasRoom,
    epHasRoom,
    epAvailableNow: totalHasRoom && epHasRoom,
  };
}
