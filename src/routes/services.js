// backend/src/routes/services.js
import express from "express";

const router = express.Router();

const SERVICES = [
  {
    serviceKey: "EP",
    name: "Entrenamiento Personal",
    description:
      "DUO TRAINING · Entrenamiento personalizado con seguimiento profesional.",
    duration: 60,
    active: true,
    category: "training",
  },
  {
    serviceKey: "RA",
    name: "Rehabilitación Activa",
    description:
      "DUO PERFORMANCE · Rehabilitación activa con trabajo progresivo según objetivos terapéuticos.",
    duration: 60,
    active: true,
    category: "performance",
  },
  {
    serviceKey: "RF",
    name: "Reeducación Funcional",
    description:
      "DUO PERFORMANCE · Reeducación funcional orientada a recuperar función, control y movimiento.",
    duration: 60,
    active: true,
    category: "performance",
  },
  {
    serviceKey: "SYN",
    name: "Synergy",
    description:
      "DUO PERFORMANCE · Trabajo integral dentro del salón Performance.",
    duration: 60,
    active: true,
    category: "performance",
  },
];

router.get("/", (req, res) => {
  return res.json(
    SERVICES.map((service) => ({
      serviceKey: service.serviceKey,
      id: service.serviceKey,
      name: service.name,
      label: service.name,
      description: service.description,
      duration: service.duration,
      active: service.active,
      category: service.category,
    }))
  );
});

export default router;
