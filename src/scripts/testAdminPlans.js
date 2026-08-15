import assert from "node:assert/strict";
import router from "../src/routes/adminPlans.js";

const routes = router.stack
  .filter((layer) => layer.route)
  .flatMap((layer) =>
    Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`)
  );

for (const expected of [
  "GET /catalog",
  "GET /",
  "GET /:id",
  "POST /:id/change-next",
  "POST /:id/suspend",
  "POST /:id/reactivate",
  "POST /:id/cancel-next",
  "POST /:id/clear-change",
]) {
  assert.ok(routes.includes(expected), `Falta la ruta ${expected}`);
}

console.log("✅ adminPlans: rutas básicas pasaron.");
