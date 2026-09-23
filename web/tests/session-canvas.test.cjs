const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const {create}=require('zustand');
const {persist}=require('zustand/middleware');
const deferred=()=>{let resolve; const promise=new Promise(r=>resolve=r); return {promise,resolve};};
function harness(){
 const memory=new Map(), timers=new Map(), sent=[];let seq=0;let remote=async()=>[];
 const compile=file=>ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2016,module:ts.ModuleKind.CommonJS}}).outputText;
 const identity={};vm.runInNewContext(compile('lib/session-identity.ts'),{exports:identity});
 identity.initializeSessionIdentity('a','A');
 const auth={getState:()=>({token:identity.captureSessionIdentity().token,user:{id:identity.captureSessionIdentity().userId}}),persist:{hasHydrated:()=>true}};
 const modules={zustand:{create},'zustand/middleware':{persist},nanoid:{nanoid:()=>`id-${++seq}`},'@/lib/session-identity':identity,'@/stores/use-user-store':{useUserStore:auth},'../types':{CanvasNodeType:{Image:'image'}},'@/lib/localforage-storage':{localForageStorage:{getItem:async k=>memory.get(k)||null,setItem:async(k,v)=>memory.set(k,v),removeItem:async k=>memory.delete(k)}},'@/services/api/user-config':{fetchUserConfig:async()=>({syncCapabilities:{userData:true}})},'@/services/api/canvas-tasks':{listCanvasProjects:t=>remote(t),saveCanvasProject:async(t,p)=>sent.push({token:t,id:p.id}),syncCanvasProjects:async(t,p)=>p,deleteCanvasProjects:async()=>{}}};
 const exports={};vm.runInNewContext(compile('app/(user)/canvas/stores/use-canvas-store.ts'),{exports,require:n=>modules[n]||{},Promise,console,setTimeout:fn=>{const id=++seq;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id),fetch:async(_u,o)=>{sent.push({token:o.headers.Authorization,id:JSON.parse(o.body).data.id});}});
 return {identity,memory,sent,timers,store:exports.useCanvasStore,flush:exports.flushPendingCanvasProjectSaves,setRemote:fn=>remote=fn,async switchTo(id){const snap=identity.beginSessionTransition(id.toLowerCase(),id);exports.useCanvasStore.getState().reset();await exports.useCanvasStore.persist.rehydrate();identity.finishSessionTransition(snap);}};
}
test('new account hydration reads projects while persistence is suspended',async()=>{
 const h=harness();await h.store.persist.rehydrate();h.setRemote(async token=>[{id:token,title:token,nodes:[]}]);
 await h.switchTo('B');assert.equal(h.store.getState().projects[0].id,'b');assert.equal(h.store.getState().hydrated,true);
});
test('queued account A project never flushes with account B token',async()=>{
 const h=harness();await h.store.persist.rehydrate();h.store.getState().createProject('A secret');
 const snap=h.identity.beginSessionTransition('b','B');h.flush();assert.equal(h.sent.length,0);h.store.getState().reset();h.identity.finishSessionTransition(snap);h.flush();assert.equal(h.sent.length,0);
});
test('A to B to A rejects the original hydration even with identical token',async()=>{
 const h=harness();await h.store.persist.rehydrate();const old=deferred();h.setRemote(()=>old.promise);const read=h.store.persist.rehydrate();await new Promise(setImmediate);
 h.setRemote(async()=>[{id:'new-A',nodes:[]}]);await h.switchTo('B');await h.switchTo('A');old.resolve([{id:'stale-A',nodes:[]}]);await read;assert.equal(h.store.getState().projects[0].id,'new-A');
});
test('reset during transition preserves both account local snapshots',async()=>{
 const h=harness();await h.store.persist.rehydrate();h.memory.set('infinite-canvas:canvas_store:A','old-A');h.memory.set('infinite-canvas:canvas_store:B','old-B');
 h.identity.beginSessionTransition('b','B');h.store.getState().reset();for(const fn of h.timers.values())fn();
 assert.equal(h.memory.get('infinite-canvas:canvas_store:A'),'old-A');assert.equal(h.memory.get('infinite-canvas:canvas_store:B'),'old-B');
});
