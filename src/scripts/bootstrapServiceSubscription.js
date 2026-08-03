// backend/scripts/bootstrapServiceSubscription.js
// Inicializa UNA suscripción vinculada a un plan publicado.
// Por defecto solo previsualiza.
//
// Previsualizar:
// node scripts/bootstrapServiceSubscription.js \
//   --user=mail@ejemplo.com --service=EP --month=2026-09 --plan=ID_PLAN
//
// Aplicar:
// agregar --apply --confirm=CREATE_INITIAL_SUBSCRIPTION
//
// Rollback:
// node scripts/bootstrapServiceSubscription.js --rollback=ID_SUSCRIPCION
// agregar --apply --confirm=ROLLBACK_INITIAL_SUBSCRIPTION para aplicar.

import crypto from "node:crypto";
import dotenv from "dotenv";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import FixedSchedule from "../src/models/FixedSchedule.js";
import ScheduleBlock from "../src/models/ScheduleBlock.js";
import PricingPlan from "../src/models/PricingPlan.js";
import Order from "../src/models/Order.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";
import {
  isValidMonthKey,
  monthRangeFromKey,
  normalizeServiceKey,
} from "../src/services/subscriptions/fixedScheduleCoverage.js";
import {
  buildInitialSubscriptionCandidate,
  buildServiceSubscriptionCreatePayload,
  canRollbackBootstrapSubscription,
} from "../src/services/subscriptions/subscriptionBootstrap.js";
import { projectActiveFixedSchedulesForMonth } from "../src/services/subscriptions/subscriptionScheduleProjection.js";

dotenv.config();

const CREATE_CONFIRMATION = "CREATE_INITIAL_SUBSCRIPTION";
const ROLLBACK_CONFIRMATION = "ROLLBACK_INITIAL_SUBSCRIPTION";
const SERVICE_KEYS = new Set(["EP", "RA", "RF", "KD", "SYN", "NUT"]);

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

function toBoolean(value) {
  if (value === true) return true;
  return ["1", "true", "yes", "si", "sí"].includes(clean(value).toLowerCase());
}

function blockQuery(startYmd, endYmd) {
  return {
    active: true,
    dateFrom: { $lte: endYmd },
    $or: [
      { indefinite: true },
      { dateTo: { $gte: startYmd } },
      { dateTo: "" },
      { dateTo: { $exists: false } },
    ],
  };
}

function paidOrderQuery(userId, serviceKey) {
  return {
    user: userId,
    status: { $in: ["paid", "approved"] },
    $or: [
      {
        items: {
          $elemMatch: {
            kind: { $in: ["CREDITS", "MANUAL_SERVICE"] },
            serviceKey,
          },
        },
      },
      { serviceKey },
    ],
  };
}

async function findUser(value) {
  const raw = clean(value);
  if (!raw) return null;
  if (mongoose.Types.ObjectId.isValid(raw)) return User.findById(raw).lean();
  return User.findOne({ email: raw.toLowerCase() }).lean();
}

const args = parseArgs(process.argv.slice(2));
const mongoUri =
  process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;

if (!mongoUri) {
  console.error("No se encontró MONGO_URI/MONGODB_URI/MONGO_URL.");
  process.exit(1);
}

await mongoose.connect(mongoUri);

try {
  if (args.rollback) {
    const subscriptionId = clean(args.rollback);
    if (!mongoose.Types.ObjectId.isValid(subscriptionId)) {
      throw new Error("ID de suscripción inválido.");
    }

    const subscription = await ServiceSubscription.findById(subscriptionId).lean();
    const billingCyclesCount = subscription
      ? await SubscriptionBillingCycle.countDocuments({ subscription: subscriptionId })
      : 0;
    const rollback = canRollbackBootstrapSubscription({
      subscription,
      billingCyclesCount,
    });

    console.log(
      JSON.stringify(
        {
          mode: "rollback",
          dryRun: !toBoolean(args.apply),
          rollback,
          subscription,
          billingCyclesCount,
        },
        null,
        2
      )
    );

    if (!rollback.allowed) process.exitCode = 2;
    else if (toBoolean(args.apply)) {
      if (clean(args.confirm) !== ROLLBACK_CONFIRMATION) {
        throw new Error(`Para aplicar usá --confirm=${ROLLBACK_CONFIRMATION}`);
      }
      await ServiceSubscription.deleteOne({ _id: subscriptionId });
      console.log("✅ Rollback aplicado. El sistema legacy no fue modificado.");
    }
  } else {
    const user = await findUser(args.user);
    if (!user) throw new Error("Usuario no encontrado. Usá --user=email o ID.");

    const serviceKey = normalizeServiceKey(args.service);
    if (!SERVICE_KEYS.has(serviceKey)) {
      throw new Error("Servicio inválido. Usá EP, RA, RF, KD, SYN o NUT.");
    }

    const monthKey = clean(args.month);
    if (!isValidMonthKey(monthKey)) {
      throw new Error("Mes inválido. Usá --month=YYYY-MM.");
    }

    const planId = clean(args.plan);
    if (!mongoose.Types.ObjectId.isValid(planId)) {
      throw new Error(
        "Debés indicar --plan con el ObjectId de un plan activo publicado."
      );
    }

    if (args.sessions !== undefined || args.price !== undefined || args.pay !== undefined) {
      throw new Error(
        "Ya no se permiten planes manuales. Usá únicamente --plan=ID_PLAN_PUBLICADO."
      );
    }

    const range = monthRangeFromKey(monthKey);

    const [schedules, blocks, pricingPlans, existingSubscription, latestPaidOrder] =
      await Promise.all([
        FixedSchedule.find({
          user: user._id,
          active: true,
          serviceKey,
          startDate: { $lte: range.endYmd },
        }).lean(),
        ScheduleBlock.find(blockQuery(range.startYmd, range.endYmd)).lean(),
        PricingPlan.find({
          active: true,
          serviceKey,
          isCustom: { $ne: true },
        }).lean(),
        ServiceSubscription.findOne({ user: user._id, serviceKey }).lean(),
        Order.findOne(paidOrderQuery(user._id, serviceKey))
          .sort({ paidAt: -1, createdAt: -1 })
          .lean(),
      ]);

    const projection = projectActiveFixedSchedulesForMonth({
      schedules,
      monthKey,
      serviceKey,
    });

    const candidate = buildInitialSubscriptionCandidate({
      user,
      serviceKey,
      monthKey,
      schedules: projection.projectedSchedules,
      blocks,
      pricingPlans,
      selectedPricingPlanId: planId,
      autoRenew: args.autoRenew === undefined ? true : toBoolean(args.autoRenew),
      existingSubscription,
      latestPaidOrder,
      includeCustomPlans: false,
    });

    console.log(
      JSON.stringify(
        {
          mode: "bootstrap_published_plan",
          dryRun: !toBoolean(args.apply),
          projection: {
            diagnostics: projection.diagnostics,
            excludedSchedules: projection.excludedSchedules,
          },
          candidate,
        },
        null,
        2
      )
    );

    if (!candidate.canCreate) {
      process.exitCode = 2;
    } else if (toBoolean(args.apply)) {
      if (clean(args.confirm) !== CREATE_CONFIRMATION) {
        throw new Error(`Para aplicar usá --confirm=${CREATE_CONFIRMATION}`);
      }

      const payload = buildServiceSubscriptionCreatePayload(candidate, {
        actorId: null,
        batchId: clean(args.batch) || crypto.randomUUID(),
        notes: clean(args.notes),
      });

      const created = await ServiceSubscription.create(payload);
      console.log(`✅ Suscripción creada: ${created._id}`);
      console.log(
        `Plan base: ${created.monthlySessions} sesiones. ` +
          `Adicionales requeridas en ${monthKey}: ${candidate.coverage.extraSessionsRequired}.`
      );
      console.log("No se modificaron créditos, deuda, turnos, órdenes ni ciclos.");
    }
  }
} finally {
  await mongoose.disconnect();
}
