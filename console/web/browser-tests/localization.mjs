// Run against built assets. Every request is intercepted; no live Console or
// translation provider is contacted. Optional CONSOLE_BROWSER_DIST tests an image export.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { SUPPORTED_LANGUAGES } from '../../api/src/services/i18nService.js';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(process.env.CONSOLE_BROWSER_DIST || resolve(web, 'dist'));
const seed = JSON.parse(readFileSync(resolve(web, '../api/data/i18n-translations-db.json'), 'utf8'));
const compiled = ts.transpileModule(readFileSync(resolve(web, 'src/features/server/homeStatusFixtures.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { statusText, READY_READINESS } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });
const rtl = new Set(['AR', 'HE', 'FA', 'UR']);
let firstRun = false;
let translationUploads = 0;
let suggestion;
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('dune-console:active-tab', 'Home'));
  await page.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== 'console.test') return route.abort();
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/i18n/translate') translationUploads++;
      if (request.method() === 'POST' && url.pathname === '/api/i18n/suggestions') {
        suggestion = JSON.parse(request.postData());
        return route.fulfill({status:201,json:{id:'125e4567-e89b-42d3-a456-426614174000',status:'pending'}});
      }
      if (request.method() !== 'GET') return route.abort();
      let body = { ok: true, stdout: '', items: [], tasks: [], entries: [], addons: [], pending: [], byTarget: [], rows: [], total: 0 };
      if (url.pathname === '/api/auth/state') body = { authenticated: true, csrfToken: 'fixture', config: { version: '1.4.56' } };
      if (url.pathname === '/api/setup/state') body = { files: { complete: !firstRun }, config: {} };
      if (url.pathname === '/api/settings') body = { config: {}, files: {}, serverStartup: { settings: {} } };
      if (url.pathname === '/api/server/status') body = { stdout: statusText(), sampledAt: new Date().toISOString() };
      if (url.pathname === '/api/server/readiness') body = { stdout: READY_READINESS, sampledAt: new Date().toISOString() };
      if (url.pathname === '/api/server/performance') body = null;
      if (url.pathname === '/api/server/restart-history') body = { rows: [], lastBattlegroupRestart: null };
      if (url.pathname === '/api/i18n/languages') body = {
        totalSourceStrings: seed.sourceStrings.length,
        languages: SUPPORTED_LANGUAGES.map(language => ({ ...language, translatedCount: seed.sourceStrings.length, coveragePercent: 100, cachedInDb: true })),
        mesh: { peerSyncEnabled: false, peers: [] }, autoSyncLanguages: []
      };
      if (url.pathname === '/api/i18n/translations') {
        const lang = url.searchParams.get('lang') || 'EN';
        body = { lang, dir: rtl.has(lang) ? 'rtl' : 'ltr', translations: lang==='EN'?Object.fromEntries(seed.sourceStrings.map(source=>[source,source])):seed.translations[lang] || {} };
      }
      return route.fulfill({ json: body });
    }
    const file = resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(root + '/') || !existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' })[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
  });
  async function selectLanguage(lang) {
    await page.evaluate(lang => {
      localStorage.setItem('dune-console:language', lang);
      dispatchEvent(new CustomEvent('dune-console:language-change', { detail: { lang } }));
    }, lang);
    await page.waitForFunction(lang => document.documentElement.lang === lang.toLowerCase(), lang);
    assert.equal(await page.locator('html').getAttribute('dir'), rtl.has(lang) ? 'rtl' : 'ltr');
  }
  async function checkBackdrop(lang, width) {
    await page.setViewportSize({ width, height: 1000 });
    const bounds = await page.evaluate(() => {
      const background = document.querySelector('.home-backdrop').getBoundingClientRect();
      const main = document.querySelector('.home-main').getBoundingClientRect();
      return { left: background.left, right: background.right, mainLeft: main.left, mainRight: main.right };
    });
    assert.ok(bounds.left <= bounds.mainLeft + 1 && bounds.right >= bounds.mainRight - 1, `${lang} at ${width}px: background does not cover main content: ${JSON.stringify(bounds)}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${lang}: horizontal overflow at ${width}px`);
    if (!firstRun) {
      const shortcut = page.locator('.topbar-links .language-shortcut');
      assert.ok(await shortcut.isVisible(), `${lang}: language icon hidden at ${width}px`);
      assert.equal(await shortcut.innerText(), '', 'Language shortcut should be icon-only');
      const icon = await shortcut.boundingBox();
      const discord = await page.locator('.topbar-links .discord').boundingBox();
      assert.ok(icon.width >= 44 && icon.height >= 44, 'Language icon needs a usable touch target');
      assert.ok(icon.x + icon.width <= discord.x + 1 && Math.abs(icon.y + icon.height / 2 - discord.y - discord.height / 2) < 2, `${lang}: language icon must remain immediately left of Discord at ${width}px`);
    }
  }
  await page.goto('http://console.test/');
  await page.locator('.home-backdrop').waitFor({ state: 'attached' });
  // Header access replaces sidebar navigation and remains available on the
  // Language page itself, including with the mobile navigation collapsed.
  for (const lang of ['EN', 'HE']) {
    await selectLanguage(lang);
    await page.setViewportSize({ width: 390, height: 1000 });
    assert.equal(await page.locator('.sidebar-nav button').filter({ hasText: /^Language$/ }).count(), 0);
    await page.locator('.language-shortcut').click();
    await page.locator('.language-panel').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${lang}: Language page overflows on mobile`);
    assert.equal(await page.locator('.language-shortcut').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('dune-console:active-tab')), 'Home');
    await page.locator('.language-picker-heading > button').click();
    await page.locator('.home-backdrop').waitFor({ state: 'attached' });
    assert.equal(await page.locator('.language-shortcut').getAttribute('aria-expanded'), 'false');
  }
  for (const lang of ['EN', 'DE', 'ES', 'AR', 'HE', 'FA', 'UR']) {
    await selectLanguage(lang);
    for (const width of [320, 390, 768, 1440, 1920]) await checkBackdrop(lang, width);
    if (lang !== 'EN') {
      for (const source of ['Battlegroup Services', 'Game Servers', 'Readiness & Health']) {
        const key = Object.keys(seed.translations[lang]).find(key => key.toLowerCase() === source.toLowerCase());
        assert.ok(key, `${lang}: missing ${source}`);
        await page.getByText(seed.translations[lang][key], { exact: true }).first().waitFor();
      }
    }
  }
  await selectLanguage('EN');
  await page.setViewportSize({width:390,height:1000});
  await page.locator('.language-shortcut').click();
  if(process.env.TRANSLATION_SCREENSHOTS)await page.screenshot({path:resolve(process.env.TRANSLATION_SCREENSHOTS,'console-language-picker.png')});
  await page.getByRole('button',{name:'Suggest a Translation Fix'}).click();
  await page.getByLabel('Language',{exact:true}).selectOption('DE');
  await page.getByLabel('Find the Incorrect Text').fill('Home');
  await page.locator('.language-phrase-results button').filter({has:page.getByText('Home',{exact:true})}).first().click();
  await page.getByLabel('Your Correction').fill('Reviewed Startseite');
  await page.getByLabel('Name for Credits (Optional)').fill('Fixture Translator');
  if(process.env.TRANSLATION_SCREENSHOTS)await page.screenshot({path:resolve(process.env.TRANSLATION_SCREENSHOTS,'console-translation-correction.png')});
  await page.getByRole('button',{name:'Submit Correction'}).click();
  await page.getByText('Thank You for Your Suggestion').waitFor();
  assert.deepEqual(suggestion,{lang:'DE',source:'Home',translation:'Reviewed Startseite',credit:'Fixture Translator'});
  await page.getByRole('button',{name:'Done',exact:true}).click();
  // First-run setup uses the same observer and a full-width background.
  firstRun = true;
  await page.reload();
  await page.locator('.setup-only-shell .home-backdrop').waitFor({ state: 'attached' });
  for (const lang of ['EN', 'HE']) {
    await selectLanguage(lang);
    for (const width of [390, 1440]) await checkBackdrop(lang, width);
  }
  assert.equal(translationUploads, 0);
  assert.deepEqual(errors, []);
  console.log('PASS: header language icon stays left of Discord and opens the existing picker in LTR/RTL/mobile; translated Home labels and background coverage pass at five widths; setup supports both directions; zero text uploads or browser errors.');
} finally {
  await browser.close();
}
