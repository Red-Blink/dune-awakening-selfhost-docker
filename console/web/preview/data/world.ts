import { ago, later, baseRows, capabilities, collection, itemRows, people, vehicleRows } from './shared';
const inventoryItems=itemRows.slice(0,4).map(row=>({templateId:row.template_id,name:row.item_name,quantity:row.stack_size}));
const cargo=itemRows.slice(0,4).map(row=>({itemId:row.id,templateId:row.template_id,name:row.item_name,image:'/images/items/'+row.template_id+'.png',positionIndex:row.position_index,quantity:row.stack_size,qualityLevel:row.quality_level,currentDurability:row.current_durability,maxDurability:row.max_durability,augments:[]}));
const pending=(kind:string)=>({supported:true,total:0,pending:[],byTarget:[],kind});
export function worldData(url:URL):unknown|undefined {
 const path=url.pathname;
 if(path==='/api/bases'||/^\/api\/players\/[^/]+\/bases$/.test(path)){
  const owner=path.match(/players\/([^/]+)/)?.[1];const rows=owner?baseRows.filter(row=>row.owner_id===owner):baseRows;
  const related=owner?[...rows.map(row=>({...row,relationship:'Owner'})),...baseRows.filter(row=>row.owner_id!==owner).slice(0,1).map(row=>({...row,relationship:'Co-Owner'}))]:rows;
  return collection(related.filter(row=>!owner||!url.searchParams.get('access')||url.searchParams.get('access')==='all'||('relationship' in row&&row.relationship===(url.searchParams.get('access')==='coowner'?'Co-Owner':'Owner'))),url,{totalOwned:rows.length,totalShared:1,totalPieces:rows.reduce((n,row)=>n+row.piece_count,0),totalPlaceables:rows.reduce((n,row)=>n+row.placeable_count,0)});
 }
 if(path==='/api/vehicles'||/^\/api\/players\/[^/]+\/vehicles$/.test(path)){
  const owner=path.includes('/players/')?path.split('/')[3]:'';
  const rows=owner?vehicleRows.map(row=>({...row,relationship:row.owner_id===owner?'Owner':'Co-Owner'})).filter(row=>row.owner_id===owner||row.id===vehicleRows.find(v=>v.owner_id!==owner)?.id):vehicleRows;
  return collection(rows.filter(row=>!owner||!url.searchParams.get('access')||url.searchParams.get('access')==='all'||('relationship' in row&&row.relationship===(url.searchParams.get('access')==='coowner'?'Co-Owner':'Owner'))),url);
 }
 if(path.startsWith('/api/bases/pending-')||path==='/api/vehicles/pending-deletes')return pending(path.split('/').pop()||'');
 if(path==='/api/bases/auto-refill'||path==='/api/bases/auto-refill-water')return {supported:true,thresholdPercent:25,windtrapThresholdPercent:30,intervalHours:6,nextRunAt:later(4),lastRunAt:ago(2),lastRunStatus:'Succeeded',lastRunDetail:'All registered bases were checked successfully.',total:baseRows.length,bases:baseRows.map(row=>({baseId:Number(row.base_id),enabledAt:ago(48),lastCheckedAt:ago(2),lastQueuedAt:ago(8),lastLowestPercent:72,consecutiveQueues:0,stalledAt:''}))};
 if(path==='/api/bases/auto-refill/settings'){
  const values={thresholdPercent:25,windtrapThresholdPercent:30,intervalHours:6,waterThresholdPercent:20,waterIntervalHours:4};
  return {settings:values,defaults:values,sources:Object.fromEntries(Object.keys(values).map(key=>[key,'console'])),limits:Object.fromEntries(Object.keys(values).map(key=>[key,{min:1,max:key.includes('Hours')?168:100}])),envNames:Object.fromEntries(Object.keys(values).map(key=>[key,key.toUpperCase()]))};
 }
 if(path==='/api/bases/permission-candidates'||path==='/api/vehicles/permission-candidates')return {supported:true,rows:people.map(row=>({playerId:row.actor_id,name:row.character_name}))};
 const baseMatch=path.match(/^\/api\/bases\/(\d+)(?:\/(.*))?$/);
 if(baseMatch){
  const base=baseRows.find(row=>row.base_id===baseMatch[1])||baseRows[0],baseId=Number(base.base_id),view=baseMatch[2]||'';
  if(!view)return {supported:true,base,capabilities};
  if(view==='permissions')return {supported:true,baseId,actorId:String(baseId),map:base.map,mapNameId:1,claimed:true,systemCustodian:{available:true,playerId:'sample-custodian',name:'Server',canCreate:false},entries:[people.find(row=>row.actor_id===base.owner_id)!,...people.filter(row=>row.actor_id!==base.owner_id).slice(0,2)].map((row,index)=>({playerId:row.actor_id,name:row.character_name,rank:index+1,label:['Owner','Co-Owner','Associate'][index],canonical:true}))};
  if(view==='child-access')return {supported:true,inspected:9,rows:['subfief','storage','refining','crafting','generators','water','pentashield','door','other'].map((group,index)=>({actorId:String(7100+index),name:['Sub-Fief Console','Resource Storage','Ore Refinery','Fabricator','Generator','Water Cistern','Pentashield','Main Entrance','Expedition Terminal'][index],buildingType:group,group,currentAccess:3,currentAccessLabel:'Sub-Fief',isSubFief:index===0}))};
  if(view==='land-claim')return {supported:true,baseId,totemId:String(baseId),map:base.map,partitionId:1,yaw:0,verticalLevel:4,maxVerticalLevel:8,segments:Array.from({length:9},(_,i)=>({x:i%3,y:Math.floor(i/3),rowCount:1})),segmentCount:9,duplicateCoordinates:0};
  if(view==='water')return {supported:true,baseId,containers:[{type:'WaterCistern',name:'Large Water Cistern',count:2,stored:18000,capacity:24000,percent:75},{type:'BloodPurifier',name:'Improved Blood Purifier',count:1,stored:6000,capacity:10000,percent:60,bloodStored:1200,bloodCapacity:5000,bloodPercent:24},{type:'Windtrap',name:'Windtrap Reservoir',count:2,stored:4000,capacity:6000,percent:67}]};
  if(view==='inventory'){
   const groups=['storage','refining','crafting','other'].map((key,index)=>({key,name:['Storage','Refining','Crafting','Other'][index],containerCount:1,itemCount:inventoryItems.length}));
   const containers=groups.map((group,index)=>({placeableId:String(7200+index),name:['Resource Vault','Ore Refinery','Fabricator','Sub-Fief Console'][index],typeName:['Large Storage Container','Medium Ore Refinery','General Fabricator','Sub-Fief Console'][index],group:group.key,usedSlots:4,maxSlots:40,currentVolume:24,maxVolume:100,volumeComplete:true,itemCount:4,items:inventoryItems}));
   return {supported:true,baseId,groups,containers,items:inventoryItems.map(item=>({...item,image:'',category:'resources',quantity:item.quantity*4,containerCount:4,containers:containers.map(container=>({placeableId:container.placeableId,name:container.name,typeName:container.typeName,group:container.group,quantity:item.quantity}))})),totals:{items:inventoryItems.reduce((sum,item)=>sum+item.quantity,0)*containers.length,distinct:inventoryItems.length,containers:4,usedSlots:16,maxSlots:160,currentVolume:96,maxVolume:400,volumeComplete:true}};
  }
  if(/^containers\/\d+$/.test(view))return {supported:true,found:true,baseId,placeableId:view.split('/')[1],typeName:'Large Storage Container',group:'storage',maxSlots:40,usedSlots:4,currentVolume:24,maxVolume:100,volumeComplete:true,inventories:[{inventoryId:'7301',maxSlots:40,usedSlots:4,currentVolume:24,maxVolume:100,volumeComplete:true,slots:cargo}],deleteSafety:{safe:false,known:true,map:base.map,partitionId:1,reason:'Preview Only'},addSafety:{safe:false,known:true,map:base.map,partitionId:1,reason:'Preview Only'}};
 }
 const vehicleMatch=path.match(/^\/api\/vehicles\/(\d+)(?:\/(.*))?$/);
 if(vehicleMatch){
  const vehicle=vehicleRows.find(row=>row.id===vehicleMatch[1])||vehicleRows[0],view=vehicleMatch[2]||'';
  if(!view)return {vehicle,capabilities,supported:true};
  if(view==='permissions')return {supported:true,vehicleId:Number(vehicle.id),actorId:vehicle.id,map:vehicle.map,mapNameId:1,claimed:true,systemCustodian:{available:true,playerId:'sample-custodian',name:'Server',canCreate:false},entries:[people.find(row=>row.actor_id===vehicle.owner_id)!,...people.filter(row=>row.actor_id!==vehicle.owner_id).slice(0,2)].map((row,index)=>({playerId:row.actor_id,name:row.character_name,rank:index+1,label:['Owner','Co-Owner','Associate'][index],canonical:true}))};
  if(view==='storage')return {supported:true,found:true,vehicleId:vehicle.id,inventoryId:'7601',maxSlots:24,usedSlots:4,maxVolume:200,currentVolume:24,volumeComplete:true,slots:cargo,deleteSafety:{safe:false,known:true,state:'Default',reason:'Preview Only'}};
 }
 if(path==='/api/base-backups')return {supported:true,capabilities,maps:['HaggaBasin','DeepDesert'],rows:baseRows.map((row,index)=>({id:9001+index,ownerControllerId:Number(row.owner_id),ownerPawnId:Number(row.owner_id),ownerName:row.owner_name,name:row.name+' Backup',rawName:row.name,map:row.map,totemType:'SubFiefConsole',pieces:row.piece_count,placeables:row.placeable_count,items:168}))};
 if(path==='/api/storage')return {rows:itemRows.map(row=>({...row,container:'Dawnspire Resource Vault',owner_name:people[0].character_name})),capabilities};
 if(/^\/api\/storage\/[^/]+\/items$/.test(path))return {rows:itemRows,capabilities};
}
