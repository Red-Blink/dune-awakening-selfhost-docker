import { baseRows, capabilities, people, vehicleRows } from './shared';
const hagga={key:'HaggaBasin',label:'Hagga Basin',actorMap:'HaggaBasin',image:'/images/maps/hagga-basin.png',width:4096,height:4096,minX:-456752.21,maxX:354547.46,minY:-450630.14,maxY:353821.95,flipY:false,defaultPartitionId:1};
const deep={...hagga,key:'DeepDesert',label:'Deep Desert',actorMap:'DeepDesert',image:'/images/maps/deep-desert.png',minX:-1268450,maxX:1158400,minY:-1261434,maxY:1165416,defaultPartitionId:8};
const landmarks=[['ore','IronOre','Iron Deposit'],['ore','CopperOre','Copper Deposit'],['ore','TitaniumOre','Titanium Deposit'],['scrap','MechanicalPart','Mechanical Scrap'],['flora','PrimroseField','Primrose Field'],['flora','Saguaroseed','Saguaro Grove'],['poi','TradingPost','The Anvil'],['poi','ImperialTestingStation','Imperial Testing Station'],['house_representative','HouseRepresentativeVernius','House Vernius Representative'],['trainer','TrainerBeneGesserit','Bene Gesserit Trainer'],['fortress','HarkonnenFortress','Harkonnen Outpost'],['hazard','Hazard_Quicksand','Quicksand'],['enemy','DesertRaider','Desert Raider Patrol'],['spice','Small','Small Spice Field'],['spice_active','Medium','Active Spice Field'],['flour_sand','FlourSand','Flour Sand Deposit']];
export function liveMapData(url:URL):unknown|undefined {
 const path=url.pathname;
 if(!path.startsWith('/api/map/'))return;
 if(path==='/api/map/capabilities')return capabilities;
 if(!['/api/map/markers','/api/map/players','/api/map/bases','/api/map/storage','/api/map/spice'].includes(path))return;
 const selected=url.searchParams.get('map')==='DeepDesert'?'DeepDesert':'HaggaBasin';
 const baseMarkers=baseRows.map(base=>({...base,type:'base',id:base.base_id,map:'HaggaBasin',partition_id:1}));
 const vehicleMarkers=vehicleRows.map((row,index)=>({...row,type:'vehicle',subtype:['LightOrnithopter','Tank','Sandbike','Buggy','Sandcrawler'][index%5],owner_name:row.owner,map:'HaggaBasin',partition_id:1}));
 const playerMarkers=people.map(row=>({...row,type:'player',id:row.actor_id,name:row.character_name,online_status:row.online_status.toLowerCase()}));
 const resourceMarkers=['HaggaBasin','DeepDesert'].flatMap((map,mapIndex)=>landmarks.map(([type,subtype,name],index)=>({id:'sample-'+mapIndex+'-'+index,type,subtype,name,map,partition_id:mapIndex?8:1,x:-220000+(index%5)*90000,y:-200000+Math.floor(index/5)*125000,z:0})));
 const storageMarkers=baseRows.slice(0,2).map((row,index)=>({...row,id:'sample-storage-'+index,type:'storage',name:'Expedition Storage',owner_name:row.owner_name}));
 const rows=[...playerMarkers,...vehicleMarkers,...baseMarkers,...storageMarkers,...resourceMarkers];
 const knownSubtypes=Object.fromEntries([...new Set(rows.map(row=>row.type))].map(type=>[type,[...new Set(rows.filter(row=>row.type===type).map(row=>'subtype' in row?String(row.subtype):'').filter(Boolean))]]));
 return {rows:path==='/api/map/players'?playerMarkers:path==='/api/map/bases'?baseMarkers:path==='/api/map/storage'?storageMarkers:path==='/api/map/spice'?resourceMarkers.filter(row=>row.type.startsWith('spice')):rows,capabilities,knownSubtypes,overlays:{},maps:{HaggaBasin:hagga,DeepDesert:deep},map:selected==='DeepDesert'?deep:hagga,defaultMap:'HaggaBasin',partitions:[{map:'HaggaBasin',partition_id:1,name:'Dawnspire',marker_count:rows.filter(row=>row.map==='HaggaBasin').length,alive:true,ready:true},{map:'DeepDesert',partition_id:8,name:'Deep Desert',marker_count:rows.filter(row=>row.map==='DeepDesert').length,alive:true,ready:true}]};
}
