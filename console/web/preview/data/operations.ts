import settingsSchema from './settingsSchema.json';
import mapCatalog from './mapCatalog.json';
import landsraadDefaults from './landsraadDefaults.json';
import { ago, later, baseRows, capabilities, itemRows, people, vehicleRows } from './shared';

export const mapNames=mapCatalog.map(row=>row.map);
export const partitionRows=mapNames.map((map,index)=>{
 const partitionId=index===2?8:index<2||index>=8?index+1:index;
 return {partitionId,partition_id:partitionId,map,dimension:0,dimension_index:0,label:['Docker Community','Overmap','Deep Desert','Arrakeen','Harko Village','Orbital Monitor'][index]||map,serverId:'sample-server-'+partitionId,gamePort:7777+index,igwPort:33100+index,ready:true,alive:true,status:'READY'};
});
export const mapMemoryRows=mapCatalog.map((entry,index)=>{
 const usedGiB=index===0?9.6:index===1?0.83:entry.limitGiB*(0.22+index%6*0.025);
 const usedBytes=Math.round(usedGiB*2**30),limitBytes=entry.limitGiB*2**30;
 return {map:entry.map,partitionId:partitionRows[index].partitionId,container:'dune-server-'+entry.map.toLowerCase().replaceAll('_','-')+'-'+partitionRows[index].partitionId,usedBytes,limitBytes,percent:usedBytes/limitBytes*100,raw:'Sample Memory',swapUsedBytes:0,swapLimitBytes:2**30,swapSupported:true};
});
const out=(stdout:string)=>({stdout,stderr:'',exitCode:0});
const mapsText=JSON.stringify({maps:mapNames.map((map,index)=>({map,status:'READY',mode:'Always On',memory:mapCatalog[index].limitGiB+'G',partitionId:String(partitionRows[index].partitionId)}))});
const serviceText=partitionRows.map(row=>`${row.partitionId} | ${row.map} | 0 | ${row.label} | ${row.serverId} | ${row.gamePort} | ${row.igwPort} | true | true`).join('\n');
export const settingsFields=settingsSchema;
export function operationsData(url:URL):unknown|undefined {
 const path=url.pathname;
 if(path==='/api/public-directory/status')return {available:true,enabled:true,claimed:true,serverId:'sample-server',title:'Docker Community',status:'online',lastHeartbeatAt:ago(0.01)};
 if(path==='/api/settings')return {config:{appName:'Dune Docker Console',port:8088,repoRoot:'/srv/dune-docker',runtimePath:'/srv/dune-docker/runtime',authEnabled:true,secureCookies:true,allowHostBootstrap:true,mockMode:false,taskRetention:'7 days'},files:{env:true,token:true,battlegroup:true,install:true,compose:true,runtime:true},publicDirectory:{available:true,enabled:true,claimed:true,claimRequired:false,claimedBy:'Docker Community',anonymousCountEnabled:true,serverId:'sample-server'},serverStartup:{settings:{autoStartBattlegroup:true},defaults:{autoStartBattlegroup:true}},consoleAccess:{pending:false,configuredCount:2,activeCount:2,canConfirm:false,fingerprint:'sample',recovery:'Use your server terminal to review access settings.'}};
 if(path==='/api/settings/experimental-tanks')return {enabled:true,supported:true,build:'2168446',applying:false,error:'',queuedEntryId:null,queuedEnabled:null};
 if(path==='/api/settings/encrypted-api')return {available:true,enabled:true,running:true,state:'running',health:'healthy',port:8089,fingerprint:'Sample Public Fingerprint'};
 if(path==='/api/settings/api-keys/catalog')return {namespaces:['players','guilds','bases','vehicles','maps','logs','backups','database','updates','server'].map(namespace=>({namespace,readActions:['list','profile'],writeActions:namespace==='logs'?[]:['update'],supportsWrite:namespace!=='logs'}))};
 if(path==='/api/settings/api-keys')return {keys:[{id:'sample-monitor-key',name:'Community Monitor',prefix:'sample_',scopes:{players:'read',maps:'read',logs:'read'},enabled:true,createdAt:ago(168),expiresAt:later(720),lastUsedAt:ago(0.1),lastUsedIp:'192.0.2.10',rateLimitPerMinute:60,expired:false},{id:'sample-backup-key',name:'Backup Dashboard',prefix:'sample_',scopes:{backups:'read'},enabled:true,createdAt:ago(48),expiresAt:null,lastUsedAt:ago(2),lastUsedIp:'192.0.2.20',rateLimitPerMinute:30,expired:false}]};
 if(path==='/api/server/doctor')return out('PASS Docker daemon reachable\nPASS Game assets installed\nPASS Database connection healthy\nPASS Funcom token valid\nPASS All public game ports are reachable\nPASS Disk space available: 392 GiB\nPASS All readiness checks passed');
 if(path==='/api/server/services')return out(['SERVICE NAME STATUS','dune-postgres postgres running (healthy)','dune-rmq-admin rabbitmq-admin running (healthy)','dune-rmq-game rabbitmq-game running (healthy)','dune-text-router text-router running (healthy)','dune-director director running (healthy)',...mapNames.map(name=>name+' game-server running (healthy)')].join('\n'));
 if(path==='/api/server/ports')return out('SERVICE\tPORT\tPROTOCOL\tSTATUS\nGame Traffic\t7777-7810\tUDP\tListening\nConsole\t8088\tTCP\tListening\nDirector\t11717\tTCP\tListening\nRabbitMQ Game\t31982\tTCP\tListening');
 if(path==='/api/server/ip-change-restart')return out('Public IP Change Restart Enabled: true\nCheck Interval: 10 minutes\nIn Game Notice: 5 minutes\nLast Known Public IP: 198.51.100.42\nLast Check: '+ago(0.1)+'\nLast Restart: '+ago(48)+'\nSystemd Timer: active');
 if(path==='/api/server/shutdown-protection')return out('Shutdown Protection Enabled: true\nSystemd Service: active\nSystemd Enabled: enabled\nGrace Period: 15 minutes\nLast Check: '+ago(0.1));
 if(path==='/api/server/restart-schedule')return out('Scheduled Restart Enabled: true\nRestart Time: 04:00\nNotify Players Before: 15 minutes\nTimezone: UTC\nSystemd Timer: active\nLast Restart: '+ago(24));
 if(path==='/api/server/restart-queue')return {state:{entries:[]},settings:{enabled:true,defaultCountdownMinutes:15,broadcastCheckpoints:[15,10,5,1],broadcastDurationSec:10,recoveryGraceMinutes:5,messages:{battlegroup:{title:'Scheduled Restart',body:'Server maintenance starts soon.'},map:{title:'Map Restart',body:'This map will restart soon.'}}},defaults:{defaultCountdownMinutes:15,messages:{}},playersOnline:4,battlegroupPlayersOnline:4,playersOnlineSupported:true};
 if(path==='/api/map/status')return {schemaVersion:1,ok:true,maps:out(mapsText),services:out(serviceText),readiness:out('READY: all checks passed'),autoscaler:out('Autoscaler: running'),data:{maps:mapNames.map((map,index)=>({map,mode:'always-on',partitions:1,assigned:1})),partitions:partitionRows,readiness:{status:'ready',message:'All maps are ready',checks:partitionRows.map(row=>({section:'Game Servers',status:'OK',label:row.label}))},autoscaler:{state:'running',container:'dune-autoscaler',status:'Healthy'}}};
 if(path==='/api/maps')return out(mapsText);
 if(path==='/api/map/services')return out(serviceText);
 if(path==='/api/map/partitions')return {rows:partitionRows,partitions:partitionRows,capabilities};
 if(path==='/api/maps/autoscaler')return out('dune-autoscaler\trunning\nLast scan: '+ago(0.01)+'\nAlways-on startup parallelism: 2\nReady maps: '+mapNames.length);
 if(path==='/api/maps/memory')return out(mapCatalog.map(row=>row.map+'\t'+row.limitGiB+'G').join('\n'));
 if(path==='/api/maps/memory/live')return {sampledAt:ago(0.01),rows:mapMemoryRows};
 if(path==='/api/maps/memory/balancer')return {enabled:true,intervalSeconds:60,lastRunAt:ago(0.02),lastRunStatus:'Succeeded',nextRunAt:later(0.01)};
 if(path==='/api/maps/memory/swap')return {enabled:true,available:true,active:true,path:'/srv/dune-docker/swap',swapFile:'/srv/dune-docker/swap/maps.swap',perServerGiB:2,poolGiB:mapNames.length*2,recommendedPoolGiB:mapNames.length*2,worldServerCount:mapNames.length,existingSwapGiB:mapNames.length*2,physicalMemoryGiB:64,safeAvailableDiskGiB:392,swappiness:'10',configuredSwappiness:10};
 if(path==='/api/maps/runtime-settings')return {alwaysOnStartupParallelism:2,configuredAlwaysOnStartupParallelism:2,defaultAlwaysOnStartupParallelism:2,maxAlwaysOnStartupParallelism:8,configured:true,hostMemoryProtectionEnabled:true,hostMemorySafetyLimited:false,physicalMemoryGiB:64,hostMemoryReserveGiB:8,automaticHostMemoryReserveGiB:8,hostMemoryReserveConfigured:true};
 if(path==='/api/maps/mode')return out('Mode: Always On\nMap: '+(url.searchParams.get('map')||'Survival_1'));
 if(path==='/api/maps/user-settings/schema')return settingsFields;
 if(path==='/api/maps/user-settings/raw')return {content:'; Sample Server Settings\n[Server]\nMaxPlayers=60\n\n[Gameplay]\nxp_multiplier=1.5\nresource_respawn_speed_multiplier=1.0\nbuilding_piece_limit_multiplier=1.5'};
 if(path==='/api/maps/user-settings/values'||path==='/api/maps/userengine'||path==='/api/maps/usergame')return out([...(path.endsWith('userengine')?settingsFields.engine:path.endsWith('usergame')?[...settingsFields.game,...settingsFields.serverCustom]:Object.values(settingsFields).flat()).map(field=>field.id+'\t'+field.default),...Object.entries(landsraadDefaults).map(([key,value])=>key+'\t'+value)].join('\n'));

 if(path==='/api/maps/user-settings/restart-pending'||path==='/api/maps/user-settings/deferred-pending')return {rows:[],pending:false,maps:[],total:0};
 if(path==='/api/maps/combat-state')return {map:url.searchParams.get('map')||'Survival_1',mapState:'PVE',partitions:partitionRows.map(row=>({map:row.map,partitionId:String(row.partitionId),dimensionIndex:0,databaseLabel:row.label,runtimeStatus:'RUNNING',serverDisplayName:row.label,configuredState:'PVE',materializedState:'PVE',customPvpMode:'NoPVP',customPvpModeSource:'profile',source:'partition-pvp-selector',securityZonesEnabled:true,restartRequired:false,configurationDrift:false,warnings:[]}))};
 if(path==='/api/maps/spicefields')return {mode:'resourcefields',capabilities,rows:['Small','Medium','Large'].map((field_type,index)=>({spicefield_type_id:index+1,map_name:'DeepDesert',field_type,dimension_index:0,max_globally_active:3+index,max_globally_primed:2,current_globally_active:1+index,current_globally_primed:1,is_spawning_active:true,global_spawn_weight:1})),activeFields:['Small','Medium','Large'].map((field_type,index)=>({field_id:String(301+index),map_name:'DeepDesert',field_type,dimension_index:0,spawn_time:Math.floor(Date.now()/1000)-3600,value_remaining:12000-index*2000}))};
 if(path==='/api/maps/choam-terminals'){
  const transform={x:0,y:0,z:0,qx:0,qy:0,qz:0,qw:1};
  return {supported:true,tradeCenters:['The Anvil','Hagga Rift','Tradepost'].map((name,index)=>({key:['the-anvil','hagga-rift','tradepost'][index],name,transform,defaultTransform:transform,custom:false})),sietches:[{partition_id:'1',dimension_index:0,label:'Dawnspire'}],placements:[{trade_center_key:'the-anvil',trade_center_name:'The Anvil',dimension_index:0,partition_id:'1',actor_id:'sample-terminal',source_player_id:'101',created_at:ago(48),actor_present:true}],positionLimits:{radiusUu:5000,verticalUu:2000}};
 }
 if(path==='/api/sietches')return out('partition_id | map | dimension | label\n1 | Survival_1 | 0 | Dawnspire\n8 | DeepDesert_1 | 0 | Deep Desert');
 if(path==='/api/sietches/dimensions')return out(url.searchParams.get('ids')==='1'?(url.searchParams.get('map')==='DeepDesert_1'?'8':'1'):('DIMENSION  DISPLAY NAME  PASSWORD\n0  '+(url.searchParams.get('map')==='DeepDesert_1'?'Deep Desert':'Dawnspire')+'  (unset)'));
 if(path==='/api/deepdesert')return out('Map: DeepDesert_1\nWipe schedule: Weekly\nNext reset: '+later(72)+'\nActive spicefields: 6\nCombat: PvP');
 if(path==='/api/backups'){
  const rows=[1.79,1.74,1.68,1.61].map((size,index)=>{
   const createdAt=ago(index*24+4),stamp=createdAt.replace(/[-:]/g,'').replace('T','-').slice(0,15),name='dune-db-Dawnspire__'+stamp+'.backup';
   return {name,backupName:name,battlegroupId:'Dawnspire',created:createdAt.slice(0,19).replace('T',' '),createdAt,createdSort:Date.parse(createdAt),modified:createdAt,sizeBytes:Math.round(size*2**20),size:size.toFixed(2)+' MB',type:'Database Backup',source:index===1?'Manual':'Scheduled'};
  });
  return {currentBattlegroupId:'Dawnspire',rows,stdout:rows.map(row=>`${row.created}\t${row.name}\t${row.size}`).join('\n')};
 }
 if(path==='/api/backups/system')return {rows:[1.79,1.72].map((size,index)=>({name:'dune-system-dawnspire-'+ago(index*24+6).slice(0,10)+'.tar.gz.enc',createdAt:ago(index*24+6),origin:'Dawnspire',type:'System Backup',source:index?'Manual':'Scheduled',encryption:'OpenPGP',serverTitle:'Docker Community',battlegroupId:'Dawnspire',hasSidecar:true,includesAuditLog:true,sizeBytes:Math.round(size*2**20),size:size.toFixed(2)+' MB'}))};
 if(path==='/api/backups/auto')return {enabled:true,intervalHours:6,keep:12,settings:{enabled:true,intervalHours:6,retentionDays:7,keep:12},defaults:{enabled:false,intervalHours:24,keep:7},nextRunAt:later(2),lastRunAt:ago(4),lastStatus:'Succeeded',stdout:'Enabled: true\nInterval: 6 hours\nKeep: 12\nLast backup: Succeeded'};
 if(path==='/api/database/status')return {host:'postgres',port:5432,database:'dune',user:'dune',connected:true,status:'Connected',version:'PostgreSQL 17',size:'128 MB',tables:7,connections:12,stdout:'PostgreSQL 17 — Connected\nDatabase: dune\nSize: 128 MB\nActive connections: 12'};
 if(path==='/api/database/schemas')return ['dune','public'];
 if(path==='/api/database/tables')return ['players','guilds','bases','vehicles','items','world_partitions','exchange_orders'].map((name,index)=>({schema:'dune',name,row_count:String([people.length,2,baseRows.length,vehicleRows.length,people.length*itemRows.length,partitionRows.length,24][index])}));
 if(path==='/api/database/routines')return [{oid:'8101',schema:'dune',name:'get_player_summary',kind:'function',arguments:'player_id bigint',result_type:'jsonb',language:'sql',owner:'dune',description:'Read a player summary.'}];
 if(path.startsWith('/api/database/routines/'))return {oid:'8101',schema:'dune',name:'get_player_summary',kind:'function',arguments:'player_id bigint',definition:'CREATE FUNCTION dune.get_player_summary(player_id bigint) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object(\'id\', player_id); $$;'};
 const table=path.match(/^\/api\/database\/tables\/[^/]+\/([^/]+)\/(columns|count|preview)$/);
 if(table){
  const records:Record<string,Record<string,unknown>[]>={players:people,bases:baseRows,vehicles:vehicleRows,items:itemRows,guilds:[{id:1,name:'Dawn Seekers',members:6},{id:2,name:'Sandwardens',members:6}],world_partitions:partitionRows,exchange_orders:[{id:1,item:'Steel Ingot',price:180,stock:64}]};
  const rows=records[table[1]]||people,keys=Object.keys(rows[0]).slice(0,10);
  if(table[2]==='count')return {count:String(rows.length)};
  if(table[2]==='columns')return keys.map((column_name,index)=>({column_name,data_type:index===0?'bigint':'text',is_nullable:'NO',column_default:null,ordinal_position:index+1}));
  return {columns:keys.map(name=>({name})),rows:rows.map((row,index)=>({...Object.fromEntries(keys.map(key=>[key,row[key]])),__rowid:String(index+1)}))};
 }
 if(path==='/api/database/search')return [{table_schema:'dune',table_name:'players',column_name:'character_name',data_type:'text'},{table_schema:'dune',table_name:'guilds',column_name:'guild_name',data_type:'text'}];
 if(path==='/api/updates/auto-game')return out('Auto Updates Enabled: true\nSystemd Timer: active\nCheck Interval Minutes: 30\nApply Updates: true\nNotify Players: true\nNotify Minutes: 15,10,5,1\nWait Until Empty: true\nMax Wait Minutes: 60\nUpdate Console: true\nManage Regis Tanks: true\nLast Check: '+ago(0.25));
 if(path==='/api/updates/qa/status')return {authenticated:false,status:'signed_out',channel:{channel:'release',label:'Public Release',commitSha:'sample-release',shortSha:'sample'}};
 if(path==='/api/updates/qa/build')return {sha:'sample-release',shortSha:'sample',ready:true,status:'Ready',installedSha:'sample-release',commitsAheadOfRelease:0,updateAvailable:false,channel:{channel:'release',label:'Public Release',commitSha:'sample-release',shortSha:'sample'}};
 if(path==='/api/updates/stack-progress')return {runId:'sample-completed-update',state:'succeeded',stage:'complete',percent:100,message:'Console updated successfully.',startedAt:ago(48),updatedAt:ago(47.99),finishedAt:ago(47.99),consoleReplaced:true};
}
