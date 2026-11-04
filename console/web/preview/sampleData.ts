// Fictional, public fixtures only. Never generate this file from a live server.
import { playerData } from './data/players';
import { worldData } from './data/world';
import { operationsData, mapNames, mapMemoryRows } from './data/operations';
import { landsraadData } from './data/landsraad';
import { communityData } from './data/community';
import { liveMapData } from './data/liveMap';
const now = () => new Date().toISOString();
const containers=['dune-postgres','dune-rmq-admin','dune-rmq-game','dune-text-router','dune-director','dune-server-gateway',...mapNames.map(map=>'dune-server-'+map.toLowerCase())];
const status=['=== Dune status ===','Overall: READY','Title: Docker Community','Region: Europe','Mode: Public','Population: 4/60','','=== Containers ===','SERVICE STATUS',...containers.map(name=>name+' Up 2 days'),'','=== Listeners ===','CHECK PORT STATUS','Postgres localhost 15432/tcp OK','Director 11717/tcp OK','TextRouter 5059/tcp OK','RabbitMQ game 31982/tcp OK','','=== Database ===','World partitions: '+mapNames.length,'','=== Game servers ===','MAP STATE UPTIME',...mapNames.map(map=>map+' READY Up 2 days'),'','=== Funcom/FLS summary ===','Director heartbeat: OK','Population declaration: OK','Max capacity declaration: OK','Gateway DB monitoring: OK'].join('\n');
const readiness=[...containers.map(name=>'OK container '+name),'OK world_partition rows: '+mapNames.length,'OK game server sg.* RMQ connections','READY: all checks passed'].join('\n');
const output=(stdout:string)=>({stdout,stderr:'',exitCode:0,sampledAt:now()});
export const sampleLogs=['[Info] Docker Community is ready.','[Info] Director heartbeat acknowledged.','[Info] Hagga Basin: 3 explorers online.','[Info] Deep Desert: 1 explorer online.','[Info] Community expedition reminder delivered.','[Info] Desert Starter Pack delivered to Aster Vale.','[Info] Map memory balanced: '+mapNames.length+' servers within budget.','[Info] Scheduled market refresh completed: 24 orders.','[Info] Database backup completed: 1.79 MB.','[Info] All services passed the readiness check.','[Info] Sample log — no live server is connected.'].join('\n');
export function sampleResponse(url:URL):unknown {
 for (const handler of [liveMapData,worldData,playerData,operationsData,landsraadData,communityData]) {
  const response=handler(url);if(response!==undefined)return response;
 }
 const path=url.pathname;
 if(path==='/api/auth/state')return {authenticated:true,csrfToken:'preview-only',config:{version:'1.4.59',port:8088}};
 if(path==='/api/health')return {ok:true};
 if(path==='/api/setup/state')return {files:{complete:true,env:true,token:true,battlegroup:true},config:{}};
 if(path==='/api/server/status')return {...output(status+'\nServer IP: 198.51.100.42\nBattlegroup: Dawnspire'),ok:true};
 if(path==='/api/server/readiness')return output(readiness);
 if(path==='/api/server/funcom-token/check')return {ok:true,mismatch:false,checkedSince:'10m',details:'Sample connection is ready.'};
 if(path==='/api/server/performance')return {cpuPercent:24,memory:{usedBytes:mapMemoryRows.reduce((sum,row)=>sum+row.usedBytes,4*2**30),totalBytes:64*2**30,availableBytes:64*2**30-mapMemoryRows.reduce((sum,row)=>sum+row.usedBytes,4*2**30),percent:mapMemoryRows.reduce((sum,row)=>sum+row.usedBytes,4*2**30)/(64*2**30)*100},disk:{usedBytes:120*2**30,totalBytes:512*2**30,freeBytes:392*2**30,percent:23},uptimeSeconds:172800,uptime:'2 days',sampledAt:now()};
 if(path==='/api/server/restart-history'){
  const row={id:'sample-restart',startedAt:new Date(Date.now()-172800000).toISOString(),finishedAt:new Date(Date.now()-172710000).toISOString(),durationSeconds:90,scope:'battlegroup',target:'Dawnspire',map:'',partitionId:'',source:'Schedule',reason:'Scheduled Restart',result:'Succeeded'};
  return {rows:[row],lastBattlegroupRestart:row};
 }
 if(path==='/api/players/list-settings')return {settings:{inactiveWeeks:null},limits:{inactiveWeeks:{min:1,max:8}},canConfigure:false};
 if(path==='/api/logs/services')return {services:[...containers.map(name=>name.replace(/^dune-/,'')),'autoscaler']};
 if(path.startsWith('/api/logs'))return output(sampleLogs);
 if(path==='/api/setup/tasks')return {tasks:[previewVersionTask('stack'),previewVersionTask('game')]};
 if(path.startsWith('/api/setup/tasks/preview-check'))return {task:previewVersionTask(path.includes('game')?'game':'stack')};
 throw new Error('Missing preview fixture: '+path);
}
export function previewVersionTask(kind:string){return {id:'preview-check-'+kind,type:'updates',operation:kind==='game'?'updateCheckGame':'selfUpdateCheck',status:'succeeded',currentStep:'Complete',progressMessage:'Sample versions are up to date.',startedAt:'2026-10-31T12:00:00Z',finishedAt:'2026-10-31T12:00:01Z',warnings:[],errorMessage:null,logLines:(kind==='game'?['Installed build: 26324834','Latest build: 26324834','Already up to date.']:['Current stack version: v1.4.59','Latest release: v1.4.59','Already up to date.']).map(line=>({timestamp:'2026-10-31T12:00:00Z',stream:'stdout',line}))};}
