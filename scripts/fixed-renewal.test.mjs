import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = await readFile(new URL('../backend/src/services/subscriptions/fixedScheduleRenewal.js', import.meta.url), 'utf8');
const now = new Date('2027-02-01T09:00:00-03:00');
const periodKey = '2027-02';
const clone = value => structuredClone(value);
function matches(row, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some(f => matches(row, f));
    const actual = row[key];
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.entries(value).every(([op, v]) => {
        if (op === '$in') return v.some(x => String(x) === String(actual));
        if (op === '$ne') return actual != v;
        if (op === '$lte') return actual <= v;
        if (op === '$lt') return actual != null && actual < v;
        throw new Error(`Unsupported filter ${op}`);
      });
    }
    return actual == value;
  });
}
function query(get) {
  return { session() { return this; }, lean() { return Promise.resolve(clone(get())); },
    then(a,b) { return Promise.resolve(get()).then(a,b); } };
}
async function setup() {
  const state = { schedules: [{ _id:'s1',user:'u1',serviceKey:'RA',active:true,startDate:'2027-01-01',endDate:'2027-01-31',items:[{weekday:1,time:'10:00'}]}],
    appointments:[], records:[], rules:[], blocks:[], subs:[], users:[{_id:'u1',name:'Ana',email:'ana@example.invalid'}], emails:[], failMail:false, failCreate:false, sessions:0 };
  const defs = { RA:{active:true,fixedScheduleEnabled:true,recurringPlanEnabled:false}, EP:{active:true,fixedScheduleEnabled:true,recurringPlanEnabled:true}, RF:{active:true,fixedScheduleEnabled:true,recurringPlanEnabled:true} };
  function model(key) { return {
    find: f => query(() => state[key].filter(r=>matches(r,f))),
    findOne: f => query(() => state[key].find(r=>matches(r,f)) || null),
    findById: id => query(() => state[key].find(r=>r._id===id) || null),
    async updateOne(f,u,opt={}) {
      let row=state[key].find(r=>matches(r,f));
      if (!row && opt.upsert) { row={...f,...u.$setOnInsert,sentAt:null,sendingAt:null}; state[key].push(row); }
      if (!row) return {modifiedCount:0};
      Object.assign(row,u.$set||{});
      for(const [k,v] of Object.entries(u.$inc||{})) row[k]=(row[k]||0)+v;
      return {modifiedCount:1};
    },
    findOneAndUpdate(f,u) { return query(() => { const row=state[key].find(r=>matches(r,f)); if(!row)return null;Object.assign(row,u.$set);return row; }); },
    async create(rows) {
      if(state.failCreate)throw new Error('WRITE_FAILED');
      return rows.map(row=>{ const ap={...row,_id:`ap${state.appointments.length}`};state[key].push(ap);return {toObject:()=>clone(ap)}; });
    },
  }; }
  const runtime = {
    ensureServiceCatalogLoaded: async()=>{}, serviceDefinitionCached:k=>defs[k],
    normalizeCatalogServiceKey:k=>String(k||'').toUpperCase(), serviceNameForKey:k=>k==='RA'?'Rehabilitación':k,
    capacityGroupForService:k=>k==='EP'?'TRAINING':'PERFORMANCE',
    isWeekdayTimeAllowedForService:(k,w,t)=>w===1&&t==='10:00',
  };
  const modules = {
    mongoose:{default:{startSession:async()=>({withTransaction:async fn=>{state.sessions++;const snapshot=clone({appointments:state.appointments,records:state.records});try{await fn();}catch(e){Object.assign(state,snapshot);throw e;}},endSession:async()=>{}})}},
    'node:crypto':{randomUUID},
    '../../models/Appointment.js':{default:model('appointments')},
    '../../models/FixedSchedule.js':{default:model('schedules')},
    '../../models/FixedScheduleRenewal.js':{default:model('records'),FixedScheduleRenewalLock:{updateOne:async()=>({modifiedCount:1})}},
    '../../models/ScheduleBlock.js':{default:model('blocks')},
    '../../models/CapacityRule.js':{default:model('rules')},
    '../../models/ServiceSubscription.js':{default:model('subs')},
    '../../models/User.js':{default:model('users')},
    '../../mail/fixedScheduleRenewalEmails.js':{sendFixedScheduleRenewalEmail:async args=>{if(state.failMail)throw new Error('SMTP_FAIL');state.emails.push(args);return {sent:true};}},
    '../serviceCatalogRuntime.js':runtime,
    './fixedScheduleCoverage.js':{monthRangeFromKey:k=>({startYmd:`${k}-01`,endYmd:`${k}-28`}),
      buildFixedOccurrencesForMonth:({schedules,blocks})=>{
        assert.ok(schedules.every(s=>s.endDate==='2027-02-28'));
        const all=[...new Map(schedules.flatMap(s=>['01','08','15','22'].map(d=>({fixedScheduleId:s._id,serviceKey:s.serviceKey,date:`2027-02-${d}`,time:s.items[0].time,weekday:1}))).map(o=>[o.date+o.time,o])).values()];
        return {occurrences:all.filter(o=>!blocks.some(b=>b.date===o.date)),blockedOccurrences:all.filter(o=>blocks.some(b=>b.date===o.date))};
      }},
  };
  const mod=new vm.SourceTextModule(source);
  await mod.link(async spec=>{const obj=modules[spec];assert.ok(obj,`unexpected dependency ${spec}`);return new vm.SyntheticModule(Object.keys(obj),function(){for(const [k,v]of Object.entries(obj))this.setExport(k,v);});});
  await mod.evaluate();
  return {state,defs,api:mod.namespace,run:()=>mod.namespace.renewStandaloneFixedSchedules({periodKey,now})};
}

test('renueva patrón vencido sin suscripción, crédito ni deuda; reintento no duplica',async()=>{
 const {state,run}=await setup();const a=await run();assert.equal(a.ok,true);assert.equal(state.appointments.length,4);assert.equal(state.emails.length,1);
 assert.ok(state.appointments.every(a=>a.creditDebitStatus==='pending'&&a.fixedDebtAmount===0&&!a.creditLotId));
 await run();assert.equal(state.appointments.length,4);assert.equal(state.emails.length,1);
});
test('los servicios recurrentes o deshabilitados no entran al flujo',async()=>{
 const {state,defs,run}=await setup();defs.RA.recurringPlanEnabled=true;await run();assert.equal(state.appointments.length,0);defs.RA.recurringPlanEnabled=false;defs.RA.fixedScheduleEnabled=false;await run();assert.equal(state.appointments.length,0);defs.RA.fixedScheduleEnabled=true;defs.RA.active=false;await run();assert.equal(state.appointments.length,0);
});
test('patrón inactivo no se renueva',async()=>{const {state,run}=await setup();state.schedules[0].active=false;await run();assert.equal(state.appointments.length,0);});
test('cancelaciones conservadas y no incluidas en correo',async()=>{
 const {state,run}=await setup();state.appointments.push({user:'u1',serviceKey:'RA',fixedScheduleId:'s1',date:'2027-02-08',time:'10:00',status:'cancelled'});await run();assert.equal(state.appointments.length,4);assert.equal(state.emails[0].appointments.length,3);
});
test('bloqueos excluidos; todo bloqueado no envía confirmación vacía',async()=>{
 const {state,run}=await setup();state.blocks=['01','08','15','22'].map(d=>({active:true,dateFrom:'2027-02-01',date:`2027-02-${d}`}));await run();assert.equal(state.appointments.length,0);assert.equal(state.emails.length,0);
});
test('cupo cero produce parcial sin mail; reintento completa y envía una vez',async()=>{
 const {state,run}=await setup();state.rules=[{active:true,targetType:'zone',zone:'PERFORMANCE',scope:'slot',date:'2027-02-08',time:'10:00',limit:0}];const r=await run();assert.equal(r.ok,false);assert.equal(state.appointments.length,3);assert.equal(state.emails.length,0);state.rules=[];await run();assert.equal(state.appointments.length,4);assert.equal(state.emails.length,1);
});
test('conflicto con otro servicio del usuario impide confirmación',async()=>{
 const {state,run}=await setup();state.appointments.push({user:'u1',serviceKey:'EP',date:'2027-02-08',time:'10:00',status:'reserved'});const r=await run();assert.equal(r.ok,false);assert.equal(state.emails.length,0);
});
test('falla de escritura revierte y no manda mail',async()=>{
 const {state,run}=await setup();state.failCreate=true;assert.equal((await run()).ok,false);assert.equal(state.appointments.length,0);assert.equal(state.emails.length,0);
});
test('falla SMTP conserva turnos y permite reintento del correo',async()=>{
 const {state,run}=await setup();state.failMail=true;assert.equal((await run()).ok,false);assert.equal(state.appointments.length,4);assert.equal(state.records[0].sentAt,null);state.failMail=false;await run();assert.equal(state.appointments.length,4);assert.equal(state.emails.length,1);
});
test('claim simultáneo permite un solo envío',async()=>{
 const {state,api,run}=await setup();state.failMail=true;await run();state.failMail=false;const result={id:state.records[0]._id,ready:true,appointments:state.appointments};await Promise.all([api.sendFixedRenewalOnce(result,now),api.sendFixedRenewalOnce(result,now)]);assert.equal(state.emails.length,1);
});
test('suscripción legacy bloqueada requiere revisión; no se reactiva',async()=>{
 const {state,run}=await setup();state.subs=[{user:'u1',serviceKey:'RA',status:'cancelled'}];assert.equal((await run()).ok,false);assert.equal(state.appointments.length,0);assert.equal(state.emails.length,0);
});
test('precedencia de cupos y límite individual',async()=>{
 const {api}=await setup();const rules=[{scope:'default',targetType:'zone',zone:'PERFORMANCE',limit:8},{scope:'month',monthKey:periodKey,targetType:'zone',zone:'PERFORMANCE',limit:2},{scope:'slot',date:'2027-02-08',time:'10:00',targetType:'service',serviceKey:'RA',limit:1}];
 assert.equal(api.capacityAvailable({rules,appointments:[{serviceKey:'RA'}],serviceKey:'RA',date:'2027-02-08',time:'10:00'}),false);
 assert.equal(api.capacityAvailable({rules,appointments:[{serviceKey:'RF'}],serviceKey:'RA',date:'2027-02-08',time:'10:00'}),true);
 assert.equal(api.capacityAvailable({rules,appointments:[{serviceKey:'RF'},{serviceKey:'RF'}],serviceKey:'RA',date:'2027-02-15',time:'10:00'}),false);
});

async function lifecycleFixture(standalone, amountReceived=0) {
 const src=await readFile(new URL('../backend/src/services/subscriptions/subscriptionLifecycle.js',import.meta.url),'utf8');
 const writes=[];const cycle={_id:'c',subscription:'s',billing:{status:'pending',amountReceived},lifecycle:{planStatus:'active'},save:async()=>writes.push('cycle')};
 const subscription={_id:'s',user:'u',serviceKey:standalone?'RA':'EP',status:'active',save:async()=>writes.push('subscription')};
 const deps={
  mongoose:{default:{startSession:async()=>({withTransaction:fn=>fn(),endSession:async()=>{}})}},
  '../../models/Appointment.js':{default:{updateMany:async()=>{writes.push('appointments');return{modifiedCount:1};}}},
  '../../models/FixedSchedule.js':{default:{updateMany:async()=>{writes.push('schedules');return{modifiedCount:1};}}},
  '../../models/PricingPlan.js':{default:{}}, '../../models/ScheduleBlock.js':{default:{}},
  '../../models/ServiceSubscription.js':{default:{findById:()=>query(()=>subscription)}},
  '../../models/SubscriptionBillingCycle.js':{default:{find:async()=>[cycle],findById:()=>query(()=>cycle)}},
  '../../models/SubscriptionLifecycleNotice.js':{default:{findOneAndUpdate:async()=>writes.push('notice'),updateMany:async()=>{}}},
  '../../models/User.js':{default:{findById:()=>query(()=>({_id:'u'}))}},
  '../../utils/creditExpiry.js':{creditExpiryForMonthKey:()=>{}},
  '../../mail/subscriptionEmails.js':{sendSubscriptionRenewalEmail:async()=>{}},
  './fixedScheduleCoverage.js':{calculateServiceMonthCoverage:()=>{},monthRangeFromKey:()=>{}},
  './subscriptionScheduleProjection.js':{projectActiveFixedSchedulesForMonth:()=>{}},
  '../serviceCatalogRuntime.js':{ensureServiceCatalogLoaded:async()=>{},isServiceEnabledFor:()=>!standalone,normalizeCatalogServiceKey:v=>v,serviceNameForKey:v=>v},
  './fixedScheduleRenewal.js':{isStandaloneFixedService:()=>standalone},
 };
 const mod=new vm.SourceTextModule(src);await mod.link(spec=>{const obj=deps[spec];assert.ok(obj,spec);return new vm.SyntheticModule(Object.keys(obj),function(){for(const[k,v]of Object.entries(obj))this.setExport(k,v);});});await mod.evaluate();return{api:mod.namespace,writes,cycle,subscription};
}
test('ciclos antiguos de servicios sin plan no suspenden ni liberan turnos',async()=>{
 const {api,writes}=await lifecycleFixture(true);const args={periodKey,now:new Date('2027-02-21T12:00:00-03:00')};await api.suspendOverdueSubscriptions(args);await api.terminateUnpaidSubscriptions(args);assert.deepEqual(writes,[]);
});
test('servicio recurrente impago conserva suspensión y baja vigentes',async()=>{
 const {api,writes,subscription}=await lifecycleFixture(false);const args={periodKey,now:new Date('2027-02-21T12:00:00-03:00')};await api.suspendOverdueSubscriptions(args);assert.equal(subscription.status,'suspended');await api.terminateUnpaidSubscriptions(args);assert.equal(subscription.status,'terminated_for_non_payment');assert.ok(writes.includes('appointments'));assert.ok(writes.includes('schedules'));
});
test('pago parcial de recurrente conserva protección existente',async()=>{
 const {api,writes,subscription}=await lifecycleFixture(false,1);const args={periodKey,now:new Date('2027-02-21T12:00:00-03:00')};await api.suspendOverdueSubscriptions(args);await api.terminateUnpaidSubscriptions(args);assert.equal(subscription.status,'active');assert.equal(writes.includes('appointments'),false);assert.equal(writes.includes('schedules'),false);
});
