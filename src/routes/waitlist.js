import crypto from "crypto";

import Appointment from "../models/Appointment.js";
import WaitlistEntry from "../models/WaitlistEntry.js";
import CapacityRule from "../models/CapacityRule.js";

const DEFAULT_ZONE_CAPS = Object.freeze({
  TRAINING: 11,
  PERFORMANCE: 6,
});

const CAPACITY_SCOPE_PRIORITY = Object.freeze({
  default: 0,
  month: 1,
  date: 2,
  slot: 3,
});

const EP_KEY = "EP";
const PERFORMANCE_KEYS = new Set(["RA", "RF", "SYN"]);
const OPERATIONAL_WAITLIST_KEYS = new Set(["EP", "RA", "RF", "SYN"]);

const SERVICE_KEY_TO_NAME = {
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  KD: "Kinefilaxia Deportiva",
  SYN: "Synergy",
  NUT: "Nutrición",
};

const ALLOWED_SERVICE_KEYS = new Set(Object.keys(SERVICE_KEY_TO_NAME));

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
  if (up === "AR") return "RA";
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
  if (s.includes("kinefilaxia") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("synergy") || s.includes("sinergia")) return "SYN";
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

function capacityZoneForService(serviceNameOrKey) {
  const sk = serviceToKey(serviceNameOrKey);
  if (sk === "EP") return "TRAINING";
  if (PERFORMANCE_KEYS.has(sk)) return "PERFORMANCE";
  return "";
}

function capacityRuleMatchesSlot(rule, dateStr, time) {
  if (!rule || rule.active === false) return false;

  const scope = String(rule.scope || "default").toLowerCase().trim();
  const day = String(dateStr || "").slice(0, 10);
  const monthKey = day.slice(0, 7);
  const t = String(time || "").slice(0, 5);

  if (scope === "default") return true;
  if (scope === "month") return String(rule.monthKey || "") === monthKey;
  if (scope === "date") return String(rule.date || "").slice(0, 10) === day;
  if (scope === "slot") {
    return (
      String(rule.date || "").slice(0, 10) === day &&
      String(rule.time || "").slice(0, 5) === t
    );
  }

  return false;
}

function pickCapacityRule(rules = [], predicate, dateStr, time) {
  return (Array.isArray(rules) ? rules : [])
    .filter((rule) => capacityRuleMatchesSlot(rule, dateStr, time))
    .filter((rule) => predicate(rule))
    .sort((a, b) => {
      const ap = CAPACITY_SCOPE_PRIORITY[String(a?.scope || "default")] ?? -1;
      const bp = CAPACITY_SCOPE_PRIORITY[String(b?.scope || "default")] ?? -1;
      if (ap !== bp) return bp - ap;

      const au = a?.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bu = b?.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bu - au;
    })[0] || null;
}

function resolveZoneCapacityFromRules(rules, zone, dateStr, time) {
  const normalizedZone = String(zone || "").toUpperCase().trim();
  const fallback = Number(DEFAULT_ZONE_CAPS[normalizedZone] || 0);

  const rule = pickCapacityRule(
    rules,
    (item) =>
      String(item?.targetType || "").toLowerCase() === "zone" &&
      String(item?.zone || "").toUpperCase() === normalizedZone,
    dateStr,
    time
  );

  return {
    limit: rule ? Math.max(0, Number(rule.limit || 0)) : fallback,
    rule,
  };
}

function resolveServiceCapacityFromRules(rules, serviceKey, dateStr, time) {
  const sk = serviceToKey(serviceKey);
  const zone = capacityZoneForService(sk);

  if (!sk || !zone) {
    return {
      serviceKey: sk,
      zone,
      zoneLimit: 0,
      serviceLimit: null,
      effectiveLimit: 0,
    };
  }

  const zoneResolved = resolveZoneCapacityFromRules(rules, zone, dateStr, time);

  const serviceRule = pickCapacityRule(
    rules,
    (item) =>
      String(item?.targetType || "").toLowerCase() === "service" &&
      serviceToKey(item?.serviceKey) === sk,
    dateStr,
    time
  );

  const serviceLimit = serviceRule
    ? Math.max(0, Number(serviceRule.limit || 0))
    : null;

  return {
    serviceKey: sk,
    zone,
    zoneLimit: zoneResolved.limit,
    serviceLimit,
    effectiveLimit:
      serviceLimit == null
        ? zoneResolved.limit
        : Math.min(zoneResolved.limit, serviceLimit),
  };
}

async function loadCapacityRulesForDate(dateStr) {
  const day = String(dateStr || "").slice(0, 10);
  const monthKey = day.slice(0, 7);

  return CapacityRule.find({
    active: true,
    $or: [
      { scope: "default" },
      { scope: "month", monthKey },
      { scope: { $in: ["date", "slot"] }, date: day },
    ],
  })
    .sort({ updatedAt: 1 })
    .lean();
}

function buildCounts(items = [], getter) {
  const out = {
    EP: 0,
    RA: 0,
    RF: 0,
    KD: 0,
    SYN: 0,
  };

  for (const item of Array.isArray(items) ? items : []) {
    const sk = getter(item);
    if (Object.prototype.hasOwnProperty.call(out, sk)) out[sk] += 1;
  }

  return out;
}

function performanceCount(counts) {
  return (
    Number(counts?.RA || 0) +
    Number(counts?.RF || 0) +
    Number(counts?.KD || 0) +
    Number(counts?.SYN || 0)
  );
}

function getEffectiveWaitlistAvailability({
  reservations = [],
  notifiedEntries = [],
  capacityRules = [],
  serviceKey,
  date,
  time,
}) {
  const sk = serviceToKey(serviceKey);
  const capacity = resolveServiceCapacityFromRules(capacityRules, sk, date, time);

  const reservedCounts = buildCounts(reservations, appointmentServiceKey);
  const offeredCounts = buildCounts(notifiedEntries, waitlistEntryServiceKey);

  const zoneReserved =
    capacity.zone === "TRAINING"
      ? Number(reservedCounts.EP || 0)
      : capacity.zone === "PERFORMANCE"
        ? performanceCount(reservedCounts)
        : 0;

  // Un token vigente representa un lugar ofrecido temporalmente. Lo contamos para
  // no avisar a dos personas por la misma vacante del pool compartido.
  const zoneOffered =
    capacity.zone === "TRAINING"
      ? Number(offeredCounts.EP || 0)
      : capacity.zone === "PERFORMANCE"
        ? performanceCount(offeredCounts)
        : 0;

  const serviceReserved = Number(reservedCounts?.[sk] || 0);
  const serviceOffered = Number(offeredCounts?.[sk] || 0);

  const zoneAvailable = Math.max(
    0,
    Number(capacity.zoneLimit || 0) - zoneReserved - zoneOffered
  );

  const serviceAvailable =
    capacity.serviceLimit == null
      ? null
      : Math.max(
          0,
          Number(capacity.serviceLimit || 0) - serviceReserved - serviceOffered
        );

  const effectiveAvailable =
    serviceAvailable == null
      ? zoneAvailable
      : Math.min(zoneAvailable, serviceAvailable);

  return {
    ...capacity,
    zoneReserved,
    zoneOffered,
    serviceReserved,
    serviceOffered,
    zoneAvailable,
    serviceAvailable,
    effectiveAvailable,
  };
}

function buildClaimUrl(token) {
  const frontend = String(process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  if (!frontend) return "";
  return `${frontend}/waitlist/claim?token=${encodeURIComponent(token)}`;
}

export async function notifyWaitlistForSlot({
  date,
  time,
  service = "",
  serviceKey = EP_KEY,
} = {}) {
  try {
    const identity =
      resolveServiceIdentity({ service, serviceKey }) ||
      resolveServiceIdentity({ serviceKey: EP_KEY });

    const requestedSk = identity?.serviceKey || "";
    const requestedServiceName = identity?.serviceName || serviceKeyToName(EP_KEY);

    if (!OPERATIONAL_WAITLIST_KEYS.has(requestedSk)) {
      return {
        ok: true,
        skipped: true,
        reason: "SERVICE_HAS_NO_WAITLIST",
        serviceKey: requestedSk || null,
      };
    }

    const day = String(date || "").slice(0, 10);
    const t = String(time || "").slice(0, 5);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(t)) {
      return { ok: false, error: "INVALID_SLOT" };
    }

    const now = new Date();

    const [existingReservations, activeOffers, capacityRules] = await Promise.all([
      Appointment.find({
        date: day,
        time: t,
        status: "reserved",
      })
        .select("service serviceKey serviceName")
        .lean(),

      WaitlistEntry.find({
        date: day,
        time: t,
        status: "notified",
        tokenExpiresAt: { $gt: now },
      })
        .select("service serviceKey serviceName tokenExpiresAt")
        .lean(),

      loadCapacityRulesForDate(day),
    ]);

    const availability = getEffectiveWaitlistAvailability({
      reservations: existingReservations,
      notifiedEntries: activeOffers,
      capacityRules,
      serviceKey: requestedSk,
      date: day,
      time: t,
    });

    if (availability.effectiveAvailable <= 0) {
      return {
        ok: true,
        skipped: true,
        reason:
          availability.serviceAvailable === 0
            ? "SERVICE_LIMIT_REACHED"
            : "SLOT_STILL_FULL",
        serviceKey: requestedSk,
        capacity: availability.effectiveLimit,
        zoneLimit: availability.zoneLimit,
        serviceLimit: availability.serviceLimit,
      };
    }

    const nextEntry = await WaitlistEntry.findOne({
      date: day,
      time: t,
      status: "waiting",
      serviceKey: requestedSk,
    })
      .populate("user", "name lastName email")
      .sort({ priorityOrder: 1, createdAt: 1 });

    if (!nextEntry) {
      return {
        ok: true,
        skipped: true,
        reason: "NO_WAITLIST",
        serviceKey: requestedSk,
      };
    }

    const nextEntrySk = waitlistEntryServiceKey(nextEntry);
    if (nextEntrySk && nextEntrySk !== requestedSk) {
      return {
        ok: true,
        skipped: true,
        reason: "WAITLIST_SERVICE_MISMATCH",
        serviceKey: nextEntrySk,
      };
    }

    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(
      Date.now() + WAITLIST_CLAIM_WINDOW_MINUTES * 60 * 1000
    );

    nextEntry.serviceKey = requestedSk;
    nextEntry.service = requestedServiceName;
    nextEntry.notifyToken = token;
    nextEntry.notifiedAt = new Date();
    nextEntry.tokenExpiresAt = expiresAt;
    nextEntry.status = "notified";
    await nextEntry.save();

    const claimUrl = buildClaimUrl(token);

    // Mantengo el comportamiento actual del proyecto: acá se deja el evento listo
    // para el helper de email real que ya use DUO para la sala de espera.
    console.log("[WAITLIST][NOTIFY]", {
      to: nextEntry?.user?.email || "",
      userId:
        nextEntry?.user?._id?.toString?.() || String(nextEntry?.user || ""),
      userName: [nextEntry?.user?.name, nextEntry?.user?.lastName]
        .filter(Boolean)
        .join(" "),
      date: day,
      time: t,
      serviceKey: requestedSk,
      service: requestedServiceName,
      claimUrl,
      expiresAt,
      zone: availability.zone,
      zoneLimit: availability.zoneLimit,
      serviceLimit: availability.serviceLimit,
    });

    return {
      ok: true,
      notified: true,
      waitlistEntryId: String(nextEntry._id),
      token,
      expiresAt,
      claimUrl,
      serviceKey: requestedSk,
      service: requestedServiceName,
      zone: availability.zone,
      zoneLimit: availability.zoneLimit,
      serviceLimit: availability.serviceLimit,
    };
  } catch (err) {
    console.error("Error en notifyWaitlistForSlot:", err);
    return { ok: false, error: err?.message || "WAITLIST_NOTIFY_ERROR" };
  }
}

export default notifyWaitlistForSlot;
