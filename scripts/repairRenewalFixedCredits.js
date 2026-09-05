// DUO — Reparación controlada del período ya renovado.
//
// DRY RUN:
//   node scripts/repairRenewalFixedCredits.js --month=2026-09
//
// Guardar preview:
//   node scripts/repairRenewalFixedCredits.js --month=2026-09 --out=renewal-fixed-preview-2026-09.json
//
// APPLY:
//   node scripts/repairRenewalFixedCredits.js --month=2026-09 --apply --confirm=2026-09
//
// Solo reserva créditos del lote del ciclo mensual contra turnos fijos
// pendientes. Los casos ambiguos quedan en REVIEW y no se tocan.

import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";

import Appointment from "../src/models/Appointment.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import User from "../src/models/User.js";

const TZ = "America/Argentina/Buenos_Aires";
const APPLY = process.argv.includes("--apply");

function clean(value) {
  return String(value ?? "").trim();
}

function idOf(value) {
  return clean(value?._id || value);
}

function argValue(name) {
  const prefix = `--${name}=`;
  const raw = process.argv.find((arg) => arg.startsWith(prefix));
  return raw ? raw.slice(prefix.length) : "";
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

function normalizeServiceKey(value) {
  return clean(value).toUpperCase();
}

function activeAppointment(ap) {
  return !["cancelled", "canceled"].includes(clean(ap?.status).toLowerCase());
}

function appointmentSort(a, b) {
  const ad = `${clean(a?.date).slice(0,10)} ${clean(a?.time).slice(0,5)}`;
  const bd = `${clean(b?.date).slice(0,10)} ${clean(b?.time).slice(0,5)}`;
  return ad.localeCompare(bd);
}

function recalcCredits(user, now = new Date()) {
  user.credits = (Array.isArray(user?.creditLots) ? user.creditLots : []).reduce(
    (sum, lot) => {
      const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
      if (exp && exp <= now) return sum;
      return sum + Math.max(0, Number(lot?.remaining || 0));
    },
    0
  );
}

async function loadPreview(periodKey) {
  const range = monthRange(periodKey);

  const cycles = await SubscriptionBillingCycle.find({
    periodKey,
    "creditGrant.granted": true,
  })
    .select(
      "_id subscription user serviceKey periodKey planSnapshot.monthlySessions creditGrant.grantedSessions creditGrant.lotId"
    )
    .sort({ user: 1, serviceKey: 1 })
    .lean();

  const userIds = [...new Set(cycles.map((c) => idOf(c.user)).filter(Boolean))];

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
        "_id user serviceKey service date time status fixedScheduleId creditLotId creditDebitStatus fixedDebitProcessedAt creditDebitedAt"
      )
      .sort({ date: 1, time: 1 })
      .lean(),
  ]);

  const usersById = new Map(users.map((u) => [idOf(u._id), u]));
  const apsByKey = new Map();

  for (const ap of appointments) {
    const sk = normalizeServiceKey(ap.serviceKey || ap.service);
    const key = `${idOf(ap.user)}__${sk}`;
    if (!apsByKey.has(key)) apsByKey.set(key, []);
    apsByKey.get(key).push(ap);
  }

  const rows = [];

  for (const cycle of cycles) {
    const userId = idOf(cycle.user);
    const serviceKey = normalizeServiceKey(cycle.serviceKey);
    const user = usersById.get(userId);
    const cycleId = idOf(cycle._id);
    const expectedSource = `subscription_cycle:${cycleId}:${periodKey}`;
    const cycleLotId = idOf(cycle?.creditGrant?.lotId);
    const lots = Array.isArray(user?.creditLots) ? user.creditLots : [];

    const lot =
      lots.find((item) => cycleLotId && idOf(item?._id) === cycleLotId) ||
      lots.find((item) => clean(item?.source) === expectedSource) ||
      null;

    const lotId = idOf(lot?._id) || cycleLotId;
    const lotRemaining = lot ? Math.max(0, Number(lot.remaining || 0)) : null;
    const lotAmount = lot
      ? Math.max(0, Number(lot.amount || 0))
      : Math.max(0, Number(cycle?.creditGrant?.grantedSessions || 0));

    const allForService = (apsByKey.get(`${userId}__${serviceKey}`) || [])
      .filter(activeAppointment)
      .sort(appointmentSort);

    const fixed = allForService.filter((ap) => !!ap.fixedScheduleId);
    const nonFixed = allForService.filter((ap) => !ap.fixedScheduleId);

    const coveredByCycle = fixed.filter(
      (ap) => lotId && idOf(ap.creditLotId) === lotId
    );
    const coveredByOther = fixed.filter(
      (ap) => idOf(ap.creditLotId) && idOf(ap.creditLotId) !== lotId
    );
    const markerWithoutLot = fixed.filter((ap) => {
      if (idOf(ap.creditLotId)) return false;
      return ["monthly_reserved", "debited"].includes(
        clean(ap.creditDebitStatus).toLowerCase()
      );
    });

    const pending = fixed.filter((ap) => {
      if (idOf(ap.creditLotId)) return false;
      return !["monthly_reserved", "debited"].includes(
        clean(ap.creditDebitStatus).toLowerCase()
      );
    });

    const pendingReserved = pending.filter(
      (ap) => clean(ap.status).toLowerCase() === "reserved"
    );
    const pendingCompleted = pending.filter(
      (ap) => clean(ap.status).toLowerCase() === "completed"
    );

    const nonFixedUsingCycle = nonFixed.filter(
      (ap) => lotId && idOf(ap.creditLotId) === lotId
    );

    const consumed = lot
      ? Math.max(0, lotAmount - Math.max(0, Number(lot.remaining || 0)))
      : null;
    const tracked = coveredByCycle.length + nonFixedUsingCycle.length;
    const untracked =
      consumed === null ? null : Math.max(0, consumed - tracked);

    const reviewFlags = {
      missingUser: !user,
      missingCycleLot: !lot,
      cycleLotSourceMismatch:
        !!lot && clean(lot.source) !== expectedSource,
      markerWithoutLot: markerWithoutLot.length > 0,
      untrackedCycleLotConsumption:
        untracked !== null && untracked > 0,
      nonFixedCycleUsage: nonFixedUsingCycle.length > 0,
      completedPendingFixed: pendingCompleted.length > 0,
    };

    const reviewRequired = Object.values(reviewFlags).some(Boolean);
    const reserveNow =
      !reviewRequired && lotRemaining !== null
        ? Math.min(lotRemaining, pendingReserved.length)
        : 0;

    rows.push({
      userId,
      name: `${clean(user?.name)} ${clean(user?.lastName)}`.trim(),
      email: clean(user?.email),
      serviceKey,
      cycleId,
      subscriptionId: idOf(cycle.subscription),
      periodKey,
      planSessions: Math.max(0, Number(cycle?.planSnapshot?.monthlySessions || 0)),
      userCreditsTotalNow: Number(user?.credits || 0),
      cycleLot: {
        found: !!lot,
        lotId,
        amount: lotAmount,
        remainingNow: lotRemaining,
        consumedNow: consumed,
        trackedConsumption: tracked,
        untrackedConsumption: untracked,
      },
      fixedAppointments: {
        activeCount: fixed.length,
        coveredByCycleLot: coveredByCycle.length,
        coveredByOtherLot: coveredByOther.length,
        pendingReserved: pendingReserved.length,
        pendingCompleted: pendingCompleted.length,
      },
      repair: {
        reviewRequired,
        creditsToReserveNow: reserveNow,
        expectedCycleLotRemainingAfter:
          lotRemaining === null ? null : Math.max(0, lotRemaining - reserveNow),
        pendingReservedAfter: Math.max(0, pendingReserved.length - reserveNow),
        wouldChange: reserveNow > 0,
      },
      reviewFlags,
      pendingAppointmentIds: pendingReserved.map((ap) => idOf(ap._id)),
    });
  }

  return {
    range,
    cyclesRead: cycles.length,
    usersRead: users.length,
    appointmentsRead: appointments.length,
    rows,
  };
}

async function applyRow(row, periodKey, now) {
  const session = await mongoose.startSession();

  try {
    let result = null;

    await session.withTransaction(async () => {
      const cycle = await SubscriptionBillingCycle.findOne({
        _id: row.cycleId,
        periodKey,
        "creditGrant.granted": true,
      }).session(session);

      if (!cycle) {
        result = { ok: false, skipped: true, reason: "CYCLE_CHANGED" };
        return;
      }

      const user = await User.findById(row.userId).session(session);
      if (!user) {
        result = { ok: false, skipped: true, reason: "USER_NOT_FOUND" };
        return;
      }

      user.creditLots = Array.isArray(user.creditLots) ? user.creditLots : [];

      const expectedSource = `subscription_cycle:${String(cycle._id)}:${periodKey}`;
      const lotId = idOf(cycle?.creditGrant?.lotId);
      const lot =
        user.creditLots.find(
          (item) => lotId && idOf(item?._id) === lotId
        ) ||
        user.creditLots.find(
          (item) => clean(item?.source) === expectedSource
        );

      if (!lot || clean(lot.source) !== expectedSource) {
        result = { ok: false, skipped: true, reason: "CYCLE_LOT_CHANGED" };
        return;
      }

      const freshPending = await Appointment.find({
        _id: { $in: row.pendingAppointmentIds },
        user: row.userId,
        serviceKey: row.serviceKey,
        fixedScheduleId: { $ne: null },
        status: "reserved",
        creditDebitStatus: { $nin: ["monthly_reserved", "debited"] },
        $or: [
          { creditLotId: null },
          { creditLotId: { $exists: false } },
        ],
      })
        .sort({ date: 1, time: 1, createdAt: 1 })
        .session(session);

      const remainingBefore = Math.max(0, Number(lot.remaining || 0));
      const reserveCount = Math.min(remainingBefore, freshPending.length);

      if (reserveCount <= 0) {
        result = {
          ok: true,
          skipped: true,
          reason: "NOTHING_TO_RESERVE",
          remainingBefore,
        };
        return;
      }

      const selected = freshPending.slice(0, reserveCount);

      for (const ap of selected) {
        ap.creditLotId = lot._id || null;
        ap.creditExpiresAt = lot.expiresAt || null;
        ap.creditDebitStatus = "monthly_reserved";
        ap.creditDebitedAt = now;
        ap.fixedDebtAmount = 0;
        await ap.save({ session });
      }

      lot.remaining = remainingBefore - reserveCount;
      user.markModified?.("creditLots");
      user.history = Array.isArray(user.history) ? user.history : [];
      user.history.push({
        action: "subscription_fixed_credits_repaired",
        title: `Corrección de créditos reservados ${row.serviceKey}`,
        message: `Se vincularon ${reserveCount} crédito${reserveCount === 1 ? "" : "s"} del ciclo ${periodKey} a turnos fijos que ya estaban reservados.`,
        serviceKey: row.serviceKey,
        serviceName: row.serviceKey,
        service: row.serviceKey,
        qty: -reserveCount,
        createdAt: now,
      });

      recalcCredits(user, now);
      await user.save({ session });

      result = {
        ok: true,
        skipped: false,
        userId: row.userId,
        serviceKey: row.serviceKey,
        cycleId: row.cycleId,
        lotId: idOf(lot._id),
        reserved: reserveCount,
        remainingBefore,
        remainingAfter: Math.max(0, remainingBefore - reserveCount),
        pendingAfter: Math.max(0, freshPending.length - reserveCount),
        appointmentIds: selected.map((ap) => idOf(ap._id)),
      };
    });

    return result || { ok: false, skipped: true, reason: "NO_RESULT" };
  } finally {
    await session.endSession();
  }
}

function writeJsonFile(filename, value) {
  if (!filename) return "";
  const target = path.resolve(process.cwd(), filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf8");
  return target;
}

async function main() {
  const uri = clean(process.env.MONGO_URI);
  if (!uri) throw new Error("Falta MONGO_URI.");

  const periodKey = argValue("month") || currentMonthKeyArgentina();
  const confirm = argValue("confirm");
  const outArg = argValue("out");

  if (APPLY && confirm !== periodKey) {
    throw new Error(
      `Para aplicar, agregá --confirm=${periodKey}. No se modificó la base.`
    );
  }

  await mongoose.connect(uri);

  const preview = await loadPreview(periodKey);
  const candidates = preview.rows.filter(
    (row) => row.repair.wouldChange && !row.repair.reviewRequired
  );
  const review = preview.rows.filter((row) => row.repair.reviewRequired);

  const summary = {
    ok: true,
    mode: APPLY ? "APPLY" : "DRY_RUN",
    periodKey,
    writesToDatabase: APPLY,
    cyclesRead: preview.cyclesRead,
    usersRead: preview.usersRead,
    appointmentsRead: preview.appointmentsRead,
    candidates: candidates.length,
    reviewRequired: review.length,
    creditsToReserve: candidates.reduce(
      (sum, row) => sum + row.repair.creditsToReserveNow,
      0
    ),
    usersServicesAlreadyCorrect: preview.rows.filter(
      (row) => !row.repair.wouldChange && !row.repair.reviewRequired
    ).length,
  };

  const report = { summary, candidates, review };

  let reportFile = "";
  if (outArg) reportFile = writeJsonFile(outArg, report);

  if (!APPLY) {
    console.log(JSON.stringify({
      ...summary,
      reportFile: reportFile || null,
      preview: candidates.map((row) => ({
        name: row.name,
        email: row.email,
        serviceKey: row.serviceKey,
        planSessions: row.planSessions,
        fixedActive: row.fixedAppointments.activeCount,
        cycleRemainingNow: row.cycleLot.remainingNow,
        creditsToReserveNow: row.repair.creditsToReserveNow,
        expectedRemainingAfter: row.repair.expectedCycleLotRemainingAfter,
        pendingAfter: row.repair.pendingReservedAfter,
      })),
      note: review.length
        ? "Hay casos REVIEW que NO serán tocados por --apply."
        : "No hay casos ambiguos detectados.",
    }, null, 2));
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(
    "backups",
    `renewal-fixed-repair-${periodKey}-${stamp}.json`
  );
  writeJsonFile(backupPath, report);

  const now = new Date();
  const applied = [];
  let reservedTotal = 0;
  let skipped = 0;
  let errors = 0;

  for (const row of candidates) {
    try {
      const result = await applyRow(row, periodKey, now);
      applied.push({
        name: row.name,
        email: row.email,
        serviceKey: row.serviceKey,
        ...result,
      });
      reservedTotal += Math.max(0, Number(result?.reserved || 0));
      if (result?.skipped) skipped += 1;
    } catch (error) {
      errors += 1;
      applied.push({
        name: row.name,
        email: row.email,
        serviceKey: row.serviceKey,
        ok: false,
        error: error?.message || String(error),
      });
    }
  }

  console.log(JSON.stringify({
    ok: errors === 0,
    mode: "APPLY",
    periodKey,
    backupFile: backupPath,
    candidates: candidates.length,
    reviewSkipped: review.length,
    rowsApplied: applied.filter((item) => item.ok && !item.skipped).length,
    rowsSkipped: skipped,
    errors,
    creditsReserved: reservedTotal,
    applied,
    next: `Reejecutar auditRenewalFixedCreditReservation.js --month=${periodKey}`,
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      mode: APPLY ? "APPLY" : "DRY_RUN",
      writesToDatabase: APPLY,
      error: error?.message || String(error),
    }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
