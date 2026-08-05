// backend/src/routes/subscriptionExtras.js
import express from "express";

import { protect } from "../middleware/auth.js";
import {
  listExtraSessionNoticesForUser,
  syncExtraSessionNoticeForUserService,
} from "../services/subscriptions/subscriptionExtraSessions.js";

const router = express.Router();
router.use(protect);

router.get("/me", async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const items = await listExtraSessionNoticesForUser(userId);
    return res.json({ ok: true, items });
  } catch (err) {
    console.error("GET /subscription-extras/me:", err);
    return res.status(500).json({
      error: "No se pudieron cargar las sesiones adicionales pendientes.",
    });
  }
});

// Refresco puntual, útil al volver de Mercado Pago o al abrir Comprar.
// Solo recalcula servicios que ya tienen suscripción y turno fijo activo.
router.post("/me/refresh", async (req, res) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const serviceKey = String(req.body?.serviceKey || "").trim();

    if (!serviceKey) {
      return res.status(400).json({ error: "Falta serviceKey." });
    }

    const result = await syncExtraSessionNoticeForUserService({
      userId,
      serviceKey,
      actorId: null,
      source: "manual_refresh",
    });

    const items = await listExtraSessionNoticesForUser(userId);
    return res.json({ ok: true, result, items });
  } catch (err) {
    console.error("POST /subscription-extras/me/refresh:", err);
    return res.status(Number(err?.status || 500)).json({
      error: err?.message || "No se pudo actualizar el faltante de sesiones.",
      code: err?.code || "EXTRA_REFRESH_FAILED",
    });
  }
});

export default router;
