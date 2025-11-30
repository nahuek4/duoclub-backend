import { sendAppointmentBookedEmail, sendAppointmentCancelledEmail } from "../mail.js";

import { db } from "../models/store.js";
const id = ()=> Math.random().toString(36).slice(2,10);

export const list = (req,res)=>{
  const { from, to } = req.query||{};
  let list = db.appointments;
  if(from) list = list.filter(a=> a.date>=from);
  if(to) list = list.filter(a=> a.date<=to);
  res.json(list);
};

export const create = (req,res)=>{
  const { userId, date, time, service } = req.body||{};
  const u = db.users.find(x=> x.id===userId);
  if(!u) return res.status(400).json({ error:"Usuario inválido" });
  const created = u.createdAt ? new Date(u.createdAt) : null;
  const now = new Date();
  const daysSince = created ? Math.floor((now - created)/(1000*60*60*24)) : 0;
  const requireApto = daysSince > 20 && !u.aptoPath;
  if(u.suspended) return res.status(403).json({ error: "Cuenta suspendida" });
  if(requireApto) return res.status(403).json({ error: "Cuenta suspendida por falta de apto médico" });
  if((u.credits||0) <= 0) return res.status(403).json({ error:"Sin créditos" });
  const ap = { id:id(), userId, date, time, service, reminderSent:false };
  db.appointments.push(ap);
  u.credits = (u.credits||0) - 1;
  u.history = u.history||[];
  u.history.push({ action:"reservado", date, time, service });
  const svc = db.services.find(s=> s.key===service);
  const serviceName = svc ? svc.name : service;
  sendAppointmentBookedEmail(u, ap, serviceName).catch(()=>{});
  res.json(ap);
};

export const cancel = (req,res)=>{
  const ap = db.appointments.find(a=> a.id===req.params.id);
  if(!ap) return res.status(404).json({ error:"No existe" });

  // Control de 24hs antes del turno
  const [year, month, day] = (ap.date || "").split("-").map(Number);
  const [hour, minute] = (ap.time || "").split(":").map(Number);
  const apDate = new Date(year || 0, (month || 1) - 1, day || 1, hour || 0, minute || 0);
  const diffMs = apDate.getTime() - Date.now();
  const hours = diffMs / (1000 * 60 * 60);
  if (hours < 24) {
    return res.status(400).json({
      error: "Solo se puede cancelar el turno con al menos 24 horas de anticipación."
    });
  }

  const u = db.users.find(x=> x.id===ap.userId);
  db.appointments = db.appointments.filter(a=> a.id!==ap.id);
  if(u){
    u.credits = (u.credits||0) + 1;
    u.history = u.history||[];
    u.history.push({ action:"cancelado", date: ap.date, time: ap.time, service: ap.service });
    const svc = db.services.find(s=> s.key===ap.service);
    const serviceName = svc ? svc.name : ap.service;
    sendAppointmentCancelledEmail(u, ap, serviceName).catch(()=>{});
  }
  res.json({ ok:true });
};
