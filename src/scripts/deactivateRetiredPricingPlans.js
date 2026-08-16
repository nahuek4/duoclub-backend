import dotenv from "dotenv";
import mongoose from "mongoose";
import PricingPlan from "../src/models/PricingPlan.js";

dotenv.config();

const RETIRED = ["PE", "KD", "NUT"];
const apply = process.argv.includes("--apply");
const confirmArg = process.argv.find((arg) => arg.startsWith("--confirm="));
const confirm = confirmArg ? confirmArg.split("=").slice(1).join("=") : "";

const uri = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.MONGO_URL;
if (!uri) {
  console.error("❌ No encontré MONGO_URI / MONGODB_URI / MONGO_URL en .env");
  process.exit(1);
}

if (apply && confirm !== "DEACTIVATE_RETIRED_PRICING") {
  console.error("❌ Para aplicar usá --confirm=DEACTIVATE_RETIRED_PRICING");
  process.exit(1);
}

await mongoose.connect(uri);

try {
  const plans = await PricingPlan.find({
    serviceKey: { $in: RETIRED },
    active: true,
  })
    .select("serviceKey credits payMethod price label customTitle isCustom active")
    .lean();

  console.log("\n=== PLANES DE SERVICIOS RETIRADOS ===");
  console.log({ mode: apply ? "apply" : "dry_run", plansToDeactivate: plans.length });

  if (plans.length) {
    console.table(
      plans.map((p) => ({
        id: String(p._id),
        servicio: p.serviceKey,
        sesiones: p.credits,
        pago: p.payMethod,
        precio: p.price,
        personalizado: Boolean(p.isCustom),
      }))
    );
  }

  if (!apply) {
    console.log("\nDRY RUN: no se modificó MongoDB.");
    process.exit(0);
  }

  const result = await PricingPlan.updateMany(
    { _id: { $in: plans.map((p) => p._id) } },
    { $set: { active: false } }
  );

  console.log("\n✅ Planes desactivados:", result.modifiedCount || 0);
  console.log("No se borró ningún plan ni historial.");
} finally {
  await mongoose.disconnect();
}
