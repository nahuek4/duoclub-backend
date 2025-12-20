// backend/src/seed/seedPricing.js
import dotenv from "dotenv";
import connectDB from "../config/db.js";
import PricingPlan from "../models/PricingPlan.js";

dotenv.config();

const plans = [
  // MP - EP
  { serviceKey: "EP", payMethod: "MP", credits: 4, price: 70000 },
  { serviceKey: "EP", payMethod: "MP", credits: 8, price: 120000 },
  { serviceKey: "EP", payMethod: "MP", credits: 12, price: 180000 },

  // MP - RF
  { serviceKey: "RF", payMethod: "MP", credits: 4, price: 90000 },
  { serviceKey: "RF", payMethod: "MP", credits: 8, price: 160000 },
  { serviceKey: "RF", payMethod: "MP", credits: 12, price: 240000 },

  // MP - AR
  { serviceKey: "AR", payMethod: "MP", credits: 4, price: 110000 },
  { serviceKey: "AR", payMethod: "MP", credits: 8, price: 200000 },
  { serviceKey: "AR", payMethod: "MP", credits: 12, price: 300000 },

  // MP - RA
  { serviceKey: "RA", payMethod: "MP", credits: 1, price: 35000 },
  { serviceKey: "RA", payMethod: "MP", credits: 5, price: 150000 },
  { serviceKey: "RA", payMethod: "MP", credits: 10, price: 250000 },

  // MP - NUT
  { serviceKey: "NUT", payMethod: "MP", credits: 1, price: 30000, label: "Sesión" },

  // CASH - EP
  { serviceKey: "EP", payMethod: "CASH", credits: 4, price: 60000 },
  { serviceKey: "EP", payMethod: "CASH", credits: 8, price: 100000 },
  { serviceKey: "EP", payMethod: "CASH", credits: 12, price: 150000 },

  // CASH - RF
  { serviceKey: "RF", payMethod: "CASH", credits: 4, price: 80000 },
  { serviceKey: "RF", payMethod: "CASH", credits: 8, price: 140000 },
  { serviceKey: "RF", payMethod: "CASH", credits: 12, price: 210000 },

  // CASH - AR
  { serviceKey: "AR", payMethod: "CASH", credits: 4, price: 100000 },
  { serviceKey: "AR", payMethod: "CASH", credits: 8, price: 160000 },
  { serviceKey: "AR", payMethod: "CASH", credits: 12, price: 240000 },

  // CASH - RA
  { serviceKey: "RA", payMethod: "CASH", credits: 1, price: 30000 },
  { serviceKey: "RA", payMethod: "CASH", credits: 5, price: 137500 },
  { serviceKey: "RA", payMethod: "CASH", credits: 10, price: 250000 },

  // CASH - NUT
  { serviceKey: "NUT", payMethod: "CASH", credits: 1, price: 30000, label: "Sesión" },
];

async function run() {
  await connectDB();

  // upsert para no duplicar
  for (const p of plans) {
    await PricingPlan.findOneAndUpdate(
      { serviceKey: p.serviceKey, payMethod: p.payMethod, credits: p.credits },
      { $set: { ...p, active: true } },
      { upsert: true, new: true }
    );
  }

  console.log("✅ Pricing seed completado.");
  process.exit(0);
}

run().catch((e) => {
  console.error("❌ Seed error:", e);
  process.exit(1);
});
