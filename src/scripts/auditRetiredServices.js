import dotenv from "dotenv";
import mongoose from "mongoose";

import PricingPlan from "../src/models/PricingPlan.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import FixedSchedule from "../src/models/FixedSchedule.js";
import Appointment from "../src/models/Appointment.js";
import User from "../src/models/User.js";

dotenv.config();

const RETIRED = new Set(["PE", "KD", "NUT"]);
const ACTIVE = new Set(["EP", "RA", "RF", "SYN"]);

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function serviceKey(value) {
  const raw = String(value || "").trim();
  const up = raw.toUpperCase();
  if ([...RETIRED, ...ACTIVE].includes(up)) return up;

  const s = stripAccents(raw).toLowerCase();
  if (s.includes("primera") && s.includes("evaluacion")) return "PE";
  if (s.includes("entrenamiento") && s.includes("personal")) return "EP";
  if (s.includes("rehabilitacion") && s.includes("activa")) return "RA";
  if (s.includes("reeducacion") && s.includes("funcional")) return "RF";
  if (s.includes("kinefilaxia") || (s.includes("kine") && s.includes("deport"))) return "KD";
  if (s.includes("synergy") || s.includes("sinergia")) return "SYN";
  if (s.includes("nutric")) return "NUT";
  return "";
}

function apKey(ap) {
  return serviceKey(ap?.serviceKey || ap?.serviceName || ap?.service || "");
}

function lotKey(lot) {
  return serviceKey(lot?.serviceKey || lot?.serviceName || lot?.service || "");
}

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
if (!uri) {
  console.error("❌ No encontré MONGO_URI / MONGODB_URI / MONGO_URL en .env");
  process.exit(1);
}

await mongoose.connect(uri);

try {
  const today = todayYmd();
  const now = new Date();

  const [pricing, subscriptions, fixedSchedules, futureAppointments, users] = await Promise.all([
    PricingPlan.find({ serviceKey: { $in: [...RETIRED] }, active: true })
      .select("serviceKey credits payMethod price label customTitle isCustom active")
      .lean(),
    ServiceSubscription.find({
      serviceKey: { $in: [...RETIRED] },
      status: { $in: ["active", "pending_change", "suspended"] },
    })
      .select("user serviceKey status autoRenew monthlySessions price payMethod")
      .populate("user", "name lastName fullName email")
      .lean(),
    FixedSchedule.find({ serviceKey: { $in: [...RETIRED] }, active: true })
      .select("user serviceKey service items startDate endDate active")
      .populate("user", "name lastName fullName email")
      .lean(),
    Appointment.find({
      status: "reserved",
      date: { $gte: today },
      $or: [
        { serviceKey: { $in: [...RETIRED] } },
        { service: { $regex: /primera evaluaci|kinefilax|nutric/i } },
        { serviceName: { $regex: /primera evaluaci|kinefilax|nutric/i } },
      ],
    })
      .select("user date time service serviceName serviceKey status fixedScheduleId")
      .populate("user", "name lastName fullName email")
      .lean(),
    User.find({
      creditLots: {
        $elemMatch: {
          remaining: { $gt: 0 },
          serviceKey: { $in: [...RETIRED] },
        },
      },
    })
      .select("name lastName fullName email creditLots")
      .lean(),
  ]);

  const activeCreditRows = [];
  for (const user of users) {
    for (const lot of Array.isArray(user.creditLots) ? user.creditLots : []) {
      const sk = lotKey(lot);
      const remaining = Number(lot?.remaining || 0);
      if (!RETIRED.has(sk) || remaining <= 0) continue;
      const exp = lot?.expiresAt ? new Date(lot.expiresAt) : null;
      if (exp && !Number.isNaN(exp.getTime()) && exp <= now) continue;

      activeCreditRows.push({
        usuario: user.fullName || [user.name, user.lastName].filter(Boolean).join(" ") || user.email,
        email: user.email,
        servicio: sk,
        sesiones: remaining,
        vence: lot?.expiresAt || null,
      });
    }
  }

  const appointmentRows = futureAppointments
    .map((ap) => ({
      usuario:
        ap?.user?.fullName ||
        [ap?.user?.name, ap?.user?.lastName].filter(Boolean).join(" ") ||
        ap?.user?.email ||
        String(ap.user || ""),
      email: ap?.user?.email || "",
      servicio: apKey(ap),
      fecha: ap.date,
      hora: ap.time,
      fijo: Boolean(ap.fixedScheduleId),
    }))
    .filter((row) => RETIRED.has(row.servicio));

  const summary = {
    mode: "read_only",
    retiredServices: [...RETIRED],
    activeServices: [...ACTIVE],
    activeRetiredPricingPlans: pricing.length,
    activeOrSuspendedRetiredSubscriptions: subscriptions.length,
    activeRetiredFixedSchedules: fixedSchedules.length,
    futureReservedRetiredAppointments: appointmentRows.length,
    usersWithUnexpiredRetiredCredits: new Set(activeCreditRows.map((x) => x.email)).size,
    unexpiredRetiredCreditLots: activeCreditRows.length,
    totalUnexpiredRetiredSessions: activeCreditRows.reduce((a, x) => a + Number(x.sesiones || 0), 0),
  };

  console.log("\n=== AUDITORÍA DE SERVICIOS RETIRADOS ===");
  console.log(summary);

  if (pricing.length) {
    console.log("\nPLANES PUBLICADOS ACTIVOS A DESACTIVAR");
    console.table(
      pricing.map((p) => ({
        id: String(p._id),
        servicio: p.serviceKey,
        sesiones: p.credits,
        pago: p.payMethod,
        precio: p.price,
        personalizado: Boolean(p.isCustom),
      }))
    );
  }

  if (subscriptions.length) {
    console.log("\n⚠️ SUSCRIPCIONES RETIRADAS TODAVÍA OPERATIVAS");
    console.table(
      subscriptions.map((s) => ({
        id: String(s._id),
        usuario: s?.user?.fullName || [s?.user?.name, s?.user?.lastName].filter(Boolean).join(" ") || s?.user?.email,
        email: s?.user?.email || "",
        servicio: s.serviceKey,
        estado: s.status,
        autoRenew: s.autoRenew,
        sesiones: s.monthlySessions,
      }))
    );
  }

  if (fixedSchedules.length) {
    console.log("\n⚠️ TURNOS FIJOS ACTIVOS DE SERVICIOS RETIRADOS");
    console.table(
      fixedSchedules.map((fs) => ({
        id: String(fs._id),
        usuario: fs?.user?.fullName || [fs?.user?.name, fs?.user?.lastName].filter(Boolean).join(" ") || fs?.user?.email,
        email: fs?.user?.email || "",
        servicio: fs.serviceKey || serviceKey(fs.service),
        patrones: Array.isArray(fs.items) ? fs.items.length : 0,
      }))
    );
  }

  if (appointmentRows.length) {
    console.log("\n⚠️ TURNOS FUTUROS RESERVADOS DE SERVICIOS RETIRADOS");
    console.table(appointmentRows.slice(0, 100));
    if (appointmentRows.length > 100) console.log(`... y ${appointmentRows.length - 100} más.`);
  }

  if (activeCreditRows.length) {
    console.log("\n⚠️ CRÉDITOS VIGENTES DE SERVICIOS RETIRADOS");
    console.table(activeCreditRows.slice(0, 100));
    if (activeCreditRows.length > 100) console.log(`... y ${activeCreditRows.length - 100} más.`);
  }

  console.log("\n✅ Auditoría finalizada. No se modificó MongoDB.");
} finally {
  await mongoose.disconnect();
}
