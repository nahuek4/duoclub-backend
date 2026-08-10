import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

import User from "../src/models/User.js";
import Order from "../src/models/Order.js";
import PricingPlan from "../src/models/PricingPlan.js";
import Appointment from "../src/models/Appointment.js";
import {
  activateSubscriptionsFromPaidOrder,
  finalizePaidPlanOrder,
} from "../src/services/subscriptions/subscriptionPlanPurchase.js";
import { syncExtraSessionNoticeForUserService } from "../src/services/subscriptions/subscriptionExtraSessions.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const raw = arg.replace(/^--/, "");
    const idx = raw.indexOf("=");
    return idx >= 0 ? [raw.slice(0, idx), raw.slice(idx + 1)] : [raw, true];
  })
);

const email = String(args.email || "").trim().toLowerCase();
const serviceKey = String(args.service || "EP").trim().toUpperCase();
const apply = Boolean(args.apply);
const confirm = String(args.confirm || "");

if (!email) {
  console.error("Falta --email=usuario@dominio.com");
  process.exit(1);
}

if (apply && confirm !== "REPAIR_SUBSCRIPTION_COVERAGE") {
  console.error("Para aplicar falta --confirm=REPAIR_SUBSCRIPTION_COVERAGE");
  process.exit(1);
}

function pad2(n) { return String(n).padStart(2, "0"); }
function monthKeyNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}`;
}
function monthBounds(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${y}-${pad2(m)}-01`, end: `${y}-${pad2(m)}-${pad2(last)}` };
}
function itemInfo(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const item = items.find(
    (it) => String(it?.kind || "").toUpperCase() === "CREDITS" && String(it?.serviceKey || "").toUpperCase() === serviceKey
  );
  if (item) {
    return {
      credits: Math.max(0, Math.trunc(Number(item.credits || 0))),
      pricingPlanId: item.pricingPlanId ? String(item.pricingPlanId) : "",
      price: Number(item.price || 0),
    };
  }
  if (String(order?.serviceKey || "").toUpperCase() === serviceKey) {
    return {
      credits: Math.max(0, Math.trunc(Number(order.credits || 0))),
      pricingPlanId: "",
      price: Number(order.price || order.totalFinal || order.total || 0),
    };
  }
  return null;
}
function recalcCredits(user) {
  const now = new Date();
  user.credits = (Array.isArray(user.creditLots) ? user.creditLots : []).reduce((sum, lot) => {
    const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
    if (exp && exp <= now) return sum;
    return sum + Math.max(0, Number(lot?.remaining || 0));
  }, 0);
}

const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
if (!mongoUri) throw new Error("No encontré MONGO_URI/MONGODB_URI/MONGO_URL");

await mongoose.connect(mongoUri);

try {
  const user = await User.findOne({ email });
  if (!user) throw new Error(`Usuario no encontrado: ${email}`);

  const orders = await Order.find({
    user: user._id,
    status: { $in: ["paid", "approved"] },
  }).sort({ paidAt: -1, updatedAt: -1, createdAt: -1 });

  const order = orders.find((candidate) => itemInfo(candidate)?.credits > 0);
  if (!order) throw new Error(`No encontré una compra pagada de ${serviceKey}.`);

  const info = itemInfo(order);
  let plan = null;
  if (mongoose.Types.ObjectId.isValid(info.pricingPlanId)) {
    plan = await PricingPlan.findOne({
      _id: info.pricingPlanId,
      active: true,
      isCustom: { $ne: true },
      serviceKey,
      credits: info.credits,
      payMethod: order.payMethod,
    });
  }
  if (!plan) {
    const matches = await PricingPlan.find({
      active: true,
      isCustom: { $ne: true },
      serviceKey,
      credits: info.credits,
      payMethod: order.payMethod,
    });
    if (matches.length === 1) plan = matches[0];
  }
  if (!plan) throw new Error("La compra pagada no coincide con un plan publicado activo.");

  const periodKey = monthKeyNow();
  const range = monthBounds(periodKey);
  const appointments = await Appointment.find({
    user: user._id,
    serviceKey,
    fixedScheduleId: { $ne: null },
    status: "reserved",
    date: { $gte: range.start, $lte: range.end },
  }).sort({ date: 1, time: 1 });

  const debtBefore = Math.max(0, Number(user.fixedScheduleDebt?.[serviceKey] || 0));
  const alreadyCovered = appointments.filter((ap) => ["monthly_reserved", "debited"].includes(String(ap.creditDebitStatus || ""))).length;
  const targetCovered = Math.min(Number(plan.credits || 0), appointments.length);
  const pendingTarget = Math.max(0, appointments.length - targetCovered);

  console.log({
    mode: apply ? "apply" : "dry_run",
    email,
    serviceKey,
    orderId: String(order._id),
    pricingPlanId: String(plan._id),
    planSessions: plan.credits,
    periodKey,
    fixedAppointments: appointments.length,
    alreadyCovered,
    targetCovered,
    pendingTarget,
    fixedScheduleDebtBefore: debtBefore,
    visibleCreditsBefore: Number(user.credits || 0),
  });

  if (!apply) process.exit(0);

  const activation = await activateSubscriptionsFromPaidOrder({ order });
  if (!activation.activated?.length) {
    throw new Error("No se pudo activar la suscripción desde la compra pagada.");
  }

  user.fixedScheduleDebt = user.fixedScheduleDebt || {};
  user.fixedScheduleDebt[serviceKey] = 0;
  user.markModified?.("fixedScheduleDebt");

  let coveredCount = 0;
  for (const ap of appointments) {
    if (coveredCount < targetCovered) {
      ap.creditDebitStatus = "monthly_reserved";
      ap.fixedDebtAmount = 0;
      ap.fixedDebitProcessedAt = ap.fixedDebitProcessedAt || new Date();
      ap.creditDebitedAt = ap.creditDebitedAt || new Date();
      coveredCount += 1;
    } else {
      ap.creditDebitStatus = "pending";
      ap.fixedDebtAmount = 0;
      ap.creditLotId = null;
      ap.creditExpiresAt = null;
      ap.creditDebitedAt = null;
      ap.fixedDebitProcessedAt = null;
    }
    await ap.save();
  }

  user.history = Array.isArray(user.history) ? user.history : [];
  user.history.push({
    action: "subscription_coverage_repair",
    title: `Reparación de cobertura de suscripción ${serviceKey}`,
    message: `Se eliminó deuda legacy del período ${periodKey}. ${targetCovered} turno(s) quedaron cubiertos por el plan y ${pendingTarget} pendiente(s) de adicional.`,
    serviceKey,
    qty: 0,
    createdAt: new Date(),
  });
  recalcCredits(user);
  await user.save();

  await finalizePaidPlanOrder({ order, activated: activation.activated });
  const notice = await syncExtraSessionNoticeForUserService({
    userId: user._id,
    serviceKey,
    source: "repair_subscription_coverage",
  });

  const fresh = await User.findById(user._id).lean();
  console.log({
    repaired: true,
    visibleCreditsAfter: Number(fresh?.credits || 0),
    fixedScheduleDebtAfter: Number(fresh?.fixedScheduleDebt?.[serviceKey] || 0),
    notice: {
      skipped: Boolean(notice?.skipped),
      periodKey: notice?.periodKey,
      basePlanSessions: notice?.basePlanSessions,
      projectedFixedOccurrences: notice?.projectedFixedOccurrences,
      remainingSessions: notice?.remainingSessions,
      status: notice?.status,
    },
  });
} finally {
  await mongoose.disconnect();
}
