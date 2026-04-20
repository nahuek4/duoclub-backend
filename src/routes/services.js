// backend/src/routes/services.js
import express from "express";

const router = express.Router();

const SERVICES = [
  {
    serviceKey: "PE",
    name: "Primera evaluación presencial",
    description:
      "Evaluación inicial obligatoria antes de reservar el resto de los servicios.",
    duration: 60,
    active: true,
    category: "evaluation",
  },
  {
    serviceKey: "EP",
    name: "Entrenamiento Personal",
    description:
      "Sesiones personalizadas de entrenamiento con seguimiento profesional.",
    duration: 60,
    active: true,
    category: "training",
  },
  {
    serviceKey: "RA",
    name: "Rehabilitación Activa",
    description:
      "Proceso de rehabilitación con trabajo activo y progresivo según objetivos terapéuticos.",
    duration: 60,
    active: true,
    category: "therapy",
  },
  {
    serviceKey: "RF",
    name: "Reeducación Funcional",
    description:
      "Sesiones orientadas a recuperar función, control y movimiento según cada caso.",
    duration: 60,
    active: true,
    category: "therapy",
  },
  {
    serviceKey: "NUT",
    name: "Nutrición",
    description:
      "Consultas y seguimiento nutricional adaptado a cada persona.",
    duration: 60,
    active: true,
    category: "nutrition",
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
