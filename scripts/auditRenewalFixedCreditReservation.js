// DUO — Auditoría read-only de créditos de renovación vs turnos fijos.
//
// Uso desde la raíz del backend:
//   node scripts/auditRenewalFixedCreditReservation.js --month=2026-09
//
// Seguridad:
// - solo hace consultas Mongo (find/lean);
// - NO llama save/update/create/delete;
// - NO modifica créditos, turnos, ciclos ni suscripciones;
// - NO hace requests HTTP.

import "dotenv/config";
import mongoose from "mongoose";

import Appointment from "../src/models/Appointment.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import User from "../src/models/User.js";

const TZ = "America/Argentina/Buenos_Aires";

function clean(value) {
  return String(value ?? "").trim();
}

function idOf(value) {
  return clean(value?._id || value);
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function currentMonthKeyArgentina(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}`;
}

function monthRange(periodKey) {
  const match = /^(\d{4})-(\d{2})$/.exec(clean(periodKey));
  if (!match) throw new Error(`Mes inválido: ${periodKey}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const lastDay = new Date(year, month, 0, 12, 0, 0, 0).getDate();
  return {
    startYmd: `${year}-${pad2(month)}-01`,
    endYmd: `${year}-${pad2(month)}-${pad2(lastDay)}`,
  };
}

function argValue(name) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : "";
}

function normalizeServiceKey(value) {
  return clean(value).toUpperCase();
}

function activeAppointment(ap) {
  return !["cancelled", "canceled"].includes(clean(ap?.status).toLowerCase());
}

function appointmentSort(a, b) {
  const ad = `${clean(a?.date).slice(0, 10)} ${clean(a?.time).slice(0, 5)}`;
  const bd = `${clean(b?.date).slice(0, 10)} ${clean(b?.time).slice(0, 5)}`;
  return ad.localeCompare(bd);
}

function fixedKey(userId, serviceKey) {
  return `${clean(userId)}__${normalizeServiceKey(serviceKey)}`;
}

async function main() {
  const uri = clean(process.env.MONGO_URI);
  if (!uri) throw new Error("Falta MONGO_URI.");

  const periodKey = argValue("month") || currentMonthKeyArgentina();
  const range = monthRange(periodKey);

  await mongoose.connect(uri);

  const cycles = await SubscriptionBillingCycle.find({
    periodKey,
    "creditGrant.granted": true,
  })
    .select(
      "_id subscription user serviceKey periodKey planSnapshot.monthlySessions creditGrant.granted creditGrant.grantedSessions creditGrant.lotId creditGrant.grantedAt creditGrant.expiresAt coverage.fixedOccurrencesCount coverage.freeSessions coverage.extraSessionsNeeded billing.status"
    )
    .sort({ user: 1, serviceKey: 1 })
    .lean();

  const userIds = [...new Set(cycles.map((cycle) => idOf(cycle.user)).filter(Boolean))];

  const [users, appointments] = await Promise.all([
    User.find({ _id: { $in: userIds } })
      .select("_id name lastName email credits creditLots")
      .lean(),
    Appointment.find({
      user: { $in: userIds },
      date: { $gte: range.startYmd, $lte: range.endYmd },
      status: { $in: ["reserved", "completed", "cancelled"] },
    })
      .select(
        "_id user serviceKey service date time status fixedScheduleId creditLotId creditDebitStatus fixedDebitProcessedAt creditDebitedAt refundApplied refundMode"
      )
      .sort({ date: 1, time: 1 })
      .lean(),
  ]);

  const usersById = new Map(users.map((user) => [idOf(user._id), user]));
  const appointmentsByUserService = new Map();

  for (const ap of appointments) {
    const sk = normalizeServiceKey(ap.serviceKey || ap.service);
    const key = fixedKey(ap.user, sk);
    if (!appointmentsByUserService.has(key)) appointmentsByUserService.set(key, []);
    appointmentsByUserService.get(key).push(ap);
  }

  const affected = [];
  const all = [];

  for (const cycle of cycles) {
    const userId = idOf(cycle.user);
    const serviceKey = normalizeServiceKey(cycle.serviceKey);
    const user = usersById.get(userId) || null;
    const planSessions = Math.max(0, Number(cycle?.planSnapshot?.monthlySessions || 0));
    const cycleLotId = idOf(cycle?.creditGrant?.lotId);
    const source = `subscription_cycle:${idOf(cycle._id)}:${periodKey}`;
    const lots = Array.isArray(user?.creditLots) ? user.creditLots : [];
    const lot =
      lots.find((item) => cycleLotId && idOf(item?._id) === cycleLotId) ||
      lots.find((item) => clean(item?.source) === source) ||
      null;

    const lotId = idOf(lot?._id) || cycleLotId;
    const lotAmount = Math.max(0, Number(lot?.amount ?? cycle?.creditGrant?.grantedSessions ?? planSessions));
    const lotRemaining = lot ? Math.max(0, Number(lot?.remaining || 0)) : null;
    const lotConsumed = lotRemaining === null ? null : Math.max(0, lotAmount - lotRemaining);

    const serviceAppointments = (appointmentsByUserService.get(fixedKey(userId, serviceKey)) || [])
      .filter(activeAppointment)
      .sort(appointmentSort);

    const fixed = serviceAppointments.filter((ap) => !!ap.fixedScheduleId);
    const nonFixed = serviceAppointments.filter((ap) => !ap.fixedScheduleId);

    const fixedCoveredByCycleLot = fixed.filter(
      (ap) => lotId && idOf(ap.creditLotId) === lotId
    );
    const fixedCoveredByOtherLot = fixed.filter(
      (ap) => idOf(ap.creditLotId) && (!lotId || idOf(ap.creditLotId) !== lotId)
    );
    const fixedCoveredMarkerWithoutLot = fixed.filter((ap) => {
      if (idOf(ap.creditLotId)) return false;
      const status = clean(ap.creditDebitStatus).toLowerCase();
      return ["monthly_reserved", "debited"].includes(status);
    });
    const pendingFixed = fixed.filter((ap) => {
      if (idOf(ap.creditLotId)) return false;
      const status = clean(ap.creditDebitStatus).toLowerCase();
      return !["monthly_reserved", "debited"].includes(status);
    });

    const nonFixedUsingCycleLot = nonFixed.filter(
      (ap) => lotId && idOf(ap.creditLotId) === lotId
    );

    const trackedCycleLotConsumption =
      fixedCoveredByCycleLot.length + nonFixedUsingCycleLot.length;
    const untrackedCycleLotConsumption =
      lotConsumed === null
        ? null
        : Math.max(0, lotConsumed - trackedCycleLotConsumption);

    const creditsToReserveNow =
      lotRemaining === null ? 0 : Math.min(lotRemaining, pendingFixed.length);
    const expectedRemainingAfterReservation =
      lotRemaining === null ? null : Math.max(0, lotRemaining - creditsToReserveNow);
    const pendingFixedAfterReservation = Math.max(
      0,
      pendingFixed.length - creditsToReserveNow
    );

    const fixedSessionsBeyondPlan = Math.max(0, fixed.length - planSessions);
    const hasInflatedAvailableCredits = creditsToReserveNow > 0;

    const row = {
      userId,
      name: `${clean(user?.name)} ${clean(user?.lastName)}`.trim(),
      email: clean(user?.email),
      serviceKey,
      cycleId: idOf(cycle._id),
      subscriptionId: idOf(cycle.subscription),
      periodKey,
      planSessions,
      userCreditsTotalNow: Number(user?.credits || 0),
      cycleLot: {
        found: !!lot,
        lotId,
        amount: lotAmount,
        remainingNow: lotRemaining,
        consumedNow: lotConsumed,
        trackedConsumptionByAppointments: trackedCycleLotConsumption,
        untrackedConsumption: untrackedCycleLotConsumption,
      },
      fixedAppointments: {
        activeCount: fixed.length,
        coveredByCycleLot: fixedCoveredByCycleLot.length,
        coveredByOtherLot: fixedCoveredByOtherLot.length,
        coveredMarkerWithoutLot: fixedCoveredMarkerWithoutLot.length,
        pendingWithoutCredit: pendingFixed.length,
        beyondPlanByCount: fixedSessionsBeyondPlan,
      },
      otherUsage: {
        nonFixedAppointmentsUsingCycleLot: nonFixedUsingCycleLot.length,
      },
      repairPreview: {
        creditsToReserveNow,
        expectedCycleLotRemainingAfter: expectedRemainingAfterReservation,
        pendingFixedAfter: pendingFixedAfterReservation,
        wouldChange: hasInflatedAvailableCredits,
      },
      reviewFlags: {
        missingCycleLot: !lot,
        fixedCoveredByOtherLot: fixedCoveredByOtherLot.length > 0,
        coveredMarkerWithoutLot: fixedCoveredMarkerWithoutLot.length > 0,
        untrackedCycleLotConsumption:
          untrackedCycleLotConsumption !== null && untrackedCycleLotConsumption > 0,
        nonFixedCycleUsage: nonFixedUsingCycleLot.length > 0,
      },
      pendingAppointmentIds: pendingFixed.map((ap) => idOf(ap._id)),
    };

    all.push(row);
    if (
      row.repairPreview.wouldChange ||
      Object.values(row.reviewFlags).some(Boolean)
    ) {
      affected.push(row);
    }
  }

  const summary = {
    ok: true,
    readOnly: true,
    writesToDatabase: false,
    networkRequests: false,
    periodKey,
    range,
    cyclesRead: cycles.length,
    usersRead: users.length,
    appointmentsRead: appointments.length,
    affectedCycles: affected.length,
    cyclesWithInflatedAvailableCredits: affected.filter(
      (row) => row.repairPreview.creditsToReserveNow > 0
    ).length,
    creditsThatShouldBeReservedNow: affected.reduce(
      (sum, row) => sum + row.repairPreview.creditsToReserveNow,
      0
    ),
    missingCycleLots: affected.filter((row) => row.reviewFlags.missingCycleLot).length,
    fixedCoveredByOtherLots: affected.filter(
      (row) => row.reviewFlags.fixedCoveredByOtherLot
    ).length,
    nonFixedCycleUsage: affected.filter((row) => row.reviewFlags.nonFixedCycleUsage).length,
    untrackedCycleLotConsumption: affected.filter(
      (row) => row.reviewFlags.untrackedCycleLotConsumption
    ).length,
  };

  console.log(
    JSON.stringify(
      {
        summary,
        affected,
        unaffectedCount: Math.max(0, all.length - affected.length),
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          readOnly: true,
          writesToDatabase: false,
          error: error?.message || String(error),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
