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
      suspended: false
    }
  ],
  appointments: [],
  services: [
    { key: "Entrenamiento", name: "Entrenamiento personal", color: "#0d6efd" },
    { key: "Rehabilitacion", name: "Rehabilitación", color: "#20c997" },
    { key: "Nutricion", name: "Nutrición", color: "#6610f2" },
    { key: "Alto Rendimiento", name: "Alto rendimiento", color: "#fd7e14" },
    { key: "Cardiologia", name: "Cardiología", color: "#dc3545" },
    { key: "Evaluacion", name: "Evaluación inicial", color: "#6c757d" }
  ],
  coaches: [],
  holidaysAR: []
};
