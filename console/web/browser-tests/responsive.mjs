// Run after npm run build. PLAYWRIGHT_MODULE may point to a Playwright install.
// Every request is intercepted: this test never connects to a real Console.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const sizes = [[320, 740], [390, 844], [768, 1024], [844, 390], [1024, 600], [1280, 720], [1440, 900], [1536, 864], [1920, 1080], [2560, 1440]];
async function checkCommunityButtons(page) {
  const buttons = await page.locator('.topbar-links .community-button').evaluateAll(elements => elements.map(element => ({height:element.getBoundingClientRect().height,weight:getComputedStyle(element).fontWeight})));
  assert.equal(buttons.length,3,'language, Discord and Support controls are present');
  assert.ok(Math.max(...buttons.map(button=>button.height))-Math.min(...buttons.map(button=>button.height))<=1,'community controls share the same height');
  assert.ok(buttons.every(button=>button.weight==='400'),'community labels use normal font weight');
}
let firstRun = false;
try {
  const page = await browser.newPage({ hasTouch: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if(message.type()==='error') errors.push(message.text()); });
  await page.addInitScript(() => { if(!sessionStorage.getItem('dune-console:active-tab')) sessionStorage.setItem('dune-console:active-tab', 'Settings'); });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'console.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      let body = { ok: true, stdout: '', items: [], keys: [], areas: [], addons: [], players: [], pending: [], byTarget: [], tasks: [] };
      if (url.pathname === '/api/auth/state') body = { authenticated: true, csrfToken: 'fixture', config: { version: '1.4.52' } };
      if (url.pathname === '/api/setup/state') body = { files: { complete: !firstRun }, config: {} };
      if (url.pathname === '/api/settings') body = { config: { port: 8088 }, files: {}, publicDirectory: { available: true, enabled: true }, serverStartup: { settings: { autoStartBattlegroup: true } } };
      if (url.pathname === '/api/settings/api-keys/catalog') body = {namespaces:[{namespace:'players',readActions:['list','profile'],writeActions:['giveItems'],supportsWrite:true}]};
      if (url.pathname === '/api/players/list-settings') body = { settings: { inactiveWeeks: null }, limits: { inactiveWeeks: { min: 1, max: 8 } }, canConfigure: true };
      if (url.pathname === '/api/players') body = {rows:[{actor_id:'82',character_name:'Desert Explorer With A Long Name',online_status:'Offline',last_seen:'2026-10-26T12:00:00Z',map:'HaggaBasin',total_playtime_seconds:3665,fls_id:'FIXTURE00000000000000000000000000'}],totalCount:1};
      if (url.pathname === '/api/players/82/inventory') body = {capabilities:{},rows:[{id:'12345',item_name:'Advanced Desert Infantry Weapon',template_id:'FixtureWeapon',inventory_type:0,stack_size:1000,quality_level:3,position_index:24,current_durability:1500,max_durability:2500,augments:[]}]};
      if (url.pathname === '/api/players/82/crafting-recipes') body = {capabilities:{},rows:[{recipeId:'FixtureAdvancedDesertInfantryWeapon',displayName:'Advanced Desert Infantry Weapon',source:'base',qualityLevel:3,unlocked:false}]};
      if (url.pathname === '/api/players/82/research-items') body = {capabilities:{},rows:[{itemKey:'FixtureAdvancedDesertInfantryWeapon',displayName:'Advanced Desert Infantry Weapon',type:'Recipe',productGroup:'Weapons',unlocked:false,actionable:true}]};
      if (url.pathname === '/api/players/82/specs') body = {rows:[{track_type:'Planetologist',xp_amount:120000,level:12},{track_type:'Trooper',xp_amount:50000,level:3}],skillModules:[],capabilities:{}};
      if (url.pathname === '/api/players/82/teleport-destinations') body = {self:{id:'82',name:'Desert Explorer'},players:[],bases:[]};
      if (url.pathname === '/api/players/82/character-recovery') body = {ok:true,online:false,active:{characterStateId:'82',characterName:'Desert Explorer'},candidates:[{characterStateId:'81',characterName:'Previous Desert Explorer With A Long Name',itemCount:1500,deletedAt:'2026-10-25T12:00:00Z',recoverable:true}],suggestedCandidateId:'81',canRecover:true};
      if (url.pathname === '/api/admin/items/catalog') body = {rows:[{id:'PlantFiber',itemId:'PlantFiber',name:'Plant Fiber',category:'resources',group:'resources',image:'/images/items/PlantFiber.png'}]};
      if (url.pathname === '/api/blueprints') body = {rows:[{id:1,name:'Southern Desert Community Retreat',owner_id:'82',player_id:'82',pieces:1500,placeables:450}]};
      if (url.pathname === '/api/guilds') body = {rows:[{guild_id:'1',guild_name:'Travellers of the Southern Desert',guild_description:'A community guild for exploring and building across the deserts of Arrakis.',member_count:50}],totalCount:1,capabilities:{guilds:true}};
      if (url.pathname === '/api/vehicles') body = {rows:[{id:'5001',name:'Scout Ornithopter With A Long Name',type:'Scout Ornithopter',owner:'Desert Explorer With A Long Name',shared_with:[],condition_percent:92,fuel_percent:61,map:'HaggaBasin',partition_id:1,modules:[]}],totalCount:1,capabilities:{vehicles:true}};
      if (url.pathname === '/api/map/markers') {
        const hagga = {key:'hagga',label:'Hagga Basin',actorMap:'HaggaBasin',image:'/assets/dune/login_background.png',width:2048,height:2048,minX:-1000,maxX:1000,minY:-1000,maxY:1000,defaultPartitionId:1};
        const deepdesert = {...hagga,key:'deepdesert',label:'Deep Desert',actorMap:'DeepDesert',defaultPartitionId:8};
        body = {rows:[],overlays:{},capabilities:{},maps:{hagga,deepdesert},map:url.searchParams.get('map')==='deepdesert'?deepdesert:hagga,defaultMap:'hagga',partitions:[{map:'HaggaBasin',partition_id:1,name:'Southern Basin Community Sietch',alive:true,ready:true},{map:'DeepDesert',partition_id:8,name:'Northern Deep Desert',alive:true,ready:true}]};
      }
      if (url.pathname === '/api/logs/services') body = { services: ['director', 'survival-1', 'autoscaler'] };
      if (url.pathname === '/api/server/restart-queue') body = {state:{entries:[]},settings:{defaultCountdownMinutes:30,broadcastCheckpoints:[15,10,5,1],messages:{}},defaults:{messages:{}},playersOnline:0};
      if (url.pathname === '/api/admin/message-of-the-day') body = {settings:{enabled:false,title:'',message:'',deliveryMode:'login'},defaults:{},status:{}};
      if (url.pathname === '/api/admin/player-announcements') body = {settings:{joinEnabled:false,leaveEnabled:false,joinMessage:'',leaveMessage:''},defaults:{}};
      if (url.pathname === '/api/admin/history') body = {stdout:'2026-10-26T12:00:00Z\tscheduled-map-chat-now\tSurvival_1\tSystem\tA scheduled message for the whole community.\tSucceeded\tDelivered to the active map.'};
      if (url.pathname === '/api/maps/user-settings/schema') body = {engine:[],mapEngine:[],partitionEngine:[],game:[],partition:[],serverCustom:[]};
      if (url.pathname === '/api/maps/spicefields') body = {mode:'resourcefields',activeFields:[{field_id:'1234567890000000001',map_name:'HaggaBasin',field_type:'Small',dimension_index:0,spawn_time:10,value_remaining:5000}],fields:[],capabilities:{spicefields:true}};
      if (url.pathname === '/api/maps/choam-terminals') {
        const transform={x:0,y:0,z:0,qx:0,qy:0,qz:0,qw:1};
        body={supported:true,tradeCenters:[{key:'the-anvil',name:'The Anvil',transform,defaultTransform:transform,custom:false}],sietches:[{partitionId:1,name:'Desert Sietch',map:'Survival_1'}],placements:[],positionLimits:{radiusUu:5000,verticalUu:2000}};
      }
      if (url.pathname === '/api/care-package/config') body = {enabled:false,version:'starter',activeKitId:'starter',autoGrantKitId:'starter',kits:[{id:'starter',name:'Starter Package',items:[{itemName:'Plant Fiber',itemId:'PlantFiber',quantity:100}],xp:100}],items:[],xp:100,allowRepeatGrants:false,autoGrantEnabled:false,autoGrantIntervalSeconds:60,grantWhen:'first_online',autoGrantRules:[]};
      if (url.pathname === '/api/exchange/market/items') body = {capabilities:{exchangeMarket:true},rows:[{templateId:'FixtureWeapon',displayName:'Advanced Desert Infantry Weapon',category:'ranked_weapons',qualityLevel:3,price:123456789,listings:2,enabled:true,overridden:false,isNew:false,unsafe:false}]};
      if (url.pathname === '/api/bases') body = { rows: [{base_id:'6001',name:'Southern Basin Crafting Outpost',owner_name:'Desert Explorer With A Long Name',base_type:'Advanced Sub-Fief',shared_with:[],map:'HaggaBasin',partition_id:1,piece_count:10000,placeable_count:1200,generatorCount:3,generatorRuntimeSeconds:360000,generators:[]}], totalCount:1, totalBases:1, capabilities:{bases:true,baseDelete:true,baseDeleteQueue:true,generatorRefillQueue:true,waterRefillQueue:true,baseChildAccessQueue:true} };
      if(['/api/bases/pending-refills','/api/bases/pending-water-refills','/api/bases/pending-deletes','/api/bases/pending-child-access'].includes(url.pathname)) body={supported:true,total:1,pending:[{baseId:'6001',map:'HaggaBasin',partitionId:1,queuedAt:new Date().toISOString(),updates:[{actorId:'100',accessLevel:1}]}],byTarget:[]};
      if (url.pathname.includes('/updates/check-')) body = { task: { id: 'fixture', status: 'succeeded', logLines: [], warnings: [] } };
      return route.fulfill({ json: body });
    }
    const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root) || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
    const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream';
    return route.fulfill({ contentType, body: readFileSync(file) });
  });
  await page.goto('http://console.test/');
  await page.getByRole('button', { name: 'Expand Server Startup' }).waitFor();
  const sections = await page.getByRole('button', { name: /^Expand / }).evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  for (const name of sections) await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('button',{name:'Create Key',exact:true}).waitFor();
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    await checkCommunityButtons(page);
    const toggle = page.getByRole('button', { name: 'Open navigation' });
    if (width <= 900 && await toggle.isVisible()) await toggle.click();
    for (const selector of ['.sidebar', '.sidebar-nav']) {
      assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).overflowY), 'visible', `${selector} must not have its own scrolling area`);
    }
    const help = page.locator('.sidebar-nav').getByRole('link', { name: 'Get Help', exact: true });
    await help.scrollIntoViewIfNeeded();
    const bounds = await help.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height, `last navigation link reachable at ${width}x${height}`);
    assert.equal(await help.evaluate(el => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, 'link is not clipped by the navigation');
    assert.equal(await page.locator('.sidebar-nav').evaluate(el => el.scrollTop), 0, 'navigation uses page scrolling');
    if (width <= 900) {
      await page.getByRole('button', { name: 'Close navigation' }).click();
      assert.equal(await page.locator('.sidebar-nav').isVisible(), false);
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no page overflow');
  }
  for (const tab of ['Live Map', 'Players', 'Guilds', 'Vehicles', 'Bases', 'Exchange', 'Care Package', 'Backups', 'Server Control', 'Logs', 'Admin Tools']) {
    await page.evaluate(tab => sessionStorage.setItem('dune-console:active-tab', tab), tab);
    await page.reload();
    await page.locator('main h2').first().waitFor();
    if(tab==='Live Map') await page.getByRole('button',{name:'Deep Desert',exact:true}).waitFor();
    if(tab==='Bases') await page.getByRole('button',{name:'Discard Queued Permission Changes',exact:true}).waitFor();
    if(tab==='Exchange'){
      await page.getByRole('tab',{name:'Bot Items',exact:true}).click();
      await page.getByLabel('Advanced Desert Infantry Weapon Price',{exact:true}).waitFor();
    }
    if(tab==='Care Package')await page.getByRole('button',{name:'Edit',exact:true}).click();
    if(tab==='Admin Tools') await page.getByRole('button',{name:'Expand Schedule Server Restart',exact:true}).click();
    for (const [width,height] of sizes) {
      await page.setViewportSize({width,height});
      assert.equal(await page.getByText('Could not load this section.', {exact:true}).count(),0,`${tab} rendered`);
      if (width<=560 && ['Players','Bases'].includes(tab)) {
        const pagination=page.locator('.database-pagination-controls').first();
        assert.ok((await pagination.boundingBox()).height<110,'phone pagination uses two compact rows');
        const buttons=await pagination.locator('button').all();
        const boxes=await Promise.all(buttons.map(button=>button.boundingBox()));
        assert.ok(Math.max(...boxes.map(r=>r.y))-Math.min(...boxes.map(r=>r.y))<2,'paging buttons remain on the same row');
        const search=page.locator(tab==='Players'?'.players-search-row':'.bases-search-row');
        assert.ok((await search.locator('input').boundingBox()).width>width*.7,'phone search field has readable width');
        for(const button of await search.locator('button').all())assert.ok((await button.boundingBox()).width>=100,'search actions retain readable captions');
      }
      if(tab==='Bases' && width<=1800){
        const head=await page.locator('.bases-table thead').boundingBox(),row=await page.locator('.bases-table tbody tr').first().boundingBox();
        assert.ok(row.y>=head.y+head.height-1,'mobile table header never covers the first base');
        assert.ok((await page.locator('.bases-table tbody tr').first().locator('td').nth(4).boundingBox()).width>=85,'base owner names have readable column width');
        for(const cell of await page.locator('.bases-table thead th').all()) assert.ok(await cell.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'base column headings never overlap');
      }
      if(tab==='Bases'){
        const cell=page.locator('.bases-actions-column').last();
        assert.equal(await cell.getByRole('button').count(),5,'all four queued controls and the download action are present');
        for(const button of await cell.getByRole('button').all()){
          const fits=await button.evaluate(e=>{const b=e.getBoundingClientRect(),c=e.closest('td').getBoundingClientRect();return b.left>=c.left&&b.right<=c.right&&b.top>=c.top&&b.bottom<=c.bottom});
          assert.ok(fits,'queued action remains inside its column');
          await button.scrollIntoViewIfNeeded();
          assert.ok(await button.evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}),'queued action remains reachable after scrolling');
        }
      }
      if(['Players','Guilds','Vehicles','Bases'].includes(tab) && width>=(tab==='Bases'?1440:1280)){
        const wrap=page.locator('.table-wrap').first();
        assert.ok(await wrap.evaluate(e=>e.scrollWidth<=e.clientWidth+1),`${tab} uses available panel width at ${width}px without unnecessary horizontal scrolling`);
        for(const th of await wrap.locator('thead th').all())assert.ok(await th.evaluate(e=>e.scrollWidth<=e.clientWidth+1),`${tab} headings remain readable`);
      }
      if(['Players','Guilds','Vehicles','Bases'].includes(tab)){
        for(const th of await page.locator('.table-wrap').first().locator('thead th').all())assert.ok(await th.evaluate(e=>e.scrollWidth<=e.clientWidth+1),`${tab} heading ${await th.textContent()} fits at ${width}px`);
      }
      if(tab==='Live Map'){
        for(const map of ['Hagga Basin','Deep Desert']){
          await page.getByRole('button',{name:map,exact:true}).click();
          const controls=page.locator('.live-map-view-controls');
          const boxes=await controls.locator('button,select').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {height:r.height,width:r.width,scroll:e.scrollWidth,client:e.clientWidth,whiteSpace:getComputedStyle(e).whiteSpace,tag:e.tagName}}));
          assert.equal(boxes.length,3,'both map buttons and the partition dropdown are exercised');
          assert.ok(Math.max(...boxes.map(r=>r.height))-Math.min(...boxes.map(r=>r.height))<=1,'map buttons match partition dropdown height');
          for(const box of boxes.filter(r=>r.tag==='BUTTON')){
            assert.equal(box.whiteSpace,'nowrap','map names stay on one line');
            assert.ok(box.scroll<=box.client,'map name is not clipped');
          }
        }
      }
      if(['Exchange','Care Package'].includes(tab)){
        const table=page.locator(tab==='Exchange'?'.bot-items-table':'.package-items-table table');
        if(width>=1280)assert.ok(await table.evaluate(e=>e.getBoundingClientRect().width<=e.parentElement.clientWidth+1),`${tab} table fits the panel`);
        for(const control of await table.locator('button,input,select').all()){
          assert.ok(await control.evaluate(e=>{const b=e.getBoundingClientRect(),c=e.closest('th,td').getBoundingClientRect();return b.left>=c.left&&b.right<=c.right+1}),`${tab} table controls stay inside their columns`);
        }
        if(tab==='Care Package')assert.equal(await table.getByRole('button').count(),3,'Save, Cancel and Remove are all visible while editing');
      }
      if(tab==='Backups'){
        for(const field of await page.locator('.backup-number-unit').all()){
          const input=await field.locator('input').boundingBox(),unit=await field.locator('span').boundingBox();
          assert.ok(input.width>=90,'backup value remains readable');
          assert.ok(unit.x>=input.x+input.width && Math.abs(unit.y+unit.height/2-input.y-input.height/2)<2,'unit stays beside its value');
        }
      }
      if(tab==='Logs'){
        const select=await page.getByRole('combobox').first().boundingBox();
        const refresh=await page.getByRole('button',{name:'Refresh Logs',exact:true}).boundingBox();
        assert.ok(Math.abs(select.height-refresh.height)<=2,'dropdown and adjacent refresh action have matching heights');
      }
      if(tab==='Admin Tools'){
        for(const field of await page.locator('.schedule-action-line label.compact-select').all()){
          const label=await field.boundingBox(),input=await field.locator('input').boundingBox();
          assert.ok(input.x+input.width<=label.x+label.width+1,'schedule input stays inside its field and clear of adjacent actions');
        }
      }
      if(tab==='Server Control' && width<=560){
        const pairs=await page.locator('.action-row').evaluateAll(rows=>rows.flatMap(row=>{
          const buttons=[...row.children].filter(e=>e.tagName==='BUTTON').map(e=>e.getBoundingClientRect()).filter(r=>r.width&&r.height);
          return buttons.flatMap(a=>buttons.filter(b=>b.x>=a.right&&b.x-a.right<20&&Math.abs(a.y+a.height/2-b.y-b.height/2)<2).map(b=>[a.height,b.height]));
        }));
        if(width>=390)assert.ok(pairs.length>0,'server action row is exercised');
        for(const [a,b]of pairs)assert.ok(Math.abs(a-b)<=2,'adjacent action buttons match height when captions wrap');
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${tab} fits ${width}px`);
    }
    if(tab==='Players'){
      await page.getByText('Desert Explorer With A Long Name',{exact:true}).first().click();
      await page.locator('.playerAdmin_tabs').waitFor();
      for(const [section,selector] of [['Character','.player-inventory-table'],['Crafting','.playerAdmin_craftingTable'],['Research','.playerAdmin_researchTable'],['Specialization','.playerAdmin_specializationTable'],['Blueprints','.blueprints-table']]){
        await page.locator('.playerAdmin_tabs').getByRole('button',{name:section,exact:true}).click();
        if(section==='Character')await page.getByRole('button',{name:/^Inventory \(/}).click();
        const table=page.locator(selector);
        await table.locator('tbody tr').first().waitFor();
        for(const [width,height]of sizes){
          await page.setViewportSize({width,height});
          if(width>=1280)assert.ok(await table.evaluate(e=>e.getBoundingClientRect().width<=e.parentElement.clientWidth+1),`${section} uses the available detail panel width`);
          for(const control of await table.locator('button,input,select').all())assert.ok(await control.evaluate(e=>{const r=e.getBoundingClientRect(),c=e.closest('td,th').getBoundingClientRect();return r.left>=c.left&&r.right<=c.right+1}),`${section} controls are not clipped by their cells`);
          for(const cell of await table.locator('th').all())assert.ok(await cell.evaluate(e=>e.scrollWidth<=e.clientWidth+1),`${section} ${await cell.textContent()} heading fits at ${width}px`);
          assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${section} detail panel fits ${width}px`);
          for(const rail of await page.locator('.playerAdmin_iconRailItems').all()){
            assert.ok(await rail.evaluate(e=>e.scrollWidth<=e.clientWidth+1),`${section} categories fit without clipping or scrolling`);
            for(const item of await rail.locator('button,.playerAdmin_iconRailLabel').all())assert.ok(await item.evaluate(e=>{const r=e.getBoundingClientRect(),c=e.closest('.playerAdmin_iconRailItems').getBoundingClientRect();return r.left>=c.left&&r.right<=c.right+1}),`${section} category icons and label remain visible`);
          }
        }
        if(section==='Character'){
          await page.getByRole('button',{name:'Give Items',exact:true}).click();
          await page.locator('.catalog-item-option').filter({hasText:'Plant Fiber'}).click();
          await page.getByRole('button',{name:'Add Item',exact:true}).click();
          const packageTable=page.locator('.playerAdmin_itemsTable table');
          await packageTable.getByRole('button',{name:'Edit',exact:true}).click();
          for(const [width,height]of sizes){
            await page.setViewportSize({width,height});
            if(width>=1280)assert.ok(await packageTable.evaluate(e=>e.getBoundingClientRect().width<=e.parentElement.clientWidth+1),'Give Items draft fits its panel');
            for(const cell of await packageTable.locator('th').all())assert.ok(await cell.evaluate(e=>e.scrollWidth<=e.clientWidth+1),`Give Items ${await cell.textContent()} heading fits at ${width}px`);
            for(const control of await packageTable.locator('button,input,select').all())assert.ok(await control.evaluate(e=>{const r=e.getBoundingClientRect(),c=e.closest('td').getBoundingClientRect();return r.left>=c.left&&r.right<=c.right+1}),'Give Items edit controls stay in their cells');
          }
        }
      }
      await page.locator('.playerAdmin_tabs').getByRole('button',{name:'Admin',exact:true}).click();
      await page.getByRole('combobox',{name:'Deleted character to recover'}).waitFor();
      for(const [width,height]of sizes){
        await page.setViewportSize({width,height});
        assert.equal(await page.getByText('Could not load this section.',{exact:true}).count(),0,'Player Admin rendered');
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Player Admin fits ${width}px`);
        for(const control of await page.locator('.playerAdmin_content button,.playerAdmin_content input,.playerAdmin_content select').all()){
          if(!await control.isVisible())continue;
          assert.ok(await control.evaluate(e=>{const r=e.getBoundingClientRect(),c=e.closest('.playerAdmin_content').getBoundingClientRect();return r.left>=c.left&&r.right<=c.right+1}),'Player Admin controls stay inside the panel');
        }
      }
    }
  }
  await page.evaluate(()=>sessionStorage.setItem('dune-console:active-tab','Maps'));
  await page.reload();
  await page.getByRole('button',{name:'Expand Interactive Modifiers',exact:true}).click();
  for(const [name,selector]of [['Spice Fields','.spicefields-table'],['CHOAM Terminals','.choam-terminals-table']]){
    await page.getByRole('tab',{name,exact:true}).click();
    const table=page.locator(selector);
    await table.locator('tbody tr').first().waitFor();
    for(const [width,height]of sizes){
      await page.setViewportSize({width,height});
      if(width>=1280)assert.ok(await table.evaluate(e=>e.getBoundingClientRect().width<=e.parentElement.clientWidth+1),`${name} fits its panel`);
      for(const cell of await table.locator('th').all())assert.ok(await cell.evaluate(e=>e.scrollWidth<=e.clientWidth+1),`${name} heading fits`);
      for(const control of await table.locator('button,input,select').all())assert.ok(await control.evaluate(e=>{const r=e.getBoundingClientRect(),c=e.closest('td,th').getBoundingClientRect();return r.left>=c.left&&r.right<=c.right+1}),`${name} controls stay in their columns`);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${name} fits ${width}px`);
    }
    if(name==='CHOAM Terminals'){
      await page.getByRole('button',{name:'Set Position',exact:true}).click();
      for(const [width,height]of sizes){
        await page.setViewportSize({width,height});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`CHOAM position editor fits ${width}px`);
      }
    }
  }
  firstRun=true;
  await page.reload();
  await page.locator('.wizard h2').waitFor();
  for(const [width,height]of sizes){
    await page.setViewportSize({width,height});
    if(width<=900){
      const stepper=page.locator('.stepper');
      assert.equal(await stepper.evaluate(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length),width<=560?2:3,'setup steps use available screen width');
      assert.ok((await stepper.boundingBox()).height<=350,'step list leaves room for the active form');
      const actions=await page.locator('.wizard-controls button').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().y));
      assert.ok(Math.max(...actions)-Math.min(...actions)<1,'Back and Next share a row');
    }
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'setup fits the viewport');
  }
  assert.deepEqual(errors, []);
  console.log('PASS navigation, pagination, populated table fit, headers, both Live Map choices, backup units and control heights at ten viewport sizes');
} finally { await browser.close(); }
