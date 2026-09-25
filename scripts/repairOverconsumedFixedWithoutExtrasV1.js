// scripts/repairOverconsumedFixedWithoutExtrasV1.js
//
// DUO CLUB — saneo de sobreconsumo fijo SIN pagos extra.
// DRY RUN por defecto.
//
// Procesa solo casos donde:
// - subscription/cycle están activos;
// - existe exactamente 1 Order CREDITS paga del período;
// - NO existen SUBSCRIPTION_EXTRA / MANUAL_SERVICE;
// - consumos > sesiones pagas;
// - TODOS los consumos excedentes son turnos FIJOS;
// - NO hay dos consumos en el mismo día/hora.
//
// Acción:
// - primeros N consumos cronológicos (N = sesiones pagas) quedan cubiertos;
// - excedentes quedan con creditDebitStatus="pending", SIN lote, SIN deuda;
// - lote Order queda canónico, remaining=0;
// - lote mensual viejo remaining=0;
// - cycle.creditGrant apunta al lote Order;
// - cycle.coverage queda extra_sessions_required.
//
// NO toca status del appointment, FixedSchedule, billing, plan, lifecycle ni dinero.

import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import Order from "../src/models/Order.js";
import Appointment from "../src/models/Appointment.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";

function clean(v){ return String(v ?? "").trim(); }
function idOf(v){ return clean(v?._id || v?.id || v); }
function asInt(v){ const n=Number(v||0); return Number.isFinite(n)?Math.max(0,Math.trunc(n)):0; }
function money(v){ const n=Number(v||0); return Number.isFinite(n)?Math.max(0,Math.round(n)):0; }

function parseArgs(){
  let periodKey="2026-09", serviceKey="EP", only="", apply=false;
  for(const arg of process.argv.slice(2)){
    if(arg==="--apply") apply=true;
    else if(arg.startsWith("--period=")) periodKey=clean(arg.slice(9));
    else if(arg.startsWith("--service=")) serviceKey=clean(arg.slice(10)).toUpperCase();
    else if(arg.startsWith("--only=")) only=clean(arg.slice(7)).toLowerCase();
  }
  if(!/^\d{4}-\d{2}$/.test(periodKey)) throw new Error(`Período inválido: ${periodKey}`);
  return {periodKey,serviceKey,only,apply};
}
function bounds(periodKey){
  const [y,m]=periodKey.split("-").map(Number);
  const ld=new Date(Date.UTC(y,m,0)).getUTCDate();
  return {
    start:new Date(`${periodKey}-01T00:00:00-03:00`),
    end:new Date(`${periodKey}-${String(ld).padStart(2,"0")}T23:59:59-03:00`)
  };
}
function itemsFor(order, serviceKey){
  const sk=clean(serviceKey).toUpperCase();
  return (Array.isArray(order?.items)?order.items:[])
    .filter(it=>["CREDITS","SUBSCRIPTION_EXTRA","MANUAL_SERVICE","SUBSCRIPTION_RENEWAL"].includes(clean(it?.kind).toUpperCase()))
    .filter(it=>!clean(it?.serviceKey) || clean(it?.serviceKey).toUpperCase()===sk)
    .map(it=>{
      const qty=Math.max(1,asInt(it?.qty)||1);
      return {
        kind:clean(it?.kind).toUpperCase(),
        credits:asInt(it?.credits)*qty,
        qty,
      };
    });
}
function isLifecycleCancellation(ap){
  return clean(ap?.status).toLowerCase()==="cancelled" &&
    /falta de pago|plan mensual/i.test(clean(ap?.cancelReason));
}
function consumes(ap){
  const st=clean(ap?.status).toLowerCase();
  if(st==="reserved" || st==="completed") return true;
  return st==="cancelled" && ap?.refundApplied!==true && !isLifecycleCancellation(ap);
}
function recalcUserCredits(user, now=new Date()){
  user.credits=(Array.isArray(user?.creditLots)?user.creditLots:[]).reduce((sum,lot)=>{
    const exp=lot?.expiresAt?new Date(lot.expiresAt):null;
    if(exp && exp<=now) return sum;
    return sum+Math.max(0,Number(lot?.remaining||0));
  },0);
}

async function inspect(cycleId,{periodKey,serviceKey,session=null}){
  const cycleQ=SubscriptionBillingCycle.findById(cycleId); if(session) cycleQ.session(session);
  const cycle=await cycleQ; if(!cycle) return {classification:"STRUCTURE_REVIEW",errors:["CYCLE_NOT_FOUND"]};

  const userQ=User.findById(cycle.user); if(session) userQ.session(session);
  const subQ=ServiceSubscription.findById(cycle.subscription); if(session) subQ.session(session);
  const [user,subscription]=await Promise.all([userQ,subQ]);
  if(!user||!subscription) return {cycle,user,subscription,classification:"STRUCTURE_REVIEW",errors:["USER_OR_SUB_NOT_FOUND"]};

  const b=bounds(periodKey);
  const oq=Order.find({
    user:user._id,
    status:{$in:["paid","approved"]},
    $or:[
      {paidAt:{$gte:b.start,$lte:b.end}},
      {paidAt:null,createdAt:{$gte:b.start,$lte:b.end}}
    ]
  }).sort({paidAt:1,createdAt:1});
  if(session) oq.session(session);
  const orders=await oq;

  const rows=orders.map(order=>{
    const items=itemsFor(order,serviceKey);
    return {
      order,items,
      base:items.filter(i=>i.kind==="CREDITS").reduce((s,i)=>s+i.credits,0),
      extras:items.filter(i=>["SUBSCRIPTION_EXTRA","MANUAL_SERVICE"].includes(i.kind)).reduce((s,i)=>s+i.credits,0),
    };
  }).filter(r=>r.items.length);

  const bases=rows.filter(r=>r.base>0);
  const errors=[];
  if(subscription.status!=="active") errors.push(`SUB_NOT_ACTIVE:${subscription.status}`);
  if(cycle.lifecycle?.planStatus!=="active") errors.push(`CYCLE_NOT_ACTIVE:${cycle.lifecycle?.planStatus}`);
  if(bases.length!==1) errors.push(`EXPECTED_ONE_BASE_ORDER:${bases.length}`);

  const baseRow=bases[0]||null;
  const entitlement=baseRow?.base||0;
  const extras=rows.reduce((s,r)=>s+r.extras,0);
  if(extras!==0) errors.push(`EXPLICIT_EXTRAS_PRESENT:${extras}`);

  const lots=Array.isArray(user.creditLots)?user.creditLots:[];
  const cyclePrefix=`subscription_cycle:${String(cycle._id)}:${periodKey}`;
  const cycleLots=lots.filter(l=>{
    const src=clean(l?.source);
    return clean(l?.serviceKey).toUpperCase()===serviceKey &&
      (src===cyclePrefix || src.startsWith(`subscription_cycle:${String(cycle._id)}:`));
  });

  const orderId=baseRow?String(baseRow.order._id):"";
  const orderLots=lots.filter(l=>clean(l?.serviceKey).toUpperCase()===serviceKey && idOf(l?.orderId)===orderId);
  if(baseRow && orderLots.length!==1) errors.push(`EXPECTED_ONE_ORDER_LOT:${orderLots.length}`);
  if(cycleLots.length<1) errors.push("CYCLE_LOT_NOT_FOUND");

  const orderLot=orderLots[0]||null;
  if(orderLot && asInt(orderLot.amount)!==entitlement) errors.push(`ORDER_LOT_AMOUNT_MISMATCH:${asInt(orderLot.amount)}!=${entitlement}`);

  const lotIds=[...cycleLots.map(idOf),...orderLots.map(idOf)].filter(id=>mongoose.Types.ObjectId.isValid(id));
  const aq=lotIds.length?Appointment.find({
    user:user._id,
    serviceKey,
    creditLotId:{$in:Array.from(new Set(lotIds))}
  }).sort({date:1,time:1,createdAt:1}):null;
  if(session&&aq) aq.session(session);
  const appointments=aq?await aq:[];

  const consuming=appointments.filter(consumes).sort((a,b)=>{
    const ak=`${clean(a.date)} ${clean(a.time)} ${a.createdAt?new Date(a.createdAt).getTime():0}`;
    const bk=`${clean(b.date)} ${clean(b.time)} ${b.createdAt?new Date(b.createdAt).getTime():0}`;
    return ak.localeCompare(bk);
  });

  if(consuming.length<=entitlement) return null;

  const duplicateGroups=Object.values(consuming.reduce((acc,ap)=>{
    const k=`${clean(ap.date).slice(0,10)}|${clean(ap.time).slice(0,5)}`;
    (acc[k] ||= []).push(ap); return acc;
  },{})).filter(g=>g.length>1);

  const covered=consuming.slice(0,entitlement);
  const excess=consuming.slice(entitlement);

  if(excess.some(ap=>!ap.fixedScheduleId)) errors.push("EXCESS_CONTAINS_NON_FIXED");
  if(duplicateGroups.length) errors.push(`DUPLICATE_SLOT_GROUPS:${duplicateGroups.length}`);

  let classification="OVERAGE_WITHOUT_EXTRA_PAYMENT";
  if(errors.length) classification=duplicateGroups.length?"DUPLICATE_APPOINTMENT_SLOT_REVIEW":"STRUCTURE_REVIEW";

  return {
    cycle,user,subscription,rows,baseRow,entitlement,extras,cycleLots,orderLot,
    appointments,consuming,covered,excess,duplicateGroups,errors,classification
  };
}

function print(row){
  const email=clean(row.user?.email).toLowerCase();
  console.log(`\n${email}`);
  console.log(`  pagadas=${row.entitlement} consumos=${row.consuming.length} exceso=${row.excess.length}`);
  console.log(`  orderLot=${idOf(row.orderLot)} remaining=${asInt(row.orderLot?.remaining)}`);
  for(const lot of row.cycleLots) console.log(`  cycleLot=${idOf(lot)} remaining=${asInt(lot.remaining)}`);
  console.log("  Excedentes a dejar PENDING:");
  for(const ap of row.excess){
    console.log(`    ${ap.date} ${ap.time} ${ap.status} FIJO id=${ap._id}`);
  }
  console.log(`  CLASIFICACIÓN=${row.classification}`);
  for(const e of row.errors) console.log(`    ERROR ${e}`);
}

function backupDir(){
  const dir=path.resolve(process.cwd(),"backups","subscription-repairs");
  fs.mkdirSync(dir,{recursive:true}); return dir;
}
function serializable(doc){ return doc?.toObject?doc.toObject({depopulate:true}):doc; }

async function applyRow(row,{periodKey,serviceKey}){
  const session=await mongoose.startSession();
  let result=null;
  try{
    await session.withTransaction(async()=>{
      const fresh=await inspect(row.cycle._id,{periodKey,serviceKey,session});
      if(!fresh || fresh.classification!=="OVERAGE_WITHOUT_EXTRA_PAYMENT"){
        throw new Error(`NOT_SAFE_ANYMORE:${fresh?.classification||"NO_LONGER_OVERAGE"}`);
      }

      const {user,cycle,orderLot,cycleLots,covered,excess,entitlement}=fresh;
      const now=new Date();

      // Cubiertos: lote canónico Order. Conservamos status/debit actual.
      for(const ap of covered){
        ap.creditLotId=orderLot._id;
        ap.creditExpiresAt=orderLot.expiresAt||null;
        await ap.save({session});
      }

      // Excedentes: turno existe, pero sin cobertura. NO deuda.
      for(const ap of excess){
        ap.creditLotId=null;
        ap.creditExpiresAt=null;
        ap.creditDebitStatus="pending";
        ap.creditDebitedAt=null;
        ap.fixedDebitProcessedAt=null;
        ap.fixedDebtAmount=0;
        await ap.save({session});
      }

      orderLot.amount=entitlement;
      orderLot.remaining=0;

      for(const lot of cycleLots){
        if(idOf(lot)!==idOf(orderLot)) lot.remaining=0;
      }

      cycle.creditGrant.granted=true;
      cycle.creditGrant.grantedSessions=entitlement;
      cycle.creditGrant.lotId=orderLot._id;
      cycle.creditGrant.expiresAt=orderLot.expiresAt||null;
      cycle.creditGrant.invalidatedAt=null;
      cycle.creditGrant.invalidationReason="";

      cycle.coverage.status="extra_sessions_required";
      cycle.coverage.baseSessions=entitlement;
      cycle.coverage.extraSessionsSelected=0;
      cycle.coverage.totalSessions=entitlement;
      cycle.coverage.fixedOccurrencesCount=fresh.consuming.filter(ap=>!!ap.fixedScheduleId).length;
      cycle.coverage.coveredFixedOccurrences=Math.min(entitlement,cycle.coverage.fixedOccurrencesCount);
      cycle.coverage.uncoveredFixedOccurrences=fresh.excess.length;
      cycle.coverage.extraSessionsNeeded=fresh.excess.length;
      cycle.coverage.additionalSessionsStillNeeded=fresh.excess.length;
      cycle.coverage.freeSessions=0;
      cycle.coverage.calculatedAt=now;

      await cycle.save({session});

      recalcUserCredits(user,now);
      user.history=Array.isArray(user.history)?user.history:[];
      user.history.push({
        action:"subscription_overconsumption_reconciled",
        title:"Cobertura mensual reconciliada",
        message:`Se reconocieron ${entitlement} sesiones pagas de ${periodKey}; ${fresh.excess.length} turno(s) fijo(s) excedente(s) quedaron pendientes de cobertura sin deuda.`,
        serviceKey,
        service:"Entrenamiento Personal",
        serviceName:"Entrenamiento Personal",
        qty:fresh.excess.length,
        createdAt:now,
      });
      await user.save({session});

      result={
        ok:true,
        email:clean(user.email).toLowerCase(),
        sessionsPaid:entitlement,
        coveredAppointments:covered.length,
        pendingAppointments:excess.length,
        pendingIds:excess.map(ap=>String(ap._id)),
        orderLotId:idOf(orderLot),
        userCreditsAfter:Number(user.credits||0),
      };
    });
    return result;
  } finally {
    await session.endSession();
  }
}

async function main(){
  const args=parseArgs();
  if(!process.env.MONGO_URI) throw new Error("Falta MONGO_URI en .env");
  await mongoose.connect(process.env.MONGO_URI);
  try{
    const cycles=await SubscriptionBillingCycle.find({periodKey:args.periodKey,serviceKey:args.serviceKey})
      .select("_id").sort({createdAt:1}).lean();

    console.log("\n"+"=".repeat(124));
    console.log(`SANE0 SOBRECONSUMO FIJO SIN EXTRAS · ${args.periodKey} · ${args.apply?"APPLY":"DRY RUN"}`);
    console.log("=".repeat(124));

    const rows=[];
    const duplicateRows=[];
    for(const c of cycles){
      const row=await inspect(c._id,args);
      if(!row) continue;
      const email=clean(row.user?.email).toLowerCase();
      if(args.only && email!==args.only) continue;
      if(row.classification==="OVERAGE_WITHOUT_EXTRA_PAYMENT"){ rows.push(row); print(row); }
      else if(row.classification==="DUPLICATE_APPOINTMENT_SLOT_REVIEW"){ duplicateRows.push(row); }
    }

    console.log("\n"+"-".repeat(124));
    console.log({
      ready:rows.length,
      duplicateReview:duplicateRows.length,
      totalPendingToCreate:rows.reduce((s,r)=>s+r.excess.length,0),
      allExcessFixed:rows.every(r=>r.excess.every(ap=>!!ap.fixedScheduleId)),
    });

    if(!args.apply){
      console.log("\nDRY RUN: NO SE MODIFICÓ NINGÚN DATO.");
      if(rows.length) console.log(`Para aplicar SOLO estos casos: node scripts/repairOverconsumedFixedWithoutExtrasV1.js --period=${args.periodKey} --service=${args.serviceKey} --apply`);
      return;
    }

    if(!rows.length){ console.log("\nNo hay casos READY."); return; }

    const dir=backupDir();
    const stamp=new Date().toISOString().replace(/[:.]/g,"-");
    const backup=path.join(dir,`before-overconsumption-repair-${args.periodKey}-${stamp}.json`);
    fs.writeFileSync(backup,JSON.stringify({
      generatedAt:new Date().toISOString(),
      periodKey:args.periodKey,
      rows:rows.map(r=>({
        email:clean(r.user.email).toLowerCase(),
        user:serializable(r.user),
        cycle:serializable(r.cycle),
        subscription:serializable(r.subscription),
        order:serializable(r.baseRow.order),
        appointments:r.appointments.map(serializable),
        entitlement:r.entitlement,
        excessIds:r.excess.map(ap=>String(ap._id)),
      }))
    },null,2));
    console.log(`\nBackup: ${backup}`);

    const results=[];
    for(const row of rows){
      try{
        const r=await applyRow(row,args);
        results.push(r);
        console.log(`OK ${r.email}: pagadas=${r.sessionsPaid} pending=${r.pendingAppointments}`);
      }catch(e){
        results.push({ok:false,email:clean(row.user.email).toLowerCase(),error:e?.message||String(e)});
        console.error(`ERROR ${clean(row.user.email).toLowerCase()}: ${e?.message||e}`);
      }
    }

    const resultFile=path.join(dir,`overconsumption-repair-result-${args.periodKey}-${stamp}.json`);
    fs.writeFileSync(resultFile,JSON.stringify({generatedAt:new Date().toISOString(),backup,results},null,2));

    console.log("\n"+"=".repeat(124));
    console.log("REPARACIÓN TERMINADA");
    console.log(`OK: ${results.filter(r=>r.ok).length}`);
    console.log(`ERROR: ${results.filter(r=>!r.ok).length}`);
    console.log(`Resultado: ${resultFile}`);
    console.log("=".repeat(124));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(async e=>{
  console.error("\nREPAIR ERROR:",e?.stack||e?.message||e);
  try{await mongoose.disconnect();}catch{}
  process.exit(1);
});
