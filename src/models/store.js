export const SERVICE_KEYS = Object.freeze({
  PE: "PE",
  EP: "EP",
  RA: "RA",
  RF: "RF",
  NUT: "NUT",
});

export const SERVICE_LABELS = Object.freeze({
  PE: "Primera evaluación presencial",
  EP: "Entrenamiento Personal",
  RA: "Rehabilitación Activa",
  RF: "Reeducación Funcional",
  NUT: "Nutrición",
});

export const db = {
  users: [
    {
      id: "admin-1",
      name: "Admin",
      email: "admin@admin.com",
      password: "admin123",
      role: "admin",
      credits: 0,
      mustChangePassword: false,
      history: [],
      phone: "",
      dni: "",
      notes: "",
      aptoPath: null,
      aptoStatus: null,
      createdAt: new Date().toISOString(),
      suspended: false,
    },
  ],

  appointments: [],

  services: [
    {
      id: SERVICE_KEYS.PE,
      key: SERVICE_KEYS.PE,
      serviceKey: SERVICE_KEYS.PE,
      name: SERVICE_LABELS.PE,
      label: SERVICE_LABELS.PE,
      color: "#6c757d",
      active: true,
    },
    {
      id: SERVICE_KEYS.EP,
      key: SERVICE_KEYS.EP,
      serviceKey: SERVICE_KEYS.EP,
      name: SERVICE_LABELS.EP,
      label: SERVICE_LABELS.EP,
      color: "#0d6efd",
      active: true,
    },
    {
      id: SERVICE_KEYS.RA,
      key: SERVICE_KEYS.RA,
      serviceKey: SERVICE_KEYS.RA,
      name: SERVICE_LABELS.RA,
      label: SERVICE_LABELS.RA,
      color: "#20c997",
      active: true,
    },
    {
      id: SERVICE_KEYS.RF,
      key: SERVICE_KEYS.RF,
      serviceKey: SERVICE_KEYS.RF,
      name: SERVICE_LABELS.RF,
      label: SERVICE_LABELS.RF,
      color: "#fd7e14",
      active: true,
    },
    {
      id: SERVICE_KEYS.NUT,
      key: SERVICE_KEYS.NUT,
      serviceKey: SERVICE_KEYS.NUT,
      name: SERVICE_LABELS.NUT,
      label: SERVICE_LABELS.NUT,
      color: "#6610f2",
      active: true,
    },
  ],

  coaches: [],
  holidaysAR: [],
};

export default db;
