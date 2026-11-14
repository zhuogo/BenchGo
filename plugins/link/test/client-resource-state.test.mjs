import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeScope,scopeDevices,resourceKey,sortResourceRecents,resourceTime,readResourcePages,mergeResourcePage} from '../client/resource-state.mjs';
test('resource identity always retains device and opaque resource ID',()=>{
 assert.notEqual(resourceKey({deviceId:'a',kind:'sessions',resourceId:'same'}),resourceKey({deviceId:'b',kind:'sessions',resourceId:'same'}));
 assert.notEqual(resourceKey({deviceId:'a',kind:'projects',resourceId:'same'}),resourceKey({deviceId:'a',kind:'sessions',resourceId:'same'}));
});
test('scope defaults to current owner and never silently widens an empty explicit choice',()=>{
 const devices=[{id:'a'},{id:'b'}];assert.deepEqual(scopeDevices(normalizeScope(),devices,'b'),[devices[1]]);
 assert.deepEqual(scopeDevices(normalizeScope({mode:'selected',deviceIds:[]}),devices,'a'),[]);
 assert.deepEqual(normalizeScope({mode:'selected',deviceIds:['a','a']}),{mode:'selected',deviceIds:['a']});
});
test('recent preserves pin priority and source activity without making invalid clocks current',()=>{
 const rows=[{deviceId:'b',kind:'sessions',id:'older',updatedAt:10},{deviceId:'a',kind:'sessions',id:'new',updatedAt:30},{deviceId:'b',kind:'sessions',id:'pin',updatedAt:1,pinned:true},{deviceId:'c',kind:'sessions',id:'future',updatedAt:Date.now()+172800000}];
 assert.deepEqual(sortResourceRecents(rows).map(row=>row.id),['pin','new','older','future']);assert.equal(resourceTime({updatedAt:'bad'}),0);assert.equal(rows[0].id,'older');
});

test('equal-time remote devices keep deterministic resource identities in one flat list',()=>{
 const rows=[{deviceId:'b',kind:'recent',id:'same',updatedAt:20},{deviceId:'a',kind:'sessions',id:'same',updatedAt:20}];
 assert.deepEqual(sortResourceRecents(rows).map(row=>row.deviceId),['a','b']);
 assert.deepEqual(sortResourceRecents([...rows].reverse()).map(row=>row.deviceId),['a','b']);
});

test('refresh retains loaded coverage through bounded pages and follows the latest end of list',async()=>{
 const calls=[],rows=Array.from({length:65},(_,id)=>({deviceId:'remote',kind:'projects',resourceId:String(id)}));
 const request=async(action,input)=>{calls.push(input);return {devices:[{available:true,items:rows.slice(input.offset,input.offset+input.limit),hasMore:input.offset+input.limit<rows.length,observedAt:10}]};};
 const page=await readResourcePages(request,{deviceId:'remote',kind:'projects'},60);
 assert.deepEqual(calls.map(row=>[row.offset,row.limit]),[[0,60]]);
 assert.equal(page.items.length,60);assert.equal(page.hasMore,true);assert.equal(page.offset,0);
 calls.length=0;rows.length=35;
 const shorter=await readResourcePages(request,{deviceId:'remote',kind:'projects'},60);
 assert.equal(shorter.items.length,35);assert.equal(shorter.hasMore,false);
});

test('first load stays at 30 while refresh combines only the loaded coverage up to 100 per request',async()=>{
 const rows=Array.from({length:180},(_,id)=>({deviceId:'remote',kind:'recent',resourceId:String(id)}));
 for(const [count,expected] of [[undefined,[[0,30]]],[0,[[0,30]]],[90,[[0,90]]],[120,[[0,100],[100,20]]]]){
  const calls=[];
  const page=await readResourcePages(async(action,input)=>{calls.push([input.offset,input.limit]);return {devices:[{available:true,items:rows.slice(input.offset,input.offset+input.limit),hasMore:input.offset+input.limit<rows.length}]};},{deviceId:'remote',kind:'recent'},count);
  assert.deepEqual(calls,expected);assert.deepEqual(page.items,rows.slice(0,Math.max(30,count||0)));assert.equal(page.hasMore,true);
 }
});

test('short pages advance by returned rows and preserve ordering and opaque identity deduplication',async()=>{
 const one={deviceId:'remote',kind:'projects',resourceId:'one'},other={deviceId:'other',kind:'projects',resourceId:'one'};
 const rows=[one,one,other,...Array.from({length:77},(_,id)=>({deviceId:'remote',kind:'projects',resourceId:String(id)}))],calls=[];
 const page=await readResourcePages(async(action,input)=>{calls.push([input.offset,input.limit]);const items=rows.slice(input.offset,input.offset+Math.min(17,input.limit));return {devices:[{available:true,items,hasMore:input.offset+items.length<rows.length}]};},{kind:'projects'},60);
 assert.deepEqual(calls,[[0,60],[17,43],[34,26],[51,9]]);
 assert.deepEqual(page.items,[one,other,...rows.slice(3,60)]);assert.equal(page.hasMore,true);assert.equal(page.offset,0);
 const empty=await readResourcePages(async()=>({devices:[{available:true,items:[],hasMore:false}]}),{kind:'projects'},120);
 assert.deepEqual(empty.items,[]);assert.equal(empty.hasMore,false);
});

test('later refresh failures and cancellation never return partial summaries',async()=>{
 const rows=Array.from({length:100},(_,id)=>({deviceId:'remote',kind:'projects',resourceId:String(id)}));
 const revoked={available:false,code:'UNAUTHORIZED',items:[],hasMore:false};
 let requests=0;
 const result=await readResourcePages(async()=>({devices:[++requests===1?{available:true,items:rows,hasMore:true}:revoked]}),{kind:'projects'},120);
 assert.equal(requests,2);assert.equal(result,revoked);
 requests=0;
 await assert.rejects(readResourcePages(async()=>{if(++requests===2)throw Error('network failure');return {devices:[{available:true,items:rows,hasMore:true}]};},{kind:'projects'},120),/network failure/);
 const abort=new AbortController();requests=0;
 await assert.rejects(readResourcePages(async()=>{requests++;abort.abort();return {devices:[{available:true,items:rows,hasMore:true}]};},{kind:'projects'},120,abort.signal),{name:'AbortError'});
 assert.equal(requests,1);
});

test('refresh failures preserve all loaded summaries but revoke failures remove them',async()=>{
 const previous={available:true,items:[{deviceId:'a',resourceId:'one'},{deviceId:'a',resourceId:'two'}],observedAt:100,hasMore:true};
 const failed={available:false,code:'ECONNRESET',items:previous.items.slice(0,1),observedAt:90,hasMore:false};
 const retained=mergeResourcePage(previous,failed);
 assert.equal(retained.available,false);assert.deepEqual(retained.items,previous.items);
 assert.equal(retained.observedAt,100);assert.equal(retained.freshness,'stale');assert.equal(retained.hasMore,true);
 for(const code of ['UNAUTHORIZED','IDENTITY_CHANGED','NOT_FOUND'])assert.deepEqual(mergeResourcePage(previous,{...failed,code,items:[]}).items,[]);
 let requests=0;
 const result=await readResourcePages(async()=>{requests++;return {devices:[failed]};},{kind:'projects'},60);
 assert.equal(result.available,false);assert.equal(requests,1);
 await assert.rejects(readResourcePages(()=>{throw Error('must not request');},{},30,AbortSignal.abort()),{name:'AbortError'});
});

test('pagination keeps opaque identities and removes overlap without rewriting the old list',()=>{
 const one={deviceId:'a',kind:'projects',resourceId:'same'},two={deviceId:'b',kind:'projects',resourceId:'same'};
 const previous={items:[one]};
 const merged=mergeResourcePage(previous,{available:true,items:[one,two],hasMore:false},true);
 assert.deepEqual(merged.items,[one,two]);assert.deepEqual(previous.items,[one]);
 assert.equal(merged.loading,false);assert.equal(merged.refreshing,false);
});
