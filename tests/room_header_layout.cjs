/* Render the squeeze bug, not just document.scrollWidth. Optional BASE tests live UI. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const {spawn}=require('node:child_process');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),tmpRoot=process.env.TMPDIR||path.join(root,'.tmp');fs.mkdirSync(tmpRoot,{recursive:true});
const out=fs.mkdtempSync(path.join(tmpRoot,'b2b-header-')),results=[];let server,browser,serverLog='';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function layout(page,label){
 const data=await page.evaluate(()=>{
  const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
  const visible=e=>e&&getComputedStyle(e).display!=='none'&&e.getBoundingClientRect().width>0&&e.getBoundingClientRect().height>0;
  const selectors=['.wordmark','.room-top__title','#status-pill','#copy-menu-btn','#save-chat','#topbar-search','#topbar-signin','#topbar-settings','#topbar-people','#topbar-leave'];
  const items=selectors.map(s=>[s,document.querySelector('.room-top '+s)]).filter(([,e])=>visible(e)).map(([s,e])=>({selector:s,...rect(e)}));
  const labels=['.meeting','.meta','#status-label','#topbar-signin-label'].map(s=>[s,document.querySelector('.room-top '+s)]).filter(([,e])=>visible(e)).map(([s,e])=>{const range=document.createRange();range.selectNodeContents(e);return {selector:s,box:rect(e),lines:[...range.getClientRects()].filter(r=>r.width>0&&r.height>0).map(r=>({top:r.top,bottom:r.bottom})),whiteSpace:getComputedStyle(e).whiteSpace};});
  return {width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth,quick:rect(document.querySelector('#agent-quickstart')),header:rect(document.querySelector('.room-top')),main:rect(document.querySelector('.room-main')),composer:rect(document.querySelector('#composer')),items,labels};
 });
 const errors=[],eps=1;
 if(data.scroll>data.width+eps)errors.push('horizontal overflow');
 if(data.header.y<data.quick.bottom-eps)errors.push('header overlaps quickstart');
 if(data.main.y<data.header.bottom-eps)errors.push('main overlaps header');
 for(const r of data.items){if(r.x < -eps||r.right>data.width+eps||r.y<data.header.y-eps||r.bottom>data.header.bottom+eps)errors.push(r.selector+' escapes header');}
 for(let i=0;i<data.items.length;i++)for(let j=i+1;j<data.items.length;j++){const a=data.items[i],b=data.items[j];if(Math.min(a.right,b.right)-Math.max(a.x,b.x)>eps&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>eps)errors.push(a.selector+' overlaps '+b.selector);}
 for(const l of data.labels){if(l.lines.some(r=>r.top<data.header.y-eps||r.bottom>data.header.bottom+eps))errors.push(l.selector+' paints outside header');if(l.selector!=='.meta'&&new Set(l.lines.map(r=>Math.round(r.top))).size>1)errors.push(l.selector+' wraps onto multiple lines');}
 if(data.composer.bottom>data.height+eps||data.composer.y<data.main.y-eps)errors.push('composer outside available main/viewport');
 const result={label,ok:errors.length===0,errors,geometry:data};results.push(result);return result;
}
(async()=>{
 let base=process.env.BASE;
 if(!base){const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));base='http://127.0.0.1:'+port;server=spawn(process.execPath,['server/index.js'],{cwd:root,env:{...process.env,PORT:String(port),B2B_DATA_DIR:path.join(out,'data'),IDENTITY_STATE_FILE:path.join(out,'identities.json'),AGENT_DIRECTORY_ENABLED:'0',AGENT_DIRECTORY_GREETERS_ONLINE:'0'},stdio:['ignore','pipe','pipe']});server.stdout.on('data',d=>serverLog+=d);server.stderr.on('data',d=>serverLog+=d);let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await sleep(50);}assert(ready,'isolated relay failed: '+serverLog);}
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:960,height:640},deviceScaleFactor:4/3});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const url=base+'/room/LAYOUT'+crypto.randomBytes(2).toString('hex').toUpperCase()+'#k='+crypto.randomBytes(32).toString('base64url');
 await page.goto(url,{waitUntil:'domcontentloaded'});await page.evaluate(()=>document.fonts.ready);await page.waitForFunction(()=>document.querySelector('#rail-room-id')?.textContent.includes('LAYOUT'));await sleep(400);
 await page.evaluate(()=>{document.querySelector('#meta-count').textContent='2 participants';});
 const first=await layout(page,'960x640@133%-raster');await page.screenshot({path:path.join(out,'squeeze-960.png')});
 if(process.env.REPRO_ONLY==='1'){assert(first.ok,JSON.stringify(first));return;}
 for(const height of [720,320])for(const width of [1440,1280,1200,1100,1024,1000,980,960,920,900,860,821,820,768,640,561,560,430,390,360,320]){await page.setViewportSize({width,height});await layout(page,width+'x'+height);}
 for(const width of [960,390]){await page.setViewportSize({width,height:320});await page.locator('#agent-quickstart').evaluate(e=>e.open=true);await layout(page,width+'x320-expanded');await page.locator('#agent-quickstart').evaluate(e=>e.open=false);}
 for(const height of [640,320])for(const width of [960,640,390,320]){await page.setViewportSize({width,height});await page.locator('#copy-menu-btn').click();assert(await page.locator('#copy-menu').isVisible());await page.keyboard.press('Escape');await page.locator('#topbar-settings').click();assert(await page.locator('.settings-pop__head').first().isVisible());const pop=await page.locator('.settings-pop').boundingBox();assert(pop.x>=0&&pop.x+pop.width<=width+1&&pop.y+pop.height<=height+1,'settings popover escapes '+width+'px viewport: '+JSON.stringify(pop));await page.locator('#topbar-settings').click();assert.equal(await page.locator('.settings-pop').count(),0);await page.locator('#message').fill('Layout QA only, not sent');await page.locator('#message').fill('');await sleep(300);await page.screenshot({path:path.join(out,'room-'+width+'-'+height+'.png')});results.push({label:'menus-'+width+'x'+height,ok:true,settings:pop});}
 assert.deepEqual(errors,[],'page errors');const failed=results.filter(r=>!r.ok);assert.equal(failed.length,0,JSON.stringify(failed));
 console.log(JSON.stringify({ok:true,checked:results.length,out}));
})().catch(e=>{console.error(String(e.stack||e).replace(/(#k=)[A-Za-z0-9_=-]+/g,'$1[REDACTED]'));process.exitCode=1;}).finally(async()=>{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({results},null,2));if(browser)await browser.close();if(server)server.kill('SIGTERM');console.log('Evidence: '+out);});
