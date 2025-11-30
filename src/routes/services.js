// backend/src/routes/services.js
import express from "express";

const router = express.Router();

/**
 * GET /services
 * Devolvemos una lista estática de servicios.
 * Ajustamos esto después si querés que salga desde Mongo.
 */
router.get("/", (req, res) => {
  const services = [
    {
      id: "mv",
      name: "Método Villaverde",
      description: "Entrenamiento y rehabilitación personalizada.",
      duration: 60,
    },
    {
      id: "kine",
      name: "Kinesiología",
      description: "Sesiones de kinesiología y recuperación.",
      duration: 45,
    },
    {
      id: "eval",
      name: "Evaluación inicial",
      description: "Evaluación completa del paciente.",
      duration: 60,
    },
  ];

  res.json(services);
});

export default router;
