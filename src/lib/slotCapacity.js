// backend/src/lib/slotCapacity.js

// ✅ Nombres de servicios (usá EXACTAMENTE estos strings en DB/Front)
export const EP_NAME = "Entrenamiento Personal";
export const RA_NAME = "Rehabilitacion Activa";
export const RF_NAME = "Reeducacion Funcional";

// ✅ Cupos por turno
export const TOTAL_CAPACITY = 6;
export const EP_BASE_CAP = 4;

// Regla:
// - Normalmente EP tiene cupo 4
// - Si hay 1 turno (RA o RF) reservado, EP puede llegar a 5 (porque total por hora = 6)
// - Si hay 2 (RA y RF) reservados, EP puede llegar a 4
// - A 2hs o menos del turno: si NO hay RA NI RF reservados, EP puede llegar a 6
export function computeEpCapNow({ slotDate, raReserved, rfReserved }) {
  const other = (raReserved ? 1 : 0) + (rfReserved ? 1 : 0);

  // total real que podría ocupar EP si se libera todo lo demás
  const maxByTotal = TOTAL_CAPACITY - other;

  // base EP (antes de la ventana)
  let cap = Math.min(EP_BASE_CAP, maxByTotal);

  // ventana de 2hs: si no hay RA/RF, EP sube a 6
  if (slotDate) {
    const ms = slotDate.getTime() - Date.now();
    const hoursToStart = ms / (1000 * 60 * 60);
    if (hoursToStart <= 2 && other === 0) {
      cap = TOTAL_CAPACITY; // 6
    }
  }

  // seguridad
  cap = Math.max(0, Math.min(cap, maxByTotal));
  return cap;
}

// existingAppointments: array de appointments reservados en esa fecha/hora
export function analyzeSlot(existingAppointments = [], slotDate = null) {
  const list = Array.isArray(existingAppointments) ? existingAppointments : [];

  const epReserved = list.filter((a) => a?.status === "reserved" && a?.service === EP_NAME).length;
  const raReserved = list.some((a) => a?.status === "reserved" && a?.service === RA_NAME);
  const rfReserved = list.some((a) => a?.status === "reserved" && a?.service === RF_NAME);

  const otherReservedCount = (raReserved ? 1 : 0) + (rfReserved ? 1 : 0);
  const totalReserved = list.filter((a) => a?.status === "reserved").length;

  const epCapNow = computeEpCapNow({ slotDate, raReserved, rfReserved });

  const totalHasRoom = totalReserved < TOTAL_CAPACITY;
  const epHasRoom = epReserved < epCapNow;

  return {
    totalCapacity: TOTAL_CAPACITY,
    epBaseCap: EP_BASE_CAP,
    epCapNow,
    epReserved,
    raReserved,
    rfReserved,
    otherReservedCount,
    totalReserved,
    slotFull: !totalHasRoom,
    epAvailableNow: totalHasRoom && epHasRoom,
  };
}
