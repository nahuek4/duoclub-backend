// scripts/auditDuplicateFixedSlotsV1.js
//
// SOLO LECTURA.
// Encuentra usuarios activos de septiembre con más consumos que sesiones CREDITS
// y dos o más appointments que consumen en el mismo día/hora.

import "dotenv/config";
import mongoose from "mongoose";
import User from "../src/models/User.js";
import Order from "../src/models/Order.js";
import Appointment from "../src/models/Appointment.js";
import ServiceSubscription from "../src/models/ServiceSubscription.js";
import SubscriptionBillingCycle from "../src/models/SubscriptionBillingCycle.js";

const clean=v=>String(v??"").trim();
const idOf=v=>clean(v?._id||v?.id||v);
const asInt=v=>{const n=Number(v||0);return Number.isFinite(n)?Math.max(0,Math.trunc(n)):0;};
function bounds(k){const[y,m]=k.split("-").map(Number),ld=new Date(Date.UTC(y,m,0)).getUTCDate();return{start:new Date(`${k}-01T00:00:00-03:00`),end:new Date(`${k}-${String(ld).padStart(2,"0")}T23:59:59-03:00`)};}
function consumes(ap){const s=clean(ap.status).toLowerCase();return s==="reserved"||s==="completed"||(s==="cancelled"&&ap.refundApplied!==true&&!/falta de pago|plan mensual/i.test(clean(ap.cancelReason)));}
function baseCredits(order,sk){return (order.items||[]).filter(i=>clean(i.kind).toUpperCase()==="CREDITS"&&clean(i.serviceKey).toUpperCase()===sk).reduce((s,i)=>s+asInt(i.credits)*Math.max(1,asInt(i.qty)||1),0);}

const periodKey=(process.argv.find(a=>a.startsWith("--period="))||"--period=2026-09").slice(9);
const serviceKey=(process.argv.find(a=>a.startsWith("--service="))||"--service=EP").slice(10).toUpperCase();

await mongoose.connect(process.env.MONGO_URI);
try{
  const b=bounds(periodKey);
  const cycles=await SubscriptionBillingCycle.find({periodKey,serviceKey,"lifecycle.planStatus":"active"}).lean();
  let cases=0,groups=0;
  console.log(`\nDUPLICADOS MISMO DÍA/HORA · ${periodKey} · ${serviceKey} · SOLO LECTURA`);
  for(const cycle of cycles){
    const [user,sub]=await Promise.all([User.findById(cycle.user),ServiceSubscription.findById(cycle.subscription).lean()]);
    if(!user||sub?.status!=="active") continue;
    const orders=await Order.find({user:user._id,status:{$in:["paid","approved"]},$or:[{paidAt:{$gte:b.start,$lte:b.end}},{paidAt:null,createdAt:{$gte:b.start,$lte:b.end}}]}).lean();
    const bases=orders.map(o=>({o,c:baseCredits(o,serviceKey)})).filter(x=>x.c>0);
    if(bases.length!==1) continue;
    const entitlement=bases[0].c;
    const orderIds=orders.map(o=>String(o._id));
    const lots=(user.creditLots||[]).filter(l=>clean(l.serviceKey).toUpperCase()===serviceKey&&(orderIds.includes(idOf(l.orderId))||clean(l.source).startsWith(`subscription_cycle:${String(cycle._id)}:`)));
    const ids=lots.map(idOf).filter(id=>mongoose.Types.ObjectId.isValid(id));
    const aps=await Appointment.find({user:user._id,serviceKey,creditLotId:{$in:ids}}).sort({date:1,time:1,createdAt:1}).lean();
    const cons=aps.filter(consumes);
    if(cons.length<=entitlement) continue;
    const grouped=Object.entries(cons.reduce((a,ap)=>{const k=`${ap.date}|${ap.time}`;(a[k]||=[]).push(ap);return a;},{})).filter(([,g])=>g.length>1);
    if(!grouped.length) continue;
    cases++; groups+=grouped.length;
    console.log(`\n${user.email} | pagadas=${entitlement} consumos=${cons.length}`);
    for(const [slot,g] of grouped){
      console.log(`  SLOT ${slot}`);
      for(const ap of g){
        console.log(`    id=${ap._id} status=${ap.status} fixed=${ap.fixedScheduleId||"-"} manual=${ap.assignedManually?"SI":"NO"} lot=${ap.creditLotId} debit=${ap.creditDebitStatus||"-"} createdAt=${ap.createdAt}`);
      }
    }
  }
  console.log({cases,duplicateSlotGroups:groups});
  console.log("\nNO SE MODIFICÓ NINGÚN DATO.");
}finally{
  await mongoose.disconnect();
}
