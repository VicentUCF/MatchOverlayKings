/* global window, document, console, navigator */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { createServer } from 'vite';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const html = `<!doctype html><html lang="es"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prueba local de realización</title><body><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import {ProductionTabbedWorkspace} from '/src/components/ProductionOverview.tsx';
import '/src/styles/global.css';
const courts=[1,2,3].map(n=>({slug:'pista-'+n,name:'Pista '+n,courtId:'court-'+n,productionEnabled:true,assignment:null}));
const configurations=courts.map(c=>({courtSlug:c.slug,mode:'youtube',sourceId:'mobile:pilot',homeTeam:'Kings',awayTeam:'Lions',seasonLabel:'T2',matchdayNumber:1,scheduledAt:'2099-01-01T12:00:00Z',privacyStatus:'private',updatedAt:'2026-09-19T12:00:00Z'}));
const sessions=courts.map((c,i)=>({id:'session-'+i,courtSlug:c.slug,mode:'youtube',source:{id:'mobile:pilot',kind:'mobile',label:'Cámara Android'},status:'live',title:'Kings vs Lions · Jornada 1',description:'Partido',thumbnailUrl:'/fixture-thumbnail',broadcastId:'example'+i,watchUrl:'https://www.youtube.com/watch?v=example'+i,youtubeStreamStatus:'active · good',encoder:{framesPerSecond:30,bitrateKbps:6100,speed:1,frame:18000},startedAt:new Date(Date.now()-600000).toISOString(),stoppedAt:null,error:null,signal:{checking:false,sampledAt:new Date().toISOString(),audioExpected:true,measuredFramesPerSecond:30,measuredSpeed:1,measuredBitrateKbps:6100,droppedFrameRatio:0,issues:i===1?[{code:'frozen_video',message:'La imagen apenas cambia durante al menos 8 s. Comprueba la cámara.'}]:[]}}));
const mobileCameras=courts.map((c,i)=>({id:'camera-'+i,courtSlug:c.slug,state:'ready',claimed:true,desired:{revision:1,cameraId:'back',profile:'1080p30',audioEnabled:true},applied:{revision:1,cameraId:'back',profile:'1080p30',audioEnabled:true,width:1920,height:1080,framesPerSecond:30},capabilities:null,metrics:{bitrateKbps:6000,packetLossPercent:0,roundTripTimeMs:20},lastHeartbeatAt:new Date().toISOString(),expiresAt:'2099-01-01T12:00:00Z',error:null,previewUrl:'http://127.0.0.1:5197/fixture-camera/'+i}));
const initial={kind:'ready',confirmedAt:Date.now(),readiness:{ffmpeg:{available:true,version:'fixture'},youtube:{configured:true,authorized:true,authorizationUrl:null},sources:[sessions[0].source],limitations:[]},teams:[{id:'kings',name:'Kings'},{id:'lions',name:'Lions'}],configurations,sessions,mobileCameras,mobileConnectUrls:{},refreshing:false,pendingCourts:[],courtErrors:{},error:null};
window.fixtureActions=[];
function Fixture(){
 const [state,setState]=React.useState(initial);
 window.setRuntimeStale=()=>setState(s=>({...s,error:'No se pudo conectar con el runtime.'}));
 window.resetRuntime=()=>setState({...initial,confirmedAt:Date.now()});
 const record=kind=>async value=>{window.fixtureActions.push({kind,id:value?.id});};
 const noop=async()=>{};
 const pilot={state,localAdminUrl:'/',refresh:noop,configure:record('configure'),prepare:record('prepare'),start:record('start'),recover:record('recover'),stop:record('stop'),preflight:noop,cancelPreflight:noop,preview:noop,createMobileCamera:noop,updateMobileCamera:noop,revokeMobileCamera:noop};
 return React.createElement(ProductionTabbedWorkspace,{initialArea:'dashboard',pilot,courts,signOut:noop});
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`;

// Local fixture replaces only transport dependencies. No authentication, real
// camera, remote API, scorer mutation or production process is used.
const scoresModule = `import {createInitialMatchState} from '/@fs/${root}/packages/shared/src/index.ts';
const states=new Map(); const subscribers=new Map();
function state(slug){if(!states.has(slug))states.set(slug,createInitialMatchState({id:slug,title:'Kings vs Lions',courtName:slug,homeTeamId:'kings',awayTeamId:'lions',lineups:{home:{player1:'A',player2:'B'},away:{player1:'C',player2:'D'}},servingSide:'home',status:'live',config:{}}));return states.get(slug);}
export async function fetchTeams(){return [{id:'kings',name:'Kings',shortName:'Kings'},{id:'lions',name:'Lions',shortName:'Lions'}];}
export async function fetchEventSummaries(){return [];}
export async function fetchMatchState(slug){if(window.scoreOffline)throw Error('Sin conexión con el marcador');return state(slug);}
export function subscribeToMatchState(slug,callback){subscribers.set(slug,callback);return ()=>subscribers.delete(slug);}
window.updateScore=(slug,points)=>{const current=state(slug);const next={...current,version:current.version+1,currentGame:{...current.currentGame,homePoints:points}};states.set(slug,next);subscribers.get(slug)?.(next);};`;
const cameraModule = `export class WhepPreview {
 constructor(url,onStream){this.onStream=onStream;this.url=url;}
 async connect(){const c=document.createElement('canvas');c.width=640;c.height=360;const ctx=c.getContext('2d');
 ctx.fillStyle='#183745';ctx.fillRect(0,0,640,360);ctx.strokeStyle='#adc7ce';ctx.lineWidth=3;ctx.strokeRect(90,30,460,290);ctx.beginPath();ctx.moveTo(320,30);ctx.lineTo(320,320);ctx.stroke();ctx.fillStyle='white';ctx.font='22px sans-serif';ctx.fillText('Cámara simulada · prueba local',150,185);
 this.stream=c.captureStream(10);this.timer=setInterval(()=>{ctx.fillStyle='#183745';ctx.fillRect(10,325,620,30);ctx.fillStyle='white';ctx.fillText('Prueba '+new Date().toLocaleTimeString(),10,350);},100);this.onStream(this.stream);}
 async close(){clearInterval(this.timer);this.stream?.getTracks().forEach(track=>track.stop());}
}`;
const server = await createServer({ root: `${root}/apps/web`, server: { host: '127.0.0.1', port: 5197, strictPort: true },
  plugins: [{ name: 'production-monitor-fixture', configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const path = req.url?.split('?')[0];
      if (path === '/src/lib/kpl-data.ts' || path === '/src/lib/pilot-mobile-camera.ts') {
        res.setHeader('content-type', 'text/javascript');
        res.end(path.includes('kpl-data') ? scoresModule : cameraModule); return;
      }
      if (path !== '/__monitor' && path !== '/admin') { next(); return; }
      res.setHeader('content-type', 'text/html'); res.end(await server.transformIndexHtml('/__monitor', html));
    });
  } }],
});
let browser;
try {
  await server.listen(); browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value) => { window.copiedLink = value; } } });
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:5197') { await route.abort(); return; }
    if (url.pathname.startsWith('/overlay/')) {
      await route.fulfill({ contentType: 'text/html', body: '<html lang="es"><body style="color:white;background:#142329;font:56px sans-serif">Overlay simulado · Kings 40 / Lions 0</body></html>' }); return;
    }
    if (url.pathname === '/fixture-thumbnail') {
      await route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#253349"/></svg>' }); return;
    }
    await route.continue();
  });
  await page.goto('http://127.0.0.1:5197/__monitor');
  await page.getByRole('cell', { name: '0', exact: true }).first().waitFor();
  assert.equal(await page.locator('video').count(), 3, 'Only the visible dashboard opens camera previews');
  assert.equal(await page.locator('.production-score-monitor').count(), 3);
  assert.match(await page.locator('.production-dashboard-summary').innerText(), /3\/3/);
  assert.equal(await page.getByRole('button', { name: /Punto|Deshacer|Reset/ }).count(), 0);
  await page.evaluate(() => window.updateScore('pista-2', 3));
  await page.locator('[aria-labelledby="dashboard-pista-2"]').getByRole('cell', { name: '40', exact: true }).waitFor();
  await page.locator('[data-monitor-court="pista-2"]').click();
  await page.getByRole('heading', { level: 1, name: 'Pista 2' }).waitFor();
  assert.equal(await page.locator('video').count(), 1, 'Individual view releases other camera previews');
  assert.match(page.url(), /pista=pista-2/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'production-detail-title');
  assert.equal(await page.locator('video').evaluate(video => video.muted), true);
  await page.getByRole('button', { name: 'Escuchar cámara en este PC' }).click();
  assert.equal(await page.locator('video').evaluate(video => video.muted), false);
  assert.deepEqual(await page.evaluate(() => window.fixtureActions), [], 'Listening never mutates the outgoing stream');
  await page.getByText('Enlace y acceso del anotador', { exact: true }).click();
  await page.getByRole('button', { name: 'Copiar enlace para anotador' }).click();
  assert.equal(await page.evaluate(() => window.copiedLink), 'https://live.kingspadelleague.es/control/pista-2');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Detener', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.fixtureActions), [{ kind: 'stop', id: 'session-1' }]);
  await page.getByLabel('Cambiar de pista').selectOption('pista-3');
  await page.getByRole('heading', { level: 1, name: 'Pista 3' }).waitFor();
  assert.equal(await page.locator('video').evaluate(video => video.muted), true, 'Changing court resets listening');
  await page.goBack();
  await page.getByRole('heading', { level: 1, name: 'Pista 2' }).waitFor();
  await page.reload();
  await page.getByRole('heading', { level: 1, name: 'Pista 2' }).waitFor();
  await page.evaluate(() => { window.scoreOffline = true; });
  await page.getByText('Marcador sin confirmar.', { exact: false }).waitFor({ timeout: 10_000 });
  await page.evaluate(() => { window.scoreOffline = false; });
  await page.getByRole('button', { name: 'Todas las pistas', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'production-open-pista-2');
  await page.getByRole('tab', { name: 'Emisiones', exact: true }).click();
  assert.equal(await page.locator('video').count(), 0, 'Hidden tabs do not retain video decoders');
  await page.getByRole('button', { name: 'Abrir ajustes generales' }).click();
  await page.getByLabel('Descripción de los directos').fill('Descripción pendiente de guardar');
  await page.getByRole('button', { name: 'Listo', exact: true }).click();
  await page.getByRole('tab', { name: 'Inicio', exact: true }).click();
  await page.getByRole('tab', { name: 'Emisiones', exact: true }).click();
  await page.getByRole('button', { name: 'Abrir ajustes generales' }).click();
  assert.equal(await page.getByLabel('Descripción de los directos').inputValue(), 'Descripción pendiente de guardar');
  await page.getByRole('button', { name: 'Listo', exact: true }).click();
  await page.getByRole('tab', { name: 'Inicio', exact: true }).click();
  await page.evaluate(() => window.setRuntimeStale());
  await page.getByText('Datos de emisión sin confirmar', { exact: true }).waitFor();
  assert.match(await page.locator('.production-dashboard-summary').innerText(), /Sin confirmar/);
  await page.evaluate(() => window.resetRuntime());
  await mkdir(`${root}/output/ui-ux-audit`, { recursive: true });
  for (const width of [1920, 1366, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width > 1366 ? 1080 : 900 });
    await page.waitForFunction(() => [...document.querySelectorAll('video')].every(video => video.readyState >= 2));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Global overflow at ${width}`);
    await page.screenshot({ path: `${root}/output/ui-ux-audit/global-${width}.png`, fullPage: true });
    await page.locator('[data-monitor-court="pista-2"]').click();
    await page.getByRole('heading', { level: 1, name: 'Pista 2' }).waitFor();
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Individual overflow at ${width}`);
    const duplicateIds = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    });
    assert.deepEqual(duplicateIds, [], 'Mounted tabs and detail must have unique IDs');
    await page.screenshot({ path: `${root}/output/ui-ux-audit/individual-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Todas las pistas', exact: true }).click();
  }
  assert.deepEqual(errors, []);
  console.info('PASS: global/detail, remote scores, stale states, scoped controls, listening, scorer links, history navigation, reload, preserved drafts, preview cleanup and responsive layouts.');
} finally { await browser?.close(); await server.close(); }
