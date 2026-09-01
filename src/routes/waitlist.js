// backend/src/routes/waitlist.js
import crypto from "crypto";

import Appointment from "../models/Appointment.js";
import WaitlistEntry from "../models/WaitlistEntry.js";
import CapacityRule from "../models/CapacityRule.js";

import {
  allowedTimesForService,
  capacityGroupForService,
  ensureServiceCatalogLoaded,
  isServiceEnabledFor,
  normalizeCatalogServiceKey,
  serviceNameForKey,
} from "../services/serviceCatalogRuntime.js";

const DEFAULT_ZONE_CAPS = Object.freeze({
  TRAINING: 11,
  PERFORMANCE: 6,
  NONE: 1,
});

const CAPACITY_SCOPE_PRIORITY = Object.freeze({
  default: 0,
  month: 1,
  date: 2,
  slot: 3,
});

const WAITLIST_CLAIM_WINDOW_MINUTES = Number(
  process.env.WAITLIST_CLAIM_WINDOW_MINUTES || 60
);

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

function pickRule(rules, predicate, date, time) {
  return (Array.isArray(rules) ? rules : [])
    .filter((rule) => capacityRuleMatchesSlot(rule, date, time))
    .filter(predicate)
    .sort((a, b) => {
      const ap = CAPACITY_SCOPE_PRIORITY[String(a?.scope || "default")] ?? -1;
      const bp = CAPACITY_SCOPE_PRIORITY[String(b?.scope || "default")] ?? -1;
      if (ap !== bp) return bp - ap;

      const au = a?.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const bu = b?.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return bu - au;
    })[0] || null;
}

async function loadCapacityRules(date) {
  const day = String(date || "").slice(0, 10);
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

function resolveCapacity(rules, serviceKey, date, time) {
  const sk = normalizeCatalogServiceKey(serviceKey);
  const zone = capacityGroupForService(sk);

  const zoneRule = pickRule(
    rules,
    (rule) =>
      String(rule?.targetType || "").toLowerCase() === "zone" &&
      String(rule?.zone || "").toUpperCase() === zone,
    date,
    time
  );

  const serviceRule = pickRule(
    rules,
    (rule) =>
      String(rule?.targetType || "").toLowerCase() === "service" &&
      normalizeCatalogServiceKey(rule?.serviceKey) === sk,
    date,
    time
  );

  const zoneLimit = zoneRule
    ? Math.max(0, Number(zoneRule.limit || 0))
    : Number(DEFAULT_ZONE_CAPS[zone] ?? 1);

  const serviceLimit = serviceRule
    ? Math.max(0, Number(serviceRule.limit || 0))
    : null;

  return {
    serviceKey: sk,
    zone,
    zoneLimit,
    serviceLimit,
    effectiveLimit:
      serviceLimit == null
        ? zoneLimit
        : Math.min(zoneLimit, serviceLimit),
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
  serviceKey = "",
} = {}) {
  try {
    await ensureServiceCatalogLoaded();

    const requestedSk =
      normalizeCatalogServiceKey(serviceKey) ||
      normalizeCatalogServiceKey(service);

    if (!requestedSk || !isServiceEnabledFor(requestedSk, "waitlistEnabled")) {
      return {
        ok: true,
        skipped: true,
        reason: "SERVICE_HAS_NO_WAITLIST",
        serviceKey: requestedSk || null,
      };
    }

    const t = String(time || "").slice(0, 5);

    if (!allowedTimesForService(requestedSk, date).includes(t)) {
      return {
        ok: true,
        skipped: true,
        reason: "SERVICE_TIME_CLOSED",
        serviceKey: requestedSk,
      };
    }

    const [existingReservations, rules] = await Promise.all([
      Appointment.find({
        date,
        time: t,
        status: "reserved",
      })
        .select("service serviceKey serviceName")
        .lean(),
      loadCapacityRules(date),
    ]);

    const capacity = resolveCapacity(rules, requestedSk, date, t);

    const byService = {};
    const byZone = {};

    for (const appointment of existingReservations || []) {
      const sk = normalizeCatalogServiceKey(
        appointment?.serviceKey ||
          appointment?.service ||
          appointment?.serviceName
      );
      if (!sk) continue;

      byService[sk] = Number(byService[sk] || 0) + 1;

      const zone = capacityGroupForService(sk);
      if (zone !== "NONE") {
        byZone[zone] = Number(byZone[zone] || 0) + 1;
      }
    }

    const serviceReserved = Number(byService[requestedSk] || 0);
    const zoneReserved =
      capacity.zone === "NONE"
        ? serviceReserved
        : Number(byZone[capacity.zone] || 0);

    const zoneAvailable = Math.max(
      0,
      capacity.zoneLimit - zoneReserved
    );

    const serviceAvailable =
      capacity.serviceLimit == null
        ? null
        : Math.max(0, capacity.serviceLimit - serviceReserved);

    const available =
      serviceAvailable == null
        ? zoneAvailable
        : Math.min(zoneAvailable, serviceAvailable);

    if (available <= 0) {
      return {
        ok: true,
        skipped: true,
        reason: "SLOT_STILL_FULL",
        serviceKey: requestedSk,
      };
    }

    const alreadyNotified = await WaitlistEntry.findOne({
      date,
      time: t,
      serviceKey: requestedSk,
      status: "notified",
      tokenExpiresAt: { $gt: new Date() },
    }).lean();

    if (alreadyNotified) {
      return {
        ok: true,
        skipped: true,
        reason: "ALREADY_NOTIFIED",
        serviceKey: requestedSk,
      };
    }

    const nextEntry = await WaitlistEntry.findOne({
      date,
      time: t,
      serviceKey: requestedSk,
      status: "waiting",
    })
      .populate("user", "name lastName email")
      .sort({ createdAt: 1 });

    if (!nextEntry) {
      return {
        ok: true,
        skipped: true,
        reason: "NO_WAITLIST",
        serviceKey: requestedSk,
      };
    }

    const token = crypto.randomBytes(24).toString("hex");
    const expiresAt = new Date(
      Date.now() + WAITLIST_CLAIM_WINDOW_MINUTES * 60 * 1000
    );

    nextEntry.serviceKey = requestedSk;
    nextEntry.service = serviceNameForKey(requestedSk);
    nextEntry.notifyToken = token;
    nextEntry.notifiedAt = new Date();
    nextEntry.tokenExpiresAt = expiresAt;
    nextEntry.status = "notified";
    await nextEntry.save();

    const claimUrl = buildClaimUrl(token);

    console.log("[WAITLIST][NOTIFY]", {
      to: nextEntry?.user?.email || "",
      userId:
        nextEntry?.user?._id?.toString?.() ||
        String(nextEntry?.user || ""),
      userName: [nextEntry?.user?.name, nextEntry?.user?.lastName]
        .filter(Boolean)
        .join(" "),
      date,
      time: t,
      serviceKey: requestedSk,
      service: serviceNameForKey(requestedSk),
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
      serviceKey: requestedSk,
      service: serviceNameForKey(requestedSk),
    };
  } catch (err) {
    console.error("Error en notifyWaitlistForSlot:", err);
    return {
      ok: false,
      error: err?.message || "WAITLIST_NOTIFY_ERROR",
    };
  }
}

export default notifyWaitlistForSlot;
