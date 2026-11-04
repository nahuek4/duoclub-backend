// Reinicio excepcional del plazo de apto. Sin importar index.js, jobs o correos.
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const DAY = 86400000;
const fields = ['role','approvalStatus','accountDeactivated','accountDeactivatedAt',
  'suspended','suspendedReason','suspendedAt','aptoStatus','aptoPath','aptoCompletedAt',
  'medicalClearance','createdAt','updatedAt','welcomeApprovedEmailSentAt','history'];
export const projection = Object.fromEntries(['_id','name','lastName','email',...fields].map(key=>[key,1]));
const validDate = value => value ? Number.isFinite(new Date(value).getTime()) ? new Date(value) : null : null;

// Los bloqueos históricos sin motivo sólo se incluyen con prueba médica en
// el historial y consulta explícita de la auditoría de cambios manuales.
export async function withSuspensionAudit(db, rows) {
  const legacy=rows.filter(user=>user.suspended && !String(user.suspendedReason || '').trim());
  if(!legacy.length) return rows;
  const ids=legacy.map(user=>String(user._id));
  const legacyIds=new Set(ids);
  const logs=await db.collection('activitylogs').find({action:'user_suspend_updated',
    $or:[{entityId:{$in:[...ids,...legacy.map(user=>user._id)]}},{'subject.id':{$in:ids}}]
  },{projection:{entityId:1,'subject.id':1}}).toArray();
  const manual=new Set(logs.flatMap(log=>[String(log.entityId || ''),String(log.subject?.id || '')]));
  return rows.map(user=>legacyIds.has(String(user._id))
    ? {...user,_resetAudit:{hasManualChange:manual.has(String(user._id))}}
    : user);
}

export function planReset(user, now = new Date()) {
  if (user.role !== 'client' || user.approvalStatus !== 'approved' || user.accountDeactivated || user.accountDeactivatedAt)
    return {eligible:false,reason:'Cuenta no activa/aprobada de cliente'};
  const mc = user.medicalClearance || {};
  const legacyMedical=Boolean(user.suspended && !String(user.suspendedReason || '').trim()
    && user._resetAudit?.hasManualChange===false
    && Array.isArray(user.history) && user.history.some(item=>item.action==='medical_clearance_auto_suspended'));
  const onlyMedicalSuspension=Boolean(user.suspended && (user.suspendedReason==='medical_clearance' || legacyMedical));
  if(mc.status==='approved' && user.aptoStatus==='approved' && onlyMedicalSuspension)
    return {eligible:true,kind:'unlock_approved',set:{suspended:false,suspendedReason:'',suspendedAt:null,updatedAt:new Date(now)}};
  if (mc.status === 'approved' || user.aptoStatus === 'approved' || mc.approvedAt || user.aptoCompletedAt || user.aptoPath === 'ADMIN_COMPLETED_APTO')
    return {eligible:false,reason:'Apto aprobado o con aprobación previa: revisar aparte si hay contradicción'};
  if (mc.status === 'rejected' || user.aptoStatus === 'rejected' || (mc.rejectedAt && !['uploaded','pending_review'].includes(user.aptoStatus) && mc.status !== 'pending_review'))
    return {eligible:false,reason:'Rechazo médico: requiere revisión individual'};
  if (user.suspended && !onlyMedicalSuspension)
    return {eligible:false,reason:!String(user.suspendedReason || '').trim()
      ? 'Suspensión sin motivo: evidencia médica insuficiente o con cambio manual'
      : 'Suspensión por otro motivo'};
  const start = validDate(mc.startedAt) || validDate(user.welcomeApprovedEmailSentAt) || validDate(user.createdAt);
  const due = validDate(mc.dueAt);
  const medicalBlock = mc.status === 'suspended' || onlyMedicalSuspension;
  if (!medicalBlock && !(start && now.getTime()-start.getTime() >= 30*DAY) && !(due && due <= now))
    return {eligible:false,reason:'Plazo todavía vigente o fecha no comprobable'};
  const pending = mc.status === 'pending_review' || ['uploaded','pending_review'].includes(user.aptoStatus) || Boolean(user.aptoPath);
  const status = pending ? 'pending_review' : 'not_submitted';
  const set = {
    'medicalClearance.status':status,
    'medicalClearance.startedAt':new Date(now),
    'medicalClearance.dueAt':new Date(now.getTime()+30*DAY),
    'medicalClearance.approvedAt':null,
    'medicalClearance.rejectedAt':null,
    'medicalClearance.suspendedAt':null,
    'medicalClearance.lastReminder10At':null,
    'medicalClearance.lastReminder20At':null,
    'medicalClearance.lastReminder30At':null,
    'medicalClearance.lastCheckedAt':new Date(now),
    aptoStatus:status,
    updatedAt:new Date(now)
  };
  if (onlyMedicalSuspension) {
    set.suspended=false; set.suspendedReason=''; set.suspendedAt=null;
  }
  return {eligible:true,kind:'restart_grace',set};
}

export function unchangedFilter(user) {
  // Comparación de los valores leídos: una cuenta editada entretanto se omite.
  return {_id:user._id,$and:fields.map(key=>Object.hasOwn(user,key)
    ? {[key]:{$eq:user[key]}}
    : {[key]:{$exists:false}})};
}

export function writeBackup(filename, dbName, rows, now, runId) {
  const payload = {kind:'DUO_MEDICAL_GRACE_RESET',dbName,runId,createdAt:now,users:rows};
  fs.writeFileSync(filename,mongoose.mongo.BSON.EJSON.stringify(payload,null,2,{relaxed:false}),{flag:'wx',mode:0o600});
}

export async function applyResets(collection, rows, {now=new Date(),runId,backupFile,dbName}) {
  if (!runId || !backupFile || !dbName) throw Error('Faltan los datos del respaldo y la operación.');
  const selected=rows.filter(user=>planReset(user,now).eligible);
  if (!selected.length) return {selected:0,updated:0,conflicts:0};
  // El respaldo debe terminar antes de la primera modificación.
  writeBackup(backupFile,dbName,selected,now,runId);
  let updated=0,conflicts=0;
  for (const user of selected) {
    const plan=planReset(user,now);
    const result=await collection.updateOne(unchangedFilter(user),{
      $set:plan.set,
      $push:{history:plan.kind==='unlock_approved'
        ? {action:'medical_clearance_legacy_unblocked',title:'Cuenta habilitada con apto aprobado',
          message:`Se levantó la suspensión por apto físico ya aprobado. Operación ${runId}.`,createdAt:new Date(now)}
        : {action:'medical_clearance_grace_reset',title:'Nuevo plazo para presentar apto físico',
          message:`Se otorgaron 30 días desde ${now.toISOString()} para presentar el apto físico. Operación ${runId}.`,createdAt:new Date(now)}}
    });
    if (result.modifiedCount===1) updated++; else conflicts++;
  }
  return {selected:selected.length,updated,conflicts};
}

export async function main({runPM2=(args,options)=>execFileSync('pm2',args,options)}={}) {
  const args=process.argv.slice(2);
  const allowed=new Set(['--apply','--confirm-db','--pause-pm2','--help']);
  const options={apply:false};
  for(let i=0;i<args.length;i++) {
    if(!allowed.has(args[i])) throw Error('Opción desconocida: '+args[i]);
    if(args[i]==='--help') {
      console.log('Vista previa: node scripts/resetMedicalClearanceGrace.mjs\nAplicar: node scripts/resetMedicalClearanceGrace.mjs --apply --confirm-db NOMBRE_BASE --pause-pm2 duoclub-api'); return;
    }
    if(args[i]==='--apply') options.apply=true;
    else {
      const key=args[i]; const value=args[++i];
      if(!value || value.startsWith('--')) throw Error('Falta valor para '+key);
      options[key]=value;
    }
  }
  await import('dotenv/config');
  if(!process.env.MONGO_URI) throw Error('No hay MONGO_URI configurado. Ejecutar desde la carpeta del backend con su .env.');
  let paused=false;
  try {
    await mongoose.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:15000});
    const dbName=mongoose.connection.name;
    if(!/^[a-zA-Z0-9_-]+$/.test(dbName)) throw Error('Nombre de base no admitido para esta herramienta.');
    console.log('Base seleccionada:',dbName);
    if(options.apply) {
      if(options['--confirm-db']!==dbName) throw Error('La base no coincide con --confirm-db. Ejecutar primero la vista previa.');
      if(options['--pause-pm2']!=='duoclub-api') throw Error('Aplicar requiere --pause-pm2 duoclub-api para evitar que el control automático interfiera.');
      const list=JSON.parse(runPM2(['jlist'],{encoding:'utf8',maxBuffer:10*1024*1024}));
      const apps=list.filter(p=>p.name==='duoclub-api');
      if(apps.length!==1 || apps[0].pm2_env?.status!=='online') throw Error('PM2 debe mostrar una única duoclub-api online antes de aplicar.');
      const backendRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
      if(path.resolve(apps[0].pm2_env?.pm_cwd || '')!==backendRoot)
        throw Error('La carpeta del proceso PM2 no coincide con este backend.');
      paused=true;
      runPM2(['stop','duoclub-api'],{stdio:'inherit'});
    }
    const now=new Date();
    const collection=mongoose.connection.collection('users');
    const rows=await withSuspensionAudit(mongoose.connection,
      await collection.find({role:'client',approvalStatus:'approved'},{projection}).toArray());
    const selected=rows.filter(user=>planReset(user,now).eligible);
    const runId=now.toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
    const dir=path.resolve('backups','medical-grace-reset');
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const previewFile=path.join(dir,'preview-'+runId+'.json');
    const excluded={};
    for(const user of rows){const plan=planReset(user,now);if(!plan.eligible)excluded[plan.reason]=(excluded[plan.reason]||0)+1;}
    const counts={newGracePeriod:selected.filter(user=>planReset(user,now).kind==='restart_grace').length,
      unlockApproved:selected.filter(user=>planReset(user,now).kind==='unlock_approved').length};
    const preview={version:2,dbName,createdAt:now,newDueAt:new Date(now.getTime()+30*DAY),totalCandidates:selected.length,...counts,excluded,
      users:selected.map(user=>({id:String(user._id),name:[user.name,user.lastName].filter(Boolean).join(' '),email:user.email,
        previousMedical:user.medicalClearance,operation:planReset(user,now).kind,
        newMedicalStatus:planReset(user,now).set['medicalClearance.status'] || user.medicalClearance?.status,
        medicalSuspensionLifted:planReset(user,now).set.suspended===false}))};
    fs.writeFileSync(previewFile,JSON.stringify(preview,null,2),{flag:'wx',mode:0o600});
    console.log('Cuentas elegibles:',selected.length);
    console.log('Nuevo plazo de 30 días:',counts.newGracePeriod);
    console.log('Desbloquear conservando apto aprobado:',counts.unlockApproved);
    console.log('Vista previa:',previewFile);
    console.log('Exclusiones:',JSON.stringify(excluded));
    if(!options.apply){
      console.log('No se modificaron cuentas. Para aplicar:');
      console.log(`node scripts/resetMedicalClearanceGrace.mjs --apply --confirm-db ${dbName} --pause-pm2 duoclub-api`);
      return;
    }
    const backupFile=path.join(dir,'before-'+runId+'.ejson');
    const result=await applyResets(collection,rows,{now,runId,backupFile,dbName});
    console.log('Resultado:',JSON.stringify(result));
    if(result.updated || fs.existsSync(backupFile)) console.log('Respaldo previo:',backupFile);
    console.log('Nuevo plazo:',preview.newDueAt.toISOString());
    if(result.conflicts) {console.error('Se omitieron cuentas que cambiaron durante la operación. Revisar la vista previa.');process.exitCode=2;}
  } finally {
    try { await mongoose.disconnect(); } finally { if(paused) {
      // También se ejecuta ante errores de conexión, respaldo o escritura.
      try {runPM2(['restart','duoclub-api'],{stdio:'inherit'});}
      catch {console.error('No se pudo reiniciar la API. Ejecutar: pm2 restart duoclub-api');process.exitCode=1;}
    } }
  }
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(error=>{
    // Mostrar sólo errores propios de configuración; los de conexión podrían contener credenciales.
    const own=['Opción desconocida:','Falta valor para ','No hay MONGO_URI','Nombre de base','La base no coincide','Aplicar requiere','PM2 debe mostrar','La carpeta del proceso'];
    console.error(own.some(prefix=>String(error.message).startsWith(prefix)) ? error.message
      : 'No se pudo completar el reinicio del plazo. Verificar conexión a la base, permisos del respaldo y estado de PM2.');
    process.exitCode=1;
  });
}
