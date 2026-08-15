// scripts/simulateSubscriptionLifecycle.js
//
// Simulación aislada del lifecycle mensual de suscripciones DUO.
// NO usa usuarios reales y NO procesa el mes productivo.
//
// Por seguridad:
// - default = preview, no escribe nada.
// - solo permite periodos >= 2090.
// - exige que no exista NINGÚN SubscriptionBillingCycle previo en el periodo de prueba.
// - crea 2 usuarios/suscripciones temporales.
// - prueba renovación idempotente, suspensión, reactivación por pago y baja día 21.
// - al finalizar elimina todos los documentos temporales creados, incluso si una aserción falla.
//
// Preview:
//   node scripts/simulateSubscriptionLifecycle.js
//
// Ejecutar simulación:
//   node scripts/simulateSubscriptionLifecycle.js \
//     --apply \
//     --confirm=RUN_LIFECYCLE_SIMULATION \
//     --out=subscription-lifecycle-simulation-report.json
//
// Periodo alternativo (siempre >= 2090):
//   --period=2099-12

import fs from "node:fs";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import dotenv from "dotenv";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import PricingPlan from "../src/models/PricingPlan.js";
import Appointment from "../src/models/Appointment.js";
import FixedSchedule from "../src/models/FixedSchedule.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import SubscriptionLifecycleNotice from "../src/models/SubscriptionLifecycleNotice.js";

import {
  ensureMonthlyCycleForSubscription,
  markSubscriptionCyclePaid,
  periodDates,
  renewalPreviewDate,
  suspendOverdueSubscriptions,
  terminateUnpaidSubscriptions,
} from "../src/services/subscriptions/subscriptionLifecycle.js";

dotenv.config();

const CONFIRMATION = "RUN_LIFECYCLE_SIMULATION";
const DEFAULT_PERIOD = "2099-12";
const SERVICE_KEY = "EP";
const SERVICE_NAME = "Entrenamiento Personal";

function parseArgs(argv = []) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, ...rest] = raw.slice(2).split("=");
    out[key] = rest.length ? rest.join("=") : true;
  }
  return out;
}

function clean(value) {
  return String(value || "").trim();
}

function bool(value) {
  if (value === true) return true;
  return ["1", "true", "yes", "si", "sí"].includes(clean(value).toLowerCase());
}

function validPeriodKey(value) {
  return /^\d{4}-\d{2}$/.test(clean(value));
}

function parsePeriod(value) {
  if (!validPeriodKey(value)) throw new Error("PERIOD_KEY_INVALID");
  const [year, month] = value.split("-").map(Number);
  if (year < 2090) {
    throw new Error("SAFETY_PERIOD_MUST_BE_2090_OR_LATER");
  }
  if (month < 1 || month > 12) throw new Error("PERIOD_MONTH_INVALID");
  return { year, month };
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function ymd(periodKey, day) {
  const { year, month } = parsePeriod(periodKey);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function localDate(periodKey, day, time = "09:00:00") {
  return new Date(`${ymd(periodKey, day)}T${time}-03:00`);
}

function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function id(value) {
  return value?._id ? String(value._id) : value ? String(value) : "";
}

function sumLiveCredits(user, now) {
  return (Array.isArray(user?.creditLots) ? user.creditLots : []).reduce((sum, lot) => {
    const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return sum;
    return sum + Math.max(0, Number(lot?.remaining || 0));
  }, 0);
}

async function createScenario({ tag, plan, periodKey, appointmentDay }) {
  const token = crypto.randomBytes(5).toString("hex");
  const email = `lifecycle-sim-${tag}-${token}@duoclub.invalid`;

  const user = await User.create({
    name: "Lifecycle",
    lastName: `Sim ${tag}`,
    email,
    phone: "0000000000",
    password: `NOT_LOGINABLE_${crypto.randomBytes(16).toString("hex")}`,
    role: "client",
    suspended: false,
    approvalStatus: "approved",
    emailVerified: true,
    mustChangePassword: false,
    firstEvaluationCompleted: true,
    credits: 0,
    creditLots: [],
    notes: `TEMP lifecycle simulation ${tag}`,
  });

  const schedule = await FixedSchedule.create({
    user: user._id,
    createdBy: user._id,
    serviceKey: SERVICE_KEY,
    service: SERVICE_NAME,
    items: [{ weekday: 1, time: "07:00" }],
    months: 1,
    startDate: ymd(periodKey, 1),
    endDate: ymd(periodKey, 31),
    notes: `TEMP lifecycle simulation ${tag}`,
    active: true,
  });

  const subscription = await ServiceSubscription.create({
    user: user._id,
    serviceKey: SERVICE_KEY,
    serviceName: SERVICE_NAME,
    pricingPlan: plan._id,
    status: "active",
    autoRenew: true,
    monthlySessions: Number(plan.credits),
    price: Number(plan.price),
    regularPrice: Number(plan.price),
    payMethod: plan.payMethod,
    fixedScheduleIds: [schedule._id],
    currentPeriodKey: "",
  });

  const appointment = await Appointment.create({
    user: user._id,
    date: ymd(periodKey, appointmentDay),
    time: "07:00",
    serviceKey: SERVICE_KEY,
    service: SERVICE_NAME,
    status: "reserved",
    createdByRole: "admin",
    createdByUser: user._id,
    assignedManually: false,
    fixedScheduleId: schedule._id,
    monthlyRolloverMonthKey: periodKey,
    creditDebitStatus: "pending",
    fixedDebtAmount: 0,
    notes: `TEMP lifecycle simulation ${tag}`,
  });

  return { tag, email, user, schedule, subscription, appointment };
}

async function snapshotScenario(scenario, periodKey, now) {
  const [user, subscription, schedule, appointment, cycle, notices] = await Promise.all([
    User.findById(scenario.user._id).lean(),
    ServiceSubscription.findById(scenario.subscription._id).lean(),
    FixedSchedule.findById(scenario.schedule._id).lean(),
    Appointment.findById(scenario.appointment._id).lean(),
    SubscriptionBillingCycle.findOne({
      subscription: scenario.subscription._id,
      periodKey,
    }).lean(),
    SubscriptionLifecycleNotice.find({
      user: scenario.user._id,
      subscription: scenario.subscription._id,
      periodKey,
    })
      .sort({ createdAt: 1 })
      .lean(),
  ]);

  const lots = Array.isArray(user?.creditLots) ? user.creditLots : [];
  const cycleSource = cycle
    ? `subscription_cycle:${String(cycle._id)}:${periodKey}`
    : "";
  const cycleLot = lots.find((lot) => String(lot?.source || "") === cycleSource);

  return {
    tag: scenario.tag,
    email: scenario.email,
    now: iso(now),
    user: {
      exists: !!user,
      creditsField: Number(user?.credits || 0),
      computedLiveCredits: user ? sumLiveCredits(user, now) : 0,
      cycleLotAmount: Number(cycleLot?.amount || 0),
      cycleLotRemaining: Number(cycleLot?.remaining || 0),
    },
    subscription: {
      exists: !!subscription,
      id: id(subscription?._id),
      status: subscription?.status || "",
      autoRenew: subscription?.autoRenew ?? null,
      currentPeriodKey: subscription?.currentPeriodKey || "",
      suspendedAt: iso(subscription?.suspendedAt),
      terminatedAt: iso(subscription?.terminatedAt),
    },
    cycle: cycle
      ? {
          id: id(cycle._id),
          billingStatus: cycle.billing?.status || "",
          amount: Number(cycle.billing?.total || 0),
          planStatus: cycle.lifecycle?.planStatus || "",
          creditsGranted: !!cycle.creditGrant?.granted,
          grantedSessions: Number(cycle.creditGrant?.grantedSessions || 0),
          invalidatedAt: iso(cycle.creditGrant?.invalidatedAt),
          paidAt: iso(cycle.billing?.paidAt),
          suspendedAt: iso(cycle.lifecycle?.suspendedAt),
          terminatedAt: iso(cycle.lifecycle?.terminatedAt),
        }
      : null,
    fixedSchedule: {
      exists: !!schedule,
      active: schedule?.active ?? null,
      deactivatedAt: iso(schedule?.deactivatedAt),
      lastAutoReleasedMonthKey: schedule?.lastAutoReleasedMonthKey || "",
    },
    appointment: {
      exists: !!appointment,
      status: appointment?.status || "",
      cancelledAt: iso(appointment?.cancelledAt),
      cancelReason: appointment?.cancelReason || "",
    },
    notices: notices.map((notice) => ({
      type: notice.type,
      status: notice.status,
      title: notice.title,
    })),
  };
}

async function cleanup({ userIds = [], subscriptionIds = [], periodKey }) {
  const safeUserIds = userIds.filter(Boolean);
  const safeSubscriptionIds = subscriptionIds.filter(Boolean);

  const result = {};

  if (safeUserIds.length) {
    result.notices = (
      await SubscriptionLifecycleNotice.deleteMany({ user: { $in: safeUserIds } })
    ).deletedCount;
    result.appointments = (
      await Appointment.deleteMany({ user: { $in: safeUserIds } })
    ).deletedCount;
    result.fixedSchedules = (
      await FixedSchedule.deleteMany({ user: { $in: safeUserIds } })
    ).deletedCount;
  } else {
    result.notices = 0;
    result.appointments = 0;
    result.fixedSchedules = 0;
  }

  if (safeSubscriptionIds.length) {
    result.cycles = (
      await SubscriptionBillingCycle.deleteMany({
        subscription: { $in: safeSubscriptionIds },
        periodKey,
      })
    ).deletedCount;
    result.subscriptions = (
      await ServiceSubscription.deleteMany({ _id: { $in: safeSubscriptionIds } })
    ).deletedCount;
  } else {
    result.cycles = 0;
    result.subscriptions = 0;
  }

  if (safeUserIds.length) {
    result.users = (
      await User.deleteMany({ _id: { $in: safeUserIds } })
    ).deletedCount;
  } else {
    result.users = 0;
  }

  return result;
}

const args = parseArgs(process.argv.slice(2));
const apply = bool(args.apply);
const confirmation = clean(args.confirm);
const periodKey = clean(args.period || DEFAULT_PERIOD);
const outFile = clean(args.out || "");

parsePeriod(periodKey);

const mongoUri =
  process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;

if (!mongoUri) {
  console.error("❌ No se encontró MONGO_URI/MONGODB_URI/MONGO_URL.");
  process.exit(1);
}

await mongoose.connect(mongoUri);

const report = {
  mode: apply ? "apply" : "preview",
  periodKey,
  generatedAt: new Date().toISOString(),
  safety: {},
  dates: {},
  plan: null,
  stages: [],
  assertions: [],
  cleanup: null,
  ok: false,
};

const createdUserIds = [];
const createdSubscriptionIds = [];

function check(condition, label, details = {}) {
  assert.ok(condition, label);
  report.assertions.push({ ok: true, label, ...details });
  console.log(`✅ ${label}`);
}

try {
  const existingCycles = await SubscriptionBillingCycle.countDocuments({ periodKey });
  report.safety.existingCyclesBefore = existingCycles;

  if (existingCycles !== 0) {
    throw new Error(
      `SAFETY_ABORT_PERIOD_HAS_EXISTING_CYCLES:${periodKey}:${existingCycles}`
    );
  }

  const plan = await PricingPlan.findOne({
    active: true,
    isCustom: { $ne: true },
    serviceKey: SERVICE_KEY,
    credits: 8,
    payMethod: "CASH",
  }).lean();

  if (!plan) throw new Error("ACTIVE_EP_8_CASH_PLAN_NOT_FOUND");

  report.plan = {
    id: id(plan._id),
    serviceKey: plan.serviceKey,
    credits: Number(plan.credits),
    price: Number(plan.price),
    payMethod: plan.payMethod,
  };

  const dates = periodDates(periodKey);
  report.dates = {
    renewalPreviewAt: iso(renewalPreviewDate(periodKey)),
    periodStart: iso(dates.start),
    dueAt: iso(dates.dueAt),
    suspendAt: iso(dates.suspendAt),
    fixedSlotsProtectedUntil: iso(dates.fixedSlotsProtectedUntil),
    terminateAt: iso(dates.terminateAt),
  };

  console.log("\n=== SIMULACIÓN LIFECYCLE DUO ===");
  console.log({
    mode: report.mode,
    periodKey,
    plan: `${plan.serviceKey} ${plan.credits} ${plan.payMethod}`,
    amount: plan.price,
    existingCyclesInTestPeriod: existingCycles,
  });

  console.log("\nSe probarán dos escenarios temporales:");
  console.log("A) impago al día 11 → suspensión → pago día 12 → reactivación");
  console.log("B) impago al día 11 → continúa impago → día 21 libera turno fijo y termina plan");
  console.log("También se prueba que el día 1 sea idempotente y no duplique créditos.\n");

  if (!apply) {
    console.log("🔒 PREVIEW: no se escribió nada en MongoDB.");
    console.log("Para ejecutar:");
    console.log(
      `node scripts/simulateSubscriptionLifecycle.js --apply --confirm=${CONFIRMATION}`
    );
    report.ok = true;
    if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    process.exitCode = 0;
  } else {
    if (confirmation !== CONFIRMATION) {
      throw new Error(`CONFIRMATION_REQUIRED:${CONFIRMATION}`);
    }

    const scenarioA = await createScenario({
      tag: "reactivate",
      plan,
      periodKey,
      appointmentDay: 22,
    });
    const scenarioB = await createScenario({
      tag: "terminate",
      plan,
      periodKey,
      appointmentDay: 23,
    });

    for (const scenario of [scenarioA, scenarioB]) {
      createdUserIds.push(scenario.user._id);
      createdSubscriptionIds.push(scenario.subscription._id);
    }

    // -------------------------
    // DÍA 1: crear ciclos
    // -------------------------
    const day1 = localDate(periodKey, 1, "09:00:00");

    const day1A = await ensureMonthlyCycleForSubscription({
      subscriptionId: scenarioA.subscription._id,
      periodKey,
      now: day1,
    });
    const day1B = await ensureMonthlyCycleForSubscription({
      subscriptionId: scenarioB.subscription._id,
      periodKey,
      now: day1,
    });

    const afterDay1A = await snapshotScenario(scenarioA, periodKey, day1);
    const afterDay1B = await snapshotScenario(scenarioB, periodKey, day1);

    report.stages.push({
      stage: "day_1_renewal",
      now: iso(day1),
      results: { A: day1A, B: day1B },
      snapshots: { A: afterDay1A, B: afterDay1B },
    });

    check(day1A?.created === true, "Día 1: ciclo A creado");
    check(day1B?.created === true, "Día 1: ciclo B creado");
    check(afterDay1A.cycle?.billingStatus === "pending", "Día 1: A queda pending");
    check(afterDay1B.cycle?.billingStatus === "pending", "Día 1: B queda pending");
    check(afterDay1A.user.creditsField === 8, "Día 1: A acredita exactamente 8 sesiones");
    check(afterDay1B.user.creditsField === 8, "Día 1: B acredita exactamente 8 sesiones");
    check(afterDay1A.subscription.status === "active", "Día 1: A permanece activo");
    check(afterDay1B.subscription.status === "active", "Día 1: B permanece activo");

    // Idempotencia: repetir día 1 para A. No debe duplicar sesiones.
    const day1Again = localDate(periodKey, 1, "09:05:00");
    const day1AgainA = await ensureMonthlyCycleForSubscription({
      subscriptionId: scenarioA.subscription._id,
      periodKey,
      now: day1Again,
    });
    const afterIdempotencyA = await snapshotScenario(scenarioA, periodKey, day1Again);

    report.stages.push({
      stage: "day_1_idempotency",
      now: iso(day1Again),
      result: day1AgainA,
      snapshot: afterIdempotencyA,
    });

    check(day1AgainA?.created === false, "Idempotencia: no crea un segundo ciclo");
    check(afterIdempotencyA.user.creditsField === 8, "Idempotencia: no duplica créditos");
    check(afterIdempotencyA.user.cycleLotRemaining === 8, "Idempotencia: el lote del ciclo sigue en 8");

    // Antes de usar operaciones globales por periodo, confirmamos aislamiento total.
    const testCycles = await SubscriptionBillingCycle.find({ periodKey })
      .select("_id subscription")
      .lean();
    const allowedSubscriptions = new Set(createdSubscriptionIds.map(String));
    const unexpectedCycles = testCycles.filter(
      (cycle) => !allowedSubscriptions.has(String(cycle.subscription))
    );

    check(testCycles.length === 2, "Seguridad: el periodo de simulación contiene solo 2 ciclos");
    check(unexpectedCycles.length === 0, "Seguridad: no hay ciclos ajenos en el periodo de prueba");

    // -------------------------
    // DÍA 11: suspensión impaga
    // -------------------------
    const day11 = localDate(periodKey, 11, "09:00:00");
    const suspendResult = await suspendOverdueSubscriptions({
      periodKey,
      now: day11,
      force: false,
    });

    const afterSuspendA = await snapshotScenario(scenarioA, periodKey, day11);
    const afterSuspendB = await snapshotScenario(scenarioB, periodKey, day11);

    report.stages.push({
      stage: "day_11_suspend",
      now: iso(day11),
      result: suspendResult,
      snapshots: { A: afterSuspendA, B: afterSuspendB },
    });

    check(suspendResult?.suspended === 2, "Día 11: suspende los 2 planes impagos");
    check(afterSuspendA.subscription.status === "suspended", "Día 11: A suspendido");
    check(afterSuspendB.subscription.status === "suspended", "Día 11: B suspendido");
    check(afterSuspendA.cycle?.billingStatus === "overdue", "Día 11: A billing overdue");
    check(afterSuspendB.cycle?.billingStatus === "overdue", "Día 11: B billing overdue");
    check(afterSuspendA.fixedSchedule.active === true, "Día 11: A conserva turno fijo");
    check(afterSuspendB.fixedSchedule.active === true, "Día 11: B conserva turno fijo");
    check(afterSuspendA.appointment.status === "reserved", "Día 11: A conserva cita futura");
    check(afterSuspendB.appointment.status === "reserved", "Día 11: B conserva cita futura");
    check(afterSuspendA.user.creditsField === 8, "Día 11: A conserva saldo del ciclo");
    check(afterSuspendB.user.creditsField === 8, "Día 11: B conserva saldo del ciclo");

    // -------------------------
    // DÍA 12: A paga y se reactiva
    // -------------------------
    const day12 = localDate(periodKey, 12, "10:00:00");
    const payA = await markSubscriptionCyclePaid({
      cycleId: afterSuspendA.cycle.id,
      paymentProvider: "SIMULATION",
      paymentId: `SIM-${crypto.randomBytes(6).toString("hex")}`,
      paidAt: day12,
    });

    const afterPayA = await snapshotScenario(scenarioA, periodKey, day12);

    report.stages.push({
      stage: "day_12_payment_reactivation",
      now: iso(day12),
      result: payA,
      snapshot: afterPayA,
    });

    check(payA?.reactivated === true, "Día 12: el pago reactiva A automáticamente");
    check(afterPayA.subscription.status === "active", "Día 12: A vuelve a active");
    check(afterPayA.cycle?.billingStatus === "paid", "Día 12: ciclo A queda paid");
    check(afterPayA.cycle?.planStatus === "active", "Día 12: lifecycle A vuelve a active");
    check(afterPayA.user.creditsField === 8, "Día 12: pagar NO vuelve a acreditar sesiones");
    check(afterPayA.fixedSchedule.active === true, "Día 12: A mantiene patrón fijo");

    // -------------------------
    // DÍA 21: B sigue impago y termina
    // -------------------------
    const day21 = localDate(periodKey, 21, "09:00:00");
    const terminateResult = await terminateUnpaidSubscriptions({
      periodKey,
      now: day21,
      force: false,
    });

    const afterDay21A = await snapshotScenario(scenarioA, periodKey, day21);
    const afterDay21B = await snapshotScenario(scenarioB, periodKey, day21);

    report.stages.push({
      stage: "day_21_termination",
      now: iso(day21),
      result: terminateResult,
      snapshots: { A: afterDay21A, B: afterDay21B },
    });

    check(terminateResult?.terminated === 1, "Día 21: termina únicamente el plan B impago");
    check(afterDay21A.subscription.status === "active", "Día 21: A pagado sigue activo");
    check(afterDay21A.cycle?.billingStatus === "paid", "Día 21: A sigue paid");
    check(afterDay21A.fixedSchedule.active === true, "Día 21: A conserva patrón fijo");
    check(afterDay21A.appointment.status === "reserved", "Día 21: A conserva cita futura");

    check(
      afterDay21B.subscription.status === "terminated_for_non_payment",
      "Día 21: B queda terminated_for_non_payment"
    );
    check(afterDay21B.subscription.autoRenew === false, "Día 21: B desactiva autoRenew");
    check(afterDay21B.cycle?.planStatus === "terminated", "Día 21: ciclo B queda terminated");
    check(afterDay21B.fixedSchedule.active === false, "Día 21: B libera/desactiva patrón fijo");
    check(afterDay21B.appointment.status === "cancelled", "Día 21: B cancela/libera cita fija futura");
    check(afterDay21B.user.creditsField === 0, "Día 21: B invalida saldo remanente sin quedar negativo");
    check(afterDay21B.user.cycleLotRemaining === 0, "Día 21: lote del ciclo B queda en 0");

    const AResolved = afterPayA.notices.filter(
      (n) => ["payment_pending", "suspended"].includes(n.type)
    );
    check(
      AResolved.every((n) => n.status === "resolved"),
      "Pago: avisos pending/suspended de A quedan resueltos"
    );
    check(
      afterPayA.notices.some((n) => n.type === "reactivated"),
      "Pago: A recibe aviso interno de reactivación"
    );
    check(
      afterDay21B.notices.some((n) => n.type === "terminated"),
      "Día 21: B recibe aviso interno de baja"
    );

    report.ok = true;
    console.log("\n🎉 SIMULACIÓN COMPLETA: TODAS LAS VALIDACIONES PASARON.");
  }
} catch (error) {
  report.ok = false;
  report.error = {
    message: error?.message || String(error),
    stack: error?.stack || "",
  };
  console.error("\n❌ SIMULACIÓN FALLÓ:", error?.message || error);
  process.exitCode = 1;
} finally {
  // Solo hay documentos temporales si se ejecutó --apply.
  if (apply && (createdUserIds.length || createdSubscriptionIds.length)) {
    try {
      report.cleanup = await cleanup({
        userIds: createdUserIds,
        subscriptionIds: createdSubscriptionIds,
        periodKey,
      });
      console.log("\n🧹 Limpieza automática:", report.cleanup);

      const remainingCycles = await SubscriptionBillingCycle.countDocuments({ periodKey });
      report.safety.remainingCyclesAfterCleanup = remainingCycles;

      if (remainingCycles !== 0) {
        report.ok = false;
        report.cleanupWarning = `Quedaron ${remainingCycles} ciclos en ${periodKey}. Revisar manualmente.`;
        console.error(`⚠️ ${report.cleanupWarning}`);
        process.exitCode = 1;
      } else {
        console.log(`✅ Periodo ${periodKey} volvió a quedar sin ciclos.`);
      }
    } catch (cleanupError) {
      report.ok = false;
      report.cleanupError = cleanupError?.message || String(cleanupError);
      console.error("❌ Error durante cleanup:", report.cleanupError);
      process.exitCode = 1;
    }
  }

  if (outFile) {
    try {
      fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
      console.log(`📄 Reporte guardado en ${outFile}`);
    } catch (writeError) {
      console.error("⚠️ No se pudo guardar el reporte:", writeError?.message || writeError);
      process.exitCode = 1;
    }
  }

  await mongoose.disconnect();
}
