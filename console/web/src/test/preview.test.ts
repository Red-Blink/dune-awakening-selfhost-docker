import { describe,expect,it } from 'vitest';
import { isManagementAction,previewApiResponse,previewLanguageFile } from '../../preview/installPreview';
import { sampleResponse } from '../../preview/sampleData';
import { mapNames, mapMemoryRows, partitionRows } from '../../preview/data/operations';
import { itemRows, people, inventoryForPlayer } from '../../preview/data/shared';
import catalog from '../../../../runtime/data/admin-items.json';
import settingsMetadata from '../../preview/data/settingsSchema.json';
describe('public Console preview isolation',()=>{
 it('shows v1.4.59 in the Console and sample update checks',()=>{
  expect(sampleResponse(new URL('https://try.example/api/auth/state'))).toMatchObject({config:{version:'1.4.59'}});
  const task=sampleResponse(new URL('https://try.example/api/setup/tasks/preview-check-stack')) as {task:{logLines:{line:string}[]}};
  expect(task.task.logLines.map(row=>row.line)).toContain('Current stack version: v1.4.59');
 });
 it('has no queued operations or pending settings restarts',()=>{
  for(const path of ['/api/bases/pending-refills','/api/bases/pending-water-refills','/api/bases/pending-deletes','/api/bases/pending-child-access','/api/vehicles/pending-deletes']){
   const data=sampleResponse(new URL('https://try.example'+path)) as {total:number;pending:unknown[];byTarget:unknown[]};
   expect(data.total).toBe(0);expect(data.pending).toEqual([]);expect(data.byTarget).toEqual([]);
  }
  for(const view of ['restart-pending','deferred-pending']){
   const data=sampleResponse(new URL('https://try.example/api/maps/user-settings/'+view)) as {pending:boolean;rows:unknown[]};
   expect(data.pending).toBe(false);expect(data.rows).toEqual([]);
  }
  expect(sampleResponse(new URL('https://try.example/api/server/restart-queue'))).toMatchObject({state:{entries:[]}});
 });
 it('populates every displayed backup column with realistic sizes',()=>{
  const data=sampleResponse(new URL('https://try.example/api/backups')) as {rows:Record<string,unknown>[]};
  expect(data.rows).toHaveLength(4);
  for(const row of data.rows){
   for(const column of ['name','backupName','battlegroupId','created','size','type','source'])expect(row[column]).toBeTruthy();
   expect(Number(row.sizeBytes)).toBeLessThanOrEqual(Math.round(1.79*2**20));
  }
  const system=sampleResponse(new URL('https://try.example/api/backups/system')) as {rows:Record<string,unknown>[]};
  expect(system.rows.length).toBeGreaterThan(0);
  for(const row of system.rows)expect(Number(row.sizeBytes)).toBeLessThanOrEqual(Math.round(1.79*2**20));
  expect(data.rows[0].size).toBe('1.79 MB');
 });
 it('supports regional and Chinese packs without permitting arbitrary paths',()=>{
  for(const code of ['EN','DE','AR','PT-BR','PT-PT','ZH-HANS','ZH-HANT'])expect(previewLanguageFile(code)).toBe('/preview-data/'+code+'.json');
  expect(previewLanguageFile('../../api')).toBeNull();
 });
 it('rejects every mutation method without changing sample records',async()=>{
  const url=new URL('https://try.example/api/players');
  const before=await previewApiResponse(url).json();
  for(const method of ['POST','PUT','PATCH','DELETE'])expect(previewApiResponse(url,method).status).toBe(405);
  expect(await previewApiResponse(url).json()).toEqual(before);
 });
 it('blocks management controls while preserving navigation and viewing',()=>{
  for(const label of ['Restart','Delete Backup','Save Settings','Install','Give Items','Teleport','Update'])expect(isManagementAction(label)).toBe(true);
  for(const label of ['Players','Server Control','Hagga Basin','Refresh','Inventory','German','Open navigation'])expect(isManagementAction(label)).toBe(false);
 });
 it('serves fictional player data with working search',async()=>{
  const data=await previewApiResponse(new URL('https://try.example/api/players?q=Mira')).json();
  expect(data.rows).toHaveLength(1);expect(data.rows[0].character_name).toBe('Mira Sandwalker');
 });
 it.each(['inventory','currency','factions','specs','crafting-recipes','research-items','building-unlocks','bases','vehicles'])('populates player %s',view=>{
  const data=sampleResponse(new URL('https://try.example/api/players/101/'+view)) as {rows:unknown[]};
  expect(data.rows.length).toBeGreaterThan(0);
 });
 it.each(['/api/players','/api/guilds','/api/bases','/api/vehicles','/api/base-backups','/api/blueprints/community','/api/care-package/history','/api/care-package/eligible','/api/exchange/items','/api/exchange/market/items','/api/exchange/transactions','/api/maps/spicefields'])('populates %s',path=>{
  const data=sampleResponse(new URL('https://try.example'+path)) as {rows:unknown[]};
  expect(data.rows.length).toBeGreaterThan(0);
 });
 it('preserves owner and co-owner views for every fictional player',()=>{
  for(let id=101;id<=112;id++)for(const kind of ['bases','vehicles'])for(const access of ['owner','coowner']){
   const data=sampleResponse(new URL(`https://try.example/api/players/${id}/${kind}?access=${access}`)) as {rows:{relationship:string}[]};
   expect(data.rows.length).toBeGreaterThan(0);expect(data.rows.every(row=>row.relationship===(access==='owner'?'Owner':'Co-Owner'))).toBe(true);
  }
 });
 it('fails visibly for unimplemented routes rather than pretending empty data is complete',()=>{
  expect(()=>sampleResponse(new URL('https://try.example/api/missing-fixture'))).toThrow('Missing preview fixture');
 });
 it('includes the full settings catalog and populated specialty sections',()=>{
  const schema=sampleResponse(new URL('https://try.example/api/maps/user-settings/schema')) as Record<string,{id:string;category:string}[]>;
  expect(Object.values(schema).flat().length).toBeGreaterThan(400);
  expect(schema.game.some(field=>field.category==='Spice Fields')).toBe(true);
  expect(schema.partition.some(field=>field.category==='Spice Fields')).toBe(true);
  const values=sampleResponse(new URL('https://try.example/api/maps/user-settings/values')) as {stdout:string};
  for(const field of Object.values(schema).flat())expect(values.stdout).toContain(field.id+'\t');
 });
 it('preserves public INI setting names in the native settings response',()=>{
  const schema=sampleResponse(new URL('https://try.example/api/maps/user-settings/schema')) as Record<string,{id:string;key:string}[]>;
  for(const [scope,fields] of Object.entries(settingsMetadata))for(const field of fields){
   expect(schema[scope].find(row=>row.id===field.id)?.key).toBe(field.iniSetting);
  }
 });
 it('provides valid milestone and community blueprint contracts',()=>{
  const preset=sampleResponse(new URL('https://try.example/api/admin/landsraad/milestone-preset')) as {preset:{thresholds:number[]}};
  expect(preset.preset.thresholds).toEqual([700,3500,7000,10500,14000]);
  const blueprints=sampleResponse(new URL('https://try.example/api/blueprints/community')) as {rows:{title:string;updatedAt:string;ownerName:string}[]};
  for(const row of blueprints.rows){expect(row.title).toBeTruthy();expect(row.ownerName).toBeTruthy();expect(Number.isFinite(Date.parse(row.updatedAt))).toBe(true);}
 });
 it('uses native FLS format and realistic, unique inventory IDs and catalog names',()=>{
  expect(new Set(people.map(person=>person.fls_id)).size).toBe(people.length);
  for(const person of people)expect(person.fls_id).toMatch(/^[0-9A-F]{16}$/);
  const ids=people.flatMap(person=>inventoryForPlayer(person.actor_id).map(item=>item.id));
  expect(new Set(ids).size).toBe(ids.length);
  for(const id of ids)expect(id).toMatch(/^\d{5,9}$/);
  for(const item of itemRows){
   expect(catalog.find(row=>row.id===item.template_id)?.name).toBe(item.item_name);
   if(item.max_durability!==null)expect(item.current_durability).toBeLessThanOrEqual(item.max_durability);
  }
  expect(new Set(itemRows.map(row=>row.inventory_type))).toEqual(new Set([0,1,15,30]));
 });
 it('matches every catalog map and partition to a real memory progress sample',()=>{
  expect(mapNames).toHaveLength(36);expect(mapNames).toContain('CB_Halloween_Event_Shipwreck_01');
  expect(new Set(partitionRows.map(row=>row.partitionId)).size).toBe(mapNames.length);
  for(const partition of partitionRows){
   const memory=mapMemoryRows.find(row=>row.container.endsWith('-'+partition.partitionId));
   expect(memory?.map).toBe(partition.map);expect(memory!.usedBytes).toBeGreaterThan(0);
   expect(memory!.usedBytes).toBeLessThan(memory!.limitBytes);
  }
  const memory=(sampleResponse(new URL('https://try.example/api/server/performance')) as {memory:{usedBytes:number;totalBytes:number}}).memory;
  expect(memory.usedBytes).toBeGreaterThan(mapMemoryRows.reduce((sum,row)=>sum+row.usedBytes,0));
  expect(memory.usedBytes).toBeLessThan(memory.totalBytes);
 });
 it('populates the complete Landsraad board and every persistent control',()=>{
  const board=sampleResponse(new URL('https://try.example/api/admin/landsraad')) as {tasks:{task_id:string;goal_amount:number;faction_progress:number}[];rewards:{task_id:string;threshold:number;amount:number}[]};
  expect(board.tasks).toHaveLength(25);expect(board.rewards).toHaveLength(125);
  for(const task of board.tasks){expect(task.faction_progress).toBeLessThan(task.goal_amount);expect(board.rewards.filter(row=>row.task_id===task.task_id)).toHaveLength(5);}
  const values=sampleResponse(new URL('https://try.example/api/maps/user-settings/values?scope=global')) as {stdout:string};
  for(const key of ['landsraad_cycle_duration_seconds','landsraad_task_goal_amount','landsraad_voting_period_seconds','landsraad_control_points_per_cycle'])expect(values.stdout).toMatch(new RegExp(key+'\\t[0-9]'));
 });
 it('uses native profile limits and currency identifiers',()=>{
  const get=(view:string)=>sampleResponse(new URL('https://try.example/api/players/101/'+view));
  expect(get('vitals')).toMatchObject({maxHydration:100,maxSpiceAddictionLevel:10,maxHealthEstimated:true});
  expect(get('intel')).toMatchObject({maxIntel:2779});
  expect(get('currency')).toMatchObject({rows:[{currency_id:0,label:'Solari Credit'},{currency_id:1,label:'House Credit'}]});
  expect(get('progression')).toMatchObject({level:45,xp:25390});
  expect(get('specs')).toMatchObject({rows:expect.arrayContaining([expect.objectContaining({track_type:'Sabotage'})])});
 });
 it('keeps inventory totals and market listing summaries consistent',()=>{
  const inventory=sampleResponse(new URL('https://try.example/api/bases/7001/inventory')) as {containers:{items:{quantity:number}[]}[];totals:{items:number}};
  expect(inventory.totals.items).toBe(inventory.containers.reduce((sum,container)=>sum+container.items.reduce((count,item)=>count+item.quantity,0),0));
  const market=sampleResponse(new URL('https://try.example/api/exchange/items')) as {rows:{listing_count:number}[]};
  const stats=sampleResponse(new URL('https://try.example/api/exchange/stats')) as {totalListings:number;botListings:number;playerListings:number};
  expect(market.rows.reduce((sum,row)=>sum+row.listing_count,0)).toBe(stats.totalListings);
  expect(stats.botListings+stats.playerListings).toBe(stats.totalListings);
 });
});
