import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=path.resolve(process.env.PREVIEW_DIST || fileURLToPath(new URL('../dist-preview',import.meta.url)));
let apiRequests=0;
const server=http.createServer((req,res)=>{
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'");
 const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/api/')){apiRequests++;res.writeHead(405,{'content-type':'application/json'});res.end('{"error":"Preview Only"}');return;}
 const file=path.resolve(root,'.'+(url.pathname==='/'?'/index.html':decodeURIComponent(url.pathname)));
 if(!file.startsWith(root+'/')||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
 res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml','.gz':'application/octet-stream','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream');
 res.end(fs.readFileSync(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,args:['--no-sandbox']});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000},hasTouch:true});
 page.on('request',request=>{if(new URL(request.url()).pathname.startsWith('/api/'))apiRequests++;});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 page.on('console',message=>{if(message.type()==='error'&&!message.text().includes('404')){console.log('BROWSER '+message.text().slice(0,160));errors.push(message.text().slice(0,160));}});
 await page.addInitScript(()=>{window.__missingPreviewData=[];window.addEventListener('dune-preview:missing-data',event=>window.__missingPreviewData.push(event.detail));});
 await page.goto(process.env.PREVIEW_URL || 'http://127.0.0.1:'+server.address().port);
 await page.locator('.console-preview-notice').waitFor();
 assert.ok((await page.locator('.console-preview-notice').innerText()).includes('close to v1.4.59'));
 assert.ok(!(await page.locator('.console-preview-notice').innerText()).includes('upcoming'));
 assert.ok(await page.locator('.console-preview-notice').evaluate(node=>node.getBoundingClientRect().height<=42),'desktop warning fits on one line');
 assert.ok((await page.locator('.console-preview-notice').innerText()).includes('simplified or not yet populated'));
 assert.equal(await page.locator('.console-preview-notice').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(243, 148, 53)');
 await page.locator('.sidebar-nav').getByRole('button',{name:/^Players/}).waitFor();
 assert.ok((await page.locator('.stack-version-button').innerText()).includes('1.4.59'));
 await page.waitForFunction(()=>document.querySelector('button')!==null);
 assert.equal(await page.getByRole('button',{name:'Restart Battlegroup',exact:true}).isDisabled(),true);
 assert.equal(await page.evaluate(async()=> (await fetch('/api/server/restart',{method:'POST'})).status),405);

 let inspected=0;
 async function report(label){
  await page.waitForTimeout(220);
  const text=await page.locator('main').innerText();
  const empty=await page.locator('main .empty').allTextContents();
  const warnings=text.split('\n').filter(line=>/not loaded|no .*found|no .*yet|unavailable|unknown|NaN|undefined/i.test(line)).slice(0,18);
  console.log(JSON.stringify({view:label,empty,warnings}));
  inspected++;
  assert.deepEqual(empty,[],label+' has populated sample content');
  assert.doesNotMatch(text,/refills, deletes and permissions queued across all maps|Settings saved — apply at the next battlegroup restart|\bPending Restart\b/i,label+' has no queued or pending restart notices');
  assert.ok(!/Cannot read properties|Missing preview fixture|\bNaN\b|\bundefined\b/.test(text),label+' has no fixture errors: '+text.match(/.{0,60}(?:Cannot read properties|Missing preview fixture|\bNaN\b|\bundefined\b).{0,60}/)?.[0]);
 }
 async function expand(){
  for(let pass=0;pass<3;pass++){
   const headers=await page.locator('main button.playerAdmin_toggleHeader, main button[aria-label^="Expand "]').all();
   let opened=0;
   for(const button of headers){
    if(!await button.isVisible()||await button.isDisabled())continue;
    const closed=await button.evaluate(e=>e.getAttribute('aria-label')?.startsWith('Expand ')||(!e.closest('.playerAdmin_toggle')?.classList.contains('open')&&!e.getAttribute('aria-label')?.startsWith('Collapse ')));
    if(closed){await button.click();opened++;await page.waitForTimeout(60);}
   }
   if(!opened)break;
  }
  for(const summary of await page.locator('main details:not([open]) > summary').all()){if(await summary.isVisible())await summary.click();}
 }
 async function roleTabs(label){
  const names=await page.locator('main').getByRole('tab').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')||node.textContent));
  for(const name of [...new Set(names)]){
   const tab=page.locator('main').getByRole('tab',{name:name.trim(),exact:true}).first();
   if(await tab.count()&&await tab.isVisible()&&!await tab.isDisabled()){await tab.click();if(!label.startsWith('Map Modifiers'))await expand();await report(label+'/'+name.trim());}
  }
 }
 const tabs=['Home','Server Control','Players','Guilds','Bases','Vehicles','Exchange','Landsraad','Admin Tools','Live Map','Maps','Care Package','Addons','Database','Backups','Logs','Updates','Settings'];
 for(const name of tabs){
  if(process.env.PREVIEW_PAGES&&!process.env.PREVIEW_PAGES.split(',').includes(name))continue;
  if(process.env.START_AT&&tabs.indexOf(name)<tabs.indexOf(process.env.START_AT))continue;
  await page.locator('.sidebar-nav').getByRole('button',{name:new RegExp('^'+name)}).click();
  await page.waitForTimeout(900);await expand();await report(name);
  if(name==='Maps'){
   await page.waitForFunction(()=>document.querySelectorAll('main .memory-usage-bar').length===36);
   assert.equal(await page.locator('main .memory-usage-bar').count(),36);
   assert.doesNotMatch(await page.locator('main').innerText(),/Waiting for Sample|Unallocated|Not Listed/);
   for(const bar of await page.locator('main .memory-usage-bar').all()){const percent=Number(await bar.getAttribute('aria-valuenow'));assert.ok(percent>0&&percent<100);}
   await page.getByRole('button',{name:'Expand Interactive Modifiers',exact:true}).click();await roleTabs('Map Modifiers');
   for(let index=0;index<5;index++){const button=page.getByRole('button',{name:'Edit',exact:true}).nth(index);if(await button.count()){await button.click();await report('Map Details '+index);}}
  }
  if(name==='Landsraad'){
   assert.equal(await page.locator('.landsraad-task-table tbody tr').count(),25);
   assert.equal(await page.locator('.landsraad-reward-table tbody tr').count(),125);
   for(const input of await page.locator('.landsraad-modifier-group input[type="number"]').all())assert.notEqual(await input.inputValue(),'','persistent modifier has a sample value');
   assert.ok((await page.locator('.landsraad-summary-grid').innerText()).includes('ExperienceRateIncrease'));
  }
  if(name==='Players'){
   assert.equal(await page.locator('main').getByText(/^D0C0A11A[0-9A-F]{8}$/).count(),12,'FLS IDs render in native uppercase hexadecimal format');
   await page.getByRole('radio',{name:'Deleted Characters',exact:true}).check({force:true});await report('Deleted Characters');
   await page.getByRole('radio',{name:'Active Players',exact:true}).check({force:true});
   await page.getByRole('cell',{name:'Aster Vale',exact:true}).first().click();
   await page.locator('.playerAdmin_tabs').waitFor();
   for(const section of await page.locator('.playerAdmin_tabs button').allTextContents()){
    await page.locator('.playerAdmin_tabs').getByRole('button',{name:section.trim(),exact:true}).click();
    await expand();await roleTabs('Player/'+section);await report('Player/'+section);
    if(['Building Sets','Customizations'].includes(section.trim())){
     const table=page.locator('.playerAdmin_previewTable');
     for(const column of ['unlockName','itemId'])for(const cell of await table.locator(`tbody td[data-column="${column}"]`).all())assert.ok((await cell.boundingBox()).width>=90,section+' '+column+' has readable width');
     for(const row of await table.locator('tbody tr').all())assert.ok((await row.boundingBox()).height<140,section+' rows stay compact');
    }
    if(section.trim()==='Character'){
     for(const group of ['Backpack','Character','Loadout','Unique schematics']){
      await page.locator('.playerAdmin_invGroupTabs').getByRole('button',{name:new RegExp('^'+group+' ')}).click();
      const table=page.locator('.playerAdmin_invGroupTabs').locator('..').locator('table').first();
      assert.ok(await table.locator('tbody tr').count()>0,group+' inventory has items');
      for(const cell of await table.locator('tbody tr td:first-child').allTextContents())assert.match(cell.trim(),/^\d{5,9}$/,'inventory ID uses native length');
      const trigger=table.getByRole('button',{name:/^About /}).first();
      await trigger.focus();
      const tooltip=page.getByRole('tooltip').filter({hasText:/^Template ID:/}).first();
      await tooltip.waitFor();
      assert.equal(await tooltip.evaluate(node=>node.parentElement===document.body),true,'template tooltip is portalled outside the table');
      await page.keyboard.press('Escape');
      assert.equal(await trigger.getAttribute('aria-expanded'),'false');
      await trigger.hover();await tooltip.waitFor();
      await page.keyboard.press('Escape');await page.mouse.move(0,0);
      await page.setViewportSize({width:390,height:900});
      await trigger.tap();await tooltip.waitFor();
      const box=await tooltip.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=390,'touch tooltip stays inside the viewport');
      await page.keyboard.press('Escape');await page.setViewportSize({width:1440,height:1000});
     }
    }
    if(['Crafting','Research','Skills'].includes(section.trim())){
     for(const category of await page.locator('main .playerAdmin_iconRailButton').all()){await category.click();await expand();await report('Player/'+section+'/'+await category.getAttribute('title'));}
    }
   }
  }
  if(name==='Backups'){
   const rows=page.locator('.backup-funcom-backups .backup-table tbody tr');
   assert.equal(await rows.count(),4);
   for(const row of await rows.all()){
    const cells=await row.locator('td').allTextContents();
    assert.ok(cells.some(cell=>cell.includes('dune-db-Dawnspire__')),'backup name is displayed');
    assert.ok(cells.some(cell=>cell.includes('Dawnspire')),'battlegroup is displayed');
    assert.ok(cells.some(cell=>/\d{4}-\d{2}-\d{2}/.test(cell)),'creation date is displayed');
    assert.ok(cells.some(cell=>/1\.\d{2} MB/.test(cell)),'realistic backup size is displayed');
    assert.ok(cells.some(cell=>cell.includes('Database Backup')),'backup type is displayed');
    assert.ok(cells.some(cell=>/Scheduled|Manual/.test(cell)),'backup source is displayed');
   }
   assert.equal(await page.locator('.backup-system-backups tbody tr').count(),2);
   assert.doesNotMatch(await page.locator('main').innerText(),/128 MB|256 MB/);
  }
  if(name==='Guilds'){await page.getByRole('cell',{name:'Dawn Seekers',exact:true}).first().click();await expand();await report('Guild Members');}
  if(name==='Bases'){
   await page.getByRole('cell',{name:'Dawnspire Outpost',exact:true}).first().click();await roleTabs('Base Details');
   await page.getByRole('radio',{name:'Base Backups',exact:true}).check({force:true});await report('Base Backups');
  }
  if(name==='Vehicles'){
   await page.getByText('Scout Ornithopter',{exact:true}).first().click();
   const contents=page.getByRole('button',{name:'View Contents',exact:true}).first();
   await contents.click();await page.getByRole('dialog').waitFor();await page.getByRole('dialog').getByRole('button',{name:'List',exact:true}).click();await page.getByRole('dialog').getByText('Steel Ingot',{exact:true}).first().waitFor();await page.keyboard.press('Escape');
   await roleTabs('Vehicle Details');
  }
  if(name==='Addons'){
   for(const row of await page.locator('.addons-table tbody tr').all()){
    const open=row.getByRole('button',{name:'Open',exact:true});
    if(await open.count()){await open.click();await page.locator('.addon-preview').waitFor({timeout:1500}).catch(()=>{});await report('Addon '+await row.locator('td').first().innerText());await row.getByRole('button',{name:'Close',exact:true}).click();}
   }
  }
  if(name==='Care Package'){
   const details=page.getByRole('button',{name:'Details',exact:true}).first();
   if(await details.count()){await details.click();await page.getByRole('dialog').waitFor();assert.ok((await page.getByRole('dialog').innerText()).includes('Succeeded'));await page.keyboard.press('Escape');}
  }
  if(!['Players','Bases','Vehicles'].includes(name))await roleTabs(name);
 }
 console.log('MISSING '+JSON.stringify(await page.evaluate(()=>[...new Set(window.__missingPreviewData)])));
 await page.locator('.language-shortcut').click();await page.getByRole('dialog').getByRole('button',{name:/Deutsch/}).click();await page.waitForFunction(()=>document.documentElement.lang==='de');
 await page.locator('.language-shortcut').click();await page.getByRole('dialog').getByRole('button',{name:/العربية/}).click();await page.waitForFunction(()=>document.documentElement.dir==='rtl');
 await page.locator('.language-shortcut').click();await page.getByRole('dialog').getByRole('button',{name:/English/}).click();await page.waitForFunction(()=>document.documentElement.dir==='ltr');
 for(const width of [390,768,1440]){await page.setViewportSize({width,height:900});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'responsive layout at '+width);}
 console.log('ERRORS '+JSON.stringify(errors));
 assert.deepEqual(await page.evaluate(()=>[...new Set(window.__missingPreviewData)]),[],'all visited views have explicit fixtures');
 assert.deepEqual(errors,[]);
 assert.equal(apiRequests,0,'no real API requests leave the browser');
 console.log('PASS '+inspected+' populated views with no missing fixtures or backend traffic');
}finally{await browser.close();server.close();}
