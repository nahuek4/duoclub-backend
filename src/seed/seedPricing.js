// backend/src/seed/seedPricing.js
import mongoose from "mongoose";
import dotenv from "dotenv";
import PricingPlan from "../models/PricingPlan.js";

dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ MONGO_URI no definido en .env");
  process.exit(1);
}

/**
 * ⚙️ ACÁ DEFINÍS LOS PLANES QUE QUERÉS SEMBRAR / ACTUALIZAR.
 * - Si el plan existe (mismo serviceKey + payMethod + credits) => lo actualiza
 * - Si no existe => lo crea
 *
 * ✅ Para DUO+ usamos:
 * serviceKey: "PLUS"
 * credits: 1
 * price: 20000
 */
const PLANS = [
  // =========================
  // DUO+ Membresía Mensual
  // =========================
  {
    serviceKey: "PLUS",
    payMethod: "CASH",
    credits: 1,
    price: 20000,
    label: "DUO+ mensual",
    active: true,
  },
  {
    serviceKey: "PLUS",
    payMethod: "MP",
    credits: 1,
    price: 20000,
    label: "DUO+ mensual",
    active: true,
  },

  // =========================
  // (Opcional) Ejemplo: otros planes
  // Descomentá y poné tus precios reales si querés.
  // =========================
  // {
  //   serviceKey: "EP",
  //   payMethod: "CASH",
  //   credits: 8,
  //   price: 100000,
  //   label: "8 créditos",
  //   active: true,
  // },
  // {
  //   serviceKey: "EP",
  //   payMethod: "MP",
  //   credits: 8,
  //   price: 110000,
  //   label: "8 créditos",
  //   active: true,
  // },
];

async function run() {
  console.log("🔌 Conectando a MongoDB...");
  await mongoose.connect(MONGO_URI);
  console.log("✅ Conectado");

  let upserts = 0;

  for (const p of PLANS) {
    const serviceKey = String(p.serviceKey || "").toUpperCase().trim();
    const payMethod = String(p.payMethod || "").toUpperCase().trim();
    const credits = Number(p.credits);

    if (!serviceKey || !payMethod || !credits) {
      console.warn("⚠️ Plan inválido (saltado):", p);
      continue;
    }

    const patch = {
      serviceKey,
      payMethod,
      credits,
      price: Number(p.price || 0),
      label: p.label || "",
      active: Boolean(p.active),
    };

    await PricingPlan.updateOne(
      { serviceKey, payMethod, credits },
      { $set: patch },
      { upsert: true }
    );

    upserts++;
    console.log(
      `✅ Upsert: ${serviceKey} | ${payMethod} | credits=${credits} | price=${patch.price} | active=${patch.active}`
    );
  }

  console.log(`\n🎉 Listo. Upserts realizados: ${upserts}`);
  await mongoose.disconnect();
  console.log("🔌 Desconectado");
}

run().catch((err) => {
  console.error("❌ Error en seedPricing:", err);
  process.exit(1);
});
