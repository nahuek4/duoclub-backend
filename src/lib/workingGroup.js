import ServiceDefinition,{CORE_SERVICE_DEFINITIONS} from '../models/ServiceDefinition.js';
export async function workingGroupScope(value) {
  const group=String(value||'').trim().toUpperCase();
  if(!group)return {group:'',keys:[],allKeys:[]};
  if(!['TRAINING','PERFORMANCE'].includes(group))throw Object.assign(new Error('Grupo inválido.'),{status:400});
  const records=new Map(CORE_SERVICE_DEFINITIONS.map(item=>[item.serviceKey,item]));
  for(const item of await ServiceDefinition.find({}).select('serviceKey capacityGroup').lean())records.set(item.serviceKey,item);
  const grouped=[...records.values()].filter(item=>['TRAINING','PERFORMANCE'].includes(item.capacityGroup));
  return {group,keys:grouped.filter(item=>item.capacityGroup===group).map(item=>item.serviceKey),allKeys:grouped.map(item=>item.serviceKey)};
}
export function workingGroupUsers(scope) {
  return scope.group?{$or:[{'creditLots.serviceKey':{$in:scope.keys}},{$nor:[{'creditLots.serviceKey':{$in:scope.allKeys}}]}]}:{};
}
