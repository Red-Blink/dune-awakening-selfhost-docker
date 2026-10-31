// All identities and state in this directory are fictional public examples.
export const ago = (hours = 1) => new Date(Date.now() - hours * 3600000).toISOString();
export const later = (hours = 1) => new Date(Date.now() + hours * 3600000).toISOString();
export const capabilities = Object.fromEntries(('players bases vehicles inventory factions intel progression vitals solarisCoin assignFaction deletedCharacters statusFilterApplied buildingUnlockOwnership customizationOwnership customizationPending basePermissions baseChildAccess baseChildAccessQueue baseDelete baseDeleteQueue generatorRefill generatorRefillQueue waterRefill waterRefillQueue storageGiveItem vehiclePermissions vehicleDelete vehicleDeleteQueue vehicleStoredDelete vehicleStorage exchange exchangeHistory exchangeMarket playerContributions rewards schematics crafting research journey skillModules baseInventory baseWater spicefields guilds').split(' ').map(key => [key, true]));
export const people = ['Aster Vale','Mira Sandwalker','Kellan Voss','Nadia Stone','Rook Ashford','Tala Dawn','Silas Renn','Iris North','Dara Flint','Soren Pike','Lyra Marr','Cassian Reed'].map((name,index)=>({
  actor_id:String(101+index),id:String(101+index),character_name:name,name,online_status:index<4?'Online':'Offline',actual_online_status:index<4?'Online':'Offline',
  map:index===3?'DeepDesert':'HaggaBasin',partition_id:index===3?8:1,sietch:index===3?'Deep Desert':'Dawnspire',last_seen:ago(index<4?0:index+1),last_login:ago(index+2),
  total_playtime_seconds:186400+index*12600,fls_id:(0xD0C0A11A00000000n+BigInt(index+1)).toString(16).toUpperCase(),guild_id:index<6?'1':'2',guild_name:index<6?'Dawn Seekers':'Sandwardens',
  level:45+index,player_level:45+index,faction:index%2?'Harkonnen':'Atreides',faction_id:index%2?2:1,region:'Eastern Shield Wall',banned:false,
  x:-120000+index*15000,y:80000-index*9000,z:0
}));
export const itemRows = [
  {id:'18492071',item_name:'Plant Fiber',template_id:'PlantFiber',stack_size:150,quality_level:0,inventory_type:0,position_index:0,current_durability:null,max_durability:null,augments:[]},
  {id:'18492084',item_name:'Steel Ingot',template_id:'SteelBar',stack_size:64,quality_level:0,inventory_type:0,position_index:1,current_durability:null,max_durability:null,augments:[]},
  {id:'18492103',item_name:'Literjon',template_id:'Literjon',stack_size:1,quality_level:0,inventory_type:0,position_index:2,current_durability:null,max_durability:null,augments:[]},
  {id:'18492126',item_name:'Maula Pistol',template_id:'ChoamSda2',stack_size:1,quality_level:0,inventory_type:0,position_index:3,current_durability:92.4,max_durability:100,augments:[]},
  {id:'18492158',item_name:'Slaver Stillsuit Body',template_id:'Stillsuit_Choam_01_Top',stack_size:1,quality_level:0,inventory_type:1,position_index:0,current_durability:96.5,max_durability:100,augments:[]},
  {id:'18492179',item_name:'Adept Dirk',template_id:'Dirk_1',stack_size:1,quality_level:0,inventory_type:15,position_index:0,current_durability:94.8,max_durability:100,augments:[]},
  {id:'18492205',item_name:"Villari's Stillsuit Garment",template_id:'Stillsuit_Unique_Efficient_06_Top_Schematic',stack_size:1,quality_level:0,inventory_type:30,position_index:0,current_durability:null,max_durability:null,augments:[]}
];
export const inventoryForPlayer=(actorId:string)=>itemRows.map(row=>({...row,id:String(Number(row.id)+(people.findIndex(person=>person.actor_id===actorId)+1)*1000)}));
export const blueprints = people.flatMap((person,index)=>['Watchtower','Workshop','Expedition Camp'].map((kind,part)=>({id:901+index*3+part,name:(index===0?'Dawnspire':person.character_name.split(' ')[1])+' '+kind,owner_id:person.actor_id,player_id:person.actor_id,owner_name:person.character_name,pieces:148-part*40,placeables:36-part*8,building_count:148-part*40,placeable_count:36-part*8,created_at:ago(72+index),updated_at:ago(part+1)})));
export const vehicleRows = people.map((person,index)=>({
  id:String(5001+index),name:['Scout Ornithopter','Regis Expedition','Sandbike Courier','Supply Buggy','Desert Sandcrawler'][index%5]+(index>4?' '+(index+1):''),type:['Light Ornithopter','Regis Tank','Sandbike','Buggy','Sandcrawler'][index%5],owner:person.character_name,owner_name:person.character_name,owner_id:person.actor_id,
  shared_with:[{name:people[(index+1)%people.length].character_name,rank:2,label:'Co-Owner'}],condition_percent:96-index*3,condition_estimated:false,current_fuel:820-index*50,max_fuel:1000,fuel_percent:82-index*5,
  map:'HaggaBasin',partition_id:1,region:'Eastern Shield Wall',lifecycle_state:'Default',x:-80000+index*30000,y:50000-index*12000,z:0,
  modules:[{templateId:'T3_Vehicle_Engine',name:'Mk III Engine',condition:920,maxCondition:1000,conditionPercent:92},{templateId:'Vehicle_Storage',name:'Cargo Hold',condition:1000,maxCondition:1000,conditionPercent:100,isStorage:true}]
}));
export const baseRows = people.map((person,index)=>({
  id:String(7001+index),base_id:String(7001+index),name:['Dawnspire Outpost','Cliffside Refuge','Sandwarden Workshop'][index]||person.character_name.split(' ')[1]+' Outpost',base_name:person.character_name+' Outpost',owner_name:person.character_name,owner_id:person.actor_id,base_type:index%3===2?'Advanced Sub-Fief':'Sub-Fief',map:'HaggaBasin',partition_id:1,
  x:-180000+index*30000,y:140000-index*24000,z:0,coordinates:'Sample Location',piece_count:148+index*24,placeable_count:36+index*4,pieces:148+index*24,placeables:36+index*4,
  shared_with:[{name:people[(index+1)%people.length].character_name,rank:2,label:'Co-Owner'}],generatorDataAvailable:true,generatorCount:2,windtrapCount:2,fuelCells:48,generatorRuntimeSeconds:172800,generatorUptimeMultiplier:1,generatorUptimeEventLabel:'Standard Runtime',generatorUptimeEventEndsAt:'',generatorUnstockedCount:0,generatorAllUnstocked:false,
  generators:[{type:'fuel',name:'Fuel-Powered Generator',fuelName:'Fuel Cell',fuelCells:24,generatorCount:2,runtimeSeconds:172800,unstockedCount:0},{type:'windtrap',name:'Windtrap',fuelName:'Filter',fuelCells:12,generatorCount:2,runtimeSeconds:86400,unstockedCount:0}]
}));
export function collection<T extends Record<string,unknown>>(rows:T[],url:URL,extra:Record<string,unknown>={}) {
  const query=(url.searchParams.get('q')||'').toLowerCase();
  const filtered=rows.filter(row=>!query||JSON.stringify(row).toLowerCase().includes(query));
  const column=url.searchParams.get('sortColumn');if(column)filtered.sort((a,b)=>String(a[column]??'').localeCompare(String(b[column]??''),undefined,{numeric:true})*(url.searchParams.get('sortDirection')==='desc'?-1:1));
  const size=Number(url.searchParams.get('pageSize')||200),page=Number(url.searchParams.get('page')||0);
  return {rows:filtered.slice(page*size,(page+1)*size),totalCount:filtered.length,totalPlayers:people.length,totalBases:baseRows.length,totalVehicles:vehicleRows.length,totalGuilds:2,capabilities,...extra};
}
