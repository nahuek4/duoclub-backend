import assert from "node:assert/strict";
import router from "../src/routes/subscriptions.js";

const routes = router.stack
  .filter((layer) => layer.route)
  .flatMap((layer) =>
    Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`)
  );

for (const expected of [
  "GET /me",
  "POST /:id/change-next",
  "POST /:id/suspend-next",
  "POST /:id/cancel-next",
  "POST /:id/clear-change",
]) {
  assert.ok(routes.includes(expected), `Falta la ruta ${expected}`);
}

console.log("✅ subscriptionUserChanges: cambio/suspensión/cancelación y deshacer están disponibles.");
