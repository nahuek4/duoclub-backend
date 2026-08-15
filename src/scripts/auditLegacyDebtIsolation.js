import dotenv from "dotenv";
import mongoose from "mongoose";
import User from "../src/models/User.js";
import Appointment from "../src/models/Appointment.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";

dotenv.config();

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
if (!uri) throw new Error("Falta MONGO_URI/MONGODB_URI/MONGO_URL");

await mongoose.connect(uri);

try {
  const debtUsers = await User.find({
    $or: ["EP", "RA", "RF", "KD", "SYN", "NUT"].map((k) => ({
      [`fixedScheduleDebt.${k}`]: { $gt: 0 },
    })),
  })
    .select("name lastName email fixedScheduleDebt")
    .lean();

  const debtAppointments = await Appointment.countDocuments({
    $or: [
      { creditDebitStatus: "debt" },
      { fixedDebtAmount: { $gt: 0 } },
    ],
  });

  const activeSubscriptions = await ServiceSubscription.countDocuments({
    status: { $in: ["active", "pending_change", "suspended"] },
  });

  console.log({
    mode: "read_only",
    legacyDebtUsers: debtUsers.length,
    legacyDebtAppointments: debtAppointments,
    activeOrSuspendedSubscriptions: activeSubscriptions,
    note: "Los saldos legacy se conservan como histórico y no deben modificar créditos, reservas ni renovaciones.",
  });

  if (debtUsers.length) {
    console.table(
      debtUsers.slice(0, 30).map((u) => ({
        usuario: `${u.name || ""} ${u.lastName || ""}`.trim() || u.email || String(u._id),
        email: u.email || "-",
        EP: Number(u.fixedScheduleDebt?.EP || 0),
        RA: Number(u.fixedScheduleDebt?.RA || 0),
        RF: Number(u.fixedScheduleDebt?.RF || 0),
        KD: Number(u.fixedScheduleDebt?.KD || 0),
        SYN: Number(u.fixedScheduleDebt?.SYN || 0),
        NUT: Number(u.fixedScheduleDebt?.NUT || 0),
      }))
    );
  }
} finally {
  await mongoose.disconnect();
}
