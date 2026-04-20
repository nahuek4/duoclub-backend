import crypto from "crypto";

import Appointment from "../models/Appointment.js";
import WaitlistEntry from "../models/WaitlistEntry.js";

const TOTAL_CAP = 6;
const EP_CAP_WHEN_THERAPY_ACTIVE = 4;
const THERAPY_CAP_WHEN_ACTIVE = 2;

const EP_KEY = "EP";
const RA_KEY = "RA";
const RF_KEY = "RF";

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación activa",
  RF: "Reeducación funcional",
  NUT: "Nutrición",
};

const ALLOWED_SERVICE_KEYS = new Set(Object.keys(SERVICE_KEY_TO_NAME));

const TIMES_REHAB_MWF = [
  "07:00", "08:00", "09:00", "10:00",
  "11:00", "12:00", "13:30", "14:00", "15:00",
];

const TIMES_REHAB_TT = [
  "07:00", "08:00", "09:00", "10:00",
  "11:00", "12:00",
  "16:00", "17:00", "18:00",
];

const WAITLIST_CLAIM_WINDOW_MINUTES = Number(
  process.env.WAITLIST_CLAIM_WINDOW_MINUTES || 60
);

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function normSvcName(s) {
  return stripAccents(s).toLowerCase().trim();
}

function normalizeServiceKey(value) {
  const up = String(value || "").toUpperCase().trim();
  return ALLOWED_SERVICE_KEYS.has(up) ? up : "";
}

function serviceToKey(serviceNameOrKey) {
  const explicit = normalizeServiceKey(serviceNameOrKey);
  if (explicit) return explicit;

  const s = normSvcName(serviceNameOrKey);

  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("nutricion")) return "NUT";

  return "";
}

function serviceKeyToName(serviceKey) {
  return SERVICE_KEY_TO_NAME[normalizeServiceKey(serviceKey)] || "";
}

function resolveServiceIdentity({ service = "", serviceKey = "" } = {}) {
  const key = normalizeServiceKey(serviceKey) || serviceToKey(service);
  if (!key) return null;

  return {
    serviceKey: key,
    serviceName: serviceKeyToName(key),
  };
}

function appointmentServiceKey(ap) {
  return serviceToKey(ap?.serviceKey || ap?.service || ap?.serviceName || "");
}

function waitlistEntryServiceKey(entry) {
  return serviceToKey(entry?.serviceKey || entry?.service || entry?.serviceName || "");
}

function sameService(a, b) {
  const ak = serviceToKey(a);
  const bk = serviceToKey(b);

  if (ak && bk) return ak === bk;
  return normSvcName(a) === normSvcName(b);
}

function isTherapyService(serviceNameOrKey) {
  const sk = serviceToKey(serviceNameOrKey);
  return sk === RA_KEY || sk === RF_KEY;
}

function getWeekdayMondayFirst(dateStr) {
  const [y, m, d] = String(dateStr).split("-").map(Number);
  const js = new Date(y, (m || 1) - 1, d || 1).getDay();
  return js === 0 ? 7 : js;
}

function getRehabTimesForDate(dateStr) {
  const weekday = getWeekdayMondayFirst(dateStr);
  if ([1, 3, 5].includes(weekday)) return TIMES_REHAB_MWF;
  if ([2, 4].includes(weekday)) return TIMES_REHAB_TT;
  return [];
}

function isTherapyAreaActiveAt(dateStr, time) {
  const t = String(time || "").slice(0, 5);
  return getRehabTimesForDate(dateStr).includes(t);
}

function getTherapyCapForSlot(dateStr, time) {
  return isTherapyAreaActiveAt(dateStr, time) ? THERAPY_CAP_WHEN_ACTIVE : 0;
}

function getEpCapForSlot(dateStr, time) {
  return getTherapyCapForSlot(dateStr, time) > 0
    ? EP_CAP_WHEN_THERAPY_ACTIVE
    : TOTAL_CAP;
}

function getSlotReservationStats(existing, dateStr, time) {
  const list = Array.isArray(existing) ? existing : [];
  const epReserved = list.filter((a) => appointmentServiceKey(a) === EP_KEY).length;
  const therapyReserved = list.filter((a) => isTherapyService(appointmentServiceKey(a))).length;

  return {
    totalReserved: list.length,
    epReserved,
    therapyReserved,
    therapyCap: getTherapyCapForSlot(dateStr, time),
    epCap: getEpCapForSlot(dateStr, time),
  };
}

function buildClaimUrl(token) {
  const frontend = String(process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  if (!frontend) return "";
  return `${frontend}/waitlist/claim?token=${encodeURIComponent(token)}`;
}

function buildWaitlistServiceMatcher(serviceKey) {
  const key = normalizeServiceKey(serviceKey);
  const name = serviceKeyToName(key);

  if (!key) return null;

  return {
    $or: [
      { serviceKey: key },
      { service: name },
    ],
  };
}

export async function notifyWaitlistForSlot({ date, time, service = "", serviceKey = EP_KEY } = {}) {
  try {
    const identity = resolveServiceIdentity({ service, serviceKey }) || resolveServiceIdentity({ serviceKey: EP_KEY });
    const requestedSk = identity?.serviceKey || "";
    const requestedServiceName = identity?.serviceName || serviceKeyToName(EP_KEY);

    if (requestedSk !== EP_KEY) {
      return { ok: true, skipped: true, reason: "SERVICE_HAS_NO_WAITLIST", serviceKey: requestedSk || null };
    }

    const t = String(time || "").slice(0, 5);

    const existingReservations = await Appointment.find({
      date,
      time: t,
      status: "reserved",
    })
      .select("service serviceKey serviceName")
      .lean();

    const stats = getSlotReservationStats(existingReservations, date, t);
    if (stats.totalReserved >= TOTAL_CAP || stats.epReserved >= stats.epCap) {
      return { ok: true, skipped: true, reason: "SLOT_STILL_FULL", serviceKey: EP_KEY };
    }

    const waitlistServiceMatch = buildWaitlistServiceMatcher(EP_KEY);

    const alreadyNotified = await WaitlistEntry.findOne({
      date,
      time: t,
      status: "notified",
      tokenExpiresAt: { $gt: new Date() },
      ...waitlistServiceMatch,
    }).lean();

    if (alreadyNotified) {
      return { ok: true, skipped: true, reason: "ALREADY_NOTIFIED", serviceKey: EP_KEY };
    }

    const nextEntry = await WaitlistEntry.findOne({
      date,
      time: t,
      status: "waiting",
      ...waitlistServiceMatch,
    })
      .populate("user", "name lastName email")
      .sort({ createdAt: 1 });

    if (!nextEntry) {
      return { ok: true, skipped: true, reason: "NO_WAITLIST", serviceKey: EP_KEY };
    }

    const nextEntrySk = waitlistEntryServiceKey(nextEntry);
    if (nextEntrySk && nextEntrySk !== EP_KEY) {
      return { ok: true, skipped: true, reason: "WAITLIST_SERVICE_MISMATCH", serviceKey: nextEntrySk };
    }

    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(Date.now() + WAITLIST_CLAIM_WINDOW_MINUTES * 60 * 1000);

    nextEntry.serviceKey = EP_KEY;
    if (!String(nextEntry.service || "").trim()) {
      nextEntry.service = requestedServiceName;
    }
    nextEntry.notifyToken = token;
    nextEntry.notifiedAt = new Date();
    nextEntry.tokenExpiresAt = expiresAt;
    nextEntry.status = "notified";
    await nextEntry.save();

    const claimUrl = buildClaimUrl(token);

    // Reemplazá este bloque por tu helper real de email si ya lo tenés en el proyecto.
    console.log("[WAITLIST][NOTIFY]", {
      to: nextEntry?.user?.email || "",
      userId: nextEntry?.user?._id?.toString?.() || String(nextEntry?.user || ""),
      userName: [nextEntry?.user?.name, nextEntry?.user?.lastName].filter(Boolean).join(" "),
      date,
      time: t,
      serviceKey: EP_KEY,
      service: requestedServiceName,
      claimUrl,
      expiresAt,
    });

    return {
      ok: true,
      notified: true,
      waitlistEntryId: String(nextEntry._id),
      token,
      expiresAt,
      claimUrl,
      serviceKey: EP_KEY,
      service: requestedServiceName,
    };
  } catch (err) {
    console.error("Error en notifyWaitlistForSlot:", err);
    return { ok: false, error: err?.message || "WAITLIST_NOTIFY_ERROR" };
  }
}

export default notifyWaitlistForSlot;
