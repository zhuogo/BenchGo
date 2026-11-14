import {createServer} from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
const require=createRequire(join(process.env.APPDATA,'npm/node_modules/draftgo-cli/package.json'));
const {chromium}=require('playwright-core');
const catalogOnly=process.argv.includes('--catalog-only');
const {publicKey,privateKey}=generateKeyPairSync('ed25519');
const key=publicKey.export({format:'der',type:'spki'}).toString('base64');
const html=(await readFile(new URL('./download.html',import.meta.url),'utf8')).replace('MCowBQYDK2VwAyEAYx5ksgw4EsLvIBRB/Ke2dbcpGdzgiRlNqkEhcD1ygs4=',key);
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/assets/tailwindcss.js'?'application/javascript':'text/html; charset=utf-8');res.end(req.url==='/assets/tailwindcss.js'?'':html);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+server.address().port;
const directory=resolve('.draftgo/artifacts/render');await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
const release={tag_name:'v0.1.2',target_commitish:'a'.repeat(40),draft:false,prerelease:false,published_at:'2026-11-14T10:00:00Z',assets:['benchgo-0.1.2-win-x64.exe','benchgo-0.1.2-mac-arm64.dmg','benchgo-0.1.2-mac-x64.dmg','benchgo-0.1.2-mac-arm64.zip','benchgo-0.1.2-mac-x64.zip','benchgo-0.1.2.apk','benchgo-0.1.2-linux-server.tar.gz'].map(name=>({name,size:123456789,browser_download_url:'https://github.com/zhuogo/BenchGo/releases/download/v0.1.2/'+name}))};
let state='success',requests=0;
let catalogRaw=null,catalogSignature=null;
try{
 const context=await browser.newContext({viewport:{width:1440,height:1050}});
 const page=await context.newPage();
 await page.route('https://raw.githubusercontent.com/zhuogo/BenchGo/release-metadata/releases/v0.1.2/*',route=>{requests++;return route.fulfill({status:200,body:route.request().url().endsWith('.sig')?catalogSignature:catalogRaw,contentType:'application/octet-stream'});});
 await page.route('https://api.github.com/**',async route=>{requests++;if(state==='loading'){await new Promise(r=>setTimeout(r,500));return route.fulfill({status:200,json:[]});}if(state==='error')return route.fulfill({status:403,json:{message:'rate limited'}});return route.fulfill({status:200,json:state==='empty'?[]:[release]});});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 if(!catalogOnly){
 state='loading';await page.goto(base);await page.locator('#loading:visible').waitFor();await page.screenshot({path:join(directory,'download-loading.png'),fullPage:true});
 state='empty';await page.reload();await page.locator('#empty:visible').waitFor();await page.screenshot({path:join(directory,'download-empty.png'),fullPage:true});assert.equal(await page.locator('.asset').count(),0);
 state='error';await page.reload();await page.locator('#failure:visible').waitFor();await page.screenshot({path:join(directory,'download-error.png'),fullPage:true});
 state='success';await page.locator('#retry').click();await page.locator('#downloads:visible').waitFor();assert.equal(await page.locator('.asset').count(),7);assert.equal(await page.locator('#release-version').innerText(),'v0.1.2');await page.screenshot({path:join(directory,'download-success.png'),fullPage:true});
 state='error';await page.locator('#refresh').click();await page.locator('#refresh-warning:visible').waitFor();assert.equal(await page.locator('.asset').count(),7);
 state='success';await page.setViewportSize({width:375,height:900});await page.reload();await page.locator('#downloads:visible').waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.screenshot({path:join(directory,'download-mobile.png'),fullPage:true});
 for(const url of ['https://evil.invalid/bad.exe','https://user:password@github.com/zhuogo/BenchGo/releases/download/v0.1.2/bad.exe','https://github.com/zhuogo/BenchGo/releases/download/v0.1.2/bad.exe?key=value','https://github.com/zhuogo/BenchGo/releases/download/v0.1.2/bad.exe#fragment','https://github.com/zhuogo/BenchGo/releases/download/v0.1.2/nested/bad.exe'])release.assets.push({name:'bad.exe',size:10,browser_download_url:url});await page.reload();await page.locator('#downloads:visible').waitFor();assert.equal(await page.locator('.asset').count(),7);assert.equal(await page.locator('a[href*="evil.invalid"]').count(),0);
 }
 release.assets=release.assets.filter(a=>!a.name.endsWith('.exe'));
 const reused='https://github.com/zhuogo/BenchGo/releases/download/v0.1.1/benchgo-0.1.1-win-x64.exe';
 catalogRaw=Buffer.from(JSON.stringify({schemaVersion:1,releaseVersion:'0.1.2',sourceSha:release.target_commitish,files:[{target:'windows-x64',url:reused,size:555555,sha256:'a'.repeat(64)}]}));catalogSignature=sign(null,catalogRaw,privateKey).toString('base64');
 release.assets.push({id:1,name:'downloads.json',size:catalogRaw.length,browser_download_url:'https://github.com/zhuogo/BenchGo/releases/download/v0.1.2/downloads.json'},{id:2,name:'downloads.json.sig',size:88,browser_download_url:'https://github.com/zhuogo/BenchGo/releases/download/v0.1.2/downloads.json.sig'});
 await page.goto(base);await page.locator('[data-platform="windows"] .asset').waitFor();assert.equal(await page.locator('[data-platform="windows"] .asset').getAttribute('href'),reused);
 const correctCatalog=catalogRaw;catalogRaw=Buffer.from(JSON.stringify({...JSON.parse(catalogRaw),sourceSha:'b'.repeat(40)}));catalogSignature=sign(null,catalogRaw,privateKey).toString('base64');await page.reload();await page.locator('#downloads:visible').waitFor();assert.equal(await page.locator('[data-platform="windows"] .asset').count(),0);
 catalogRaw=correctCatalog;
 catalogSignature=Buffer.alloc(64).toString('base64');await page.reload();await page.locator('#downloads:visible').waitFor();assert.equal(await page.locator('[data-platform="windows"] .asset').count(),0);
 await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await page.locator('.asset').first().evaluate(el=>getComputedStyle(el).transitionDuration),'0s');assert.deepEqual(errors,[]);
 await context.close();
 if(!catalogOnly){
 const live=await browser.newContext({viewport:{width:1440,height:1000}});const publicPage=await live.newPage();
 for(const path of ['/','/download','/docs','/docs/install','/docs/first-run','/docs/mobile-link','/docs/linux-server','/docs/updates']){
  const response=await publicPage.goto('https://benchgo.cn'+path,{waitUntil:'networkidle'});assert.equal(response.status(),200,path);await publicPage.screenshot({path:join(directory,'live-'+(path==='/'?'home':path.slice(1).replaceAll('/','-'))+'.png'),fullPage:true});
  const result=await publicPage.evaluate(()=>({nav:!!document.querySelector('#benchgo-nav'),frames:document.querySelectorAll('iframe').length,title:document.title,overflow:document.documentElement.scrollWidth>innerWidth}));console.log(path,JSON.stringify(result));assert.equal(result.nav,true,path+' navigation');assert.equal(result.overflow,false,path+' overflow');
 }
 await publicPage.setViewportSize({width:375,height:900});await publicPage.goto('https://benchgo.cn/download',{waitUntil:'networkidle'});await publicPage.screenshot({path:join(directory,'live-download-mobile.png'),fullPage:true});assert.equal(await publicPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await live.close();
 }
 console.log(JSON.stringify(catalogOnly?{passed:true,scope:'catalog-only',signedCatalog:true,rejectsWrongSource:true,rejectsInvalidSignature:true,requests}:{passed:true,states:['loading','empty','error','success'],retry:true,refreshPreservesData:true,mobile:true,reducedMotion:true,assetOrigin:true,signedCatalog:true,rejectsWrongSource:true,rejectsInvalidSignature:true,requests,evidence:directory}));
}finally{await browser.close();server.close();}
