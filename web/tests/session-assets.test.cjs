const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const ts=require('typescript');const {create}=require('zustand');const {persist}=require('zustand/middleware');
function harness(){
 const compile=f=>ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',f),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2016}}).outputText;
 const identity={};vm.runInNewContext(compile('lib/session-identity.ts'),{exports:identity});identity.initializeSessionIdentity('a','A');
 const memory=new Map(),timers=new Map(),writes=[];let id=0,assetLoad=async()=>({assets:[]}),skillLoad=async()=>[];
 const user={getState:()=>({token:identity.captureSessionIdentity().token,user:{id:identity.captureSessionIdentity().userId}})};
 const modules={zustand:{create},'zustand/middleware':{persist},nanoid:{nanoid:()=>String(++id)},'@/lib/session-identity':identity,'@/stores/use-user-store':{useUserStore:user},'@/lib/localforage-storage':{localForageStorage:{getItem:async k=>memory.get(k)||null,setItem:async(k,v)=>memory.set(k,v),removeItem:async k=>memory.delete(k)}},'@/services/api/user-config':{fetchUserAssetData:t=>assetLoad(t),syncUserAssetData:async(t,d)=>writes.push({token:t,data:d})},'@/services/image-storage':{},'@/services/file-storage':{},'@/services/api/agent-skills':{fetchSystemAgentSkills:async()=>[],fetchUserAgentSkills:t=>skillLoad(t)},localforage:{default:{createInstance:()=>({getItem:async()=>[],setItem:async()=>{}})}}};
 const window={setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:i=>timers.delete(i)};
 function load(f){const exports={};vm.runInNewContext(compile(f),{exports,require:n=>modules[n]||{},Promise,console,window});return exports;}
 const a=load('stores/use-asset-store.ts'),s=load('stores/use-agent-skill-store.ts');
 return{...a,...s,identity,memory,timers,writes,setAsset:f=>assetLoad=f,setSkill:f=>skillLoad=f};
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('late asset hydrate cannot overwrite B or resurrect old A session',async()=>{
 const h=harness();await h.useAssetStore.persist.rehydrate();const d=deferred();h.setAsset(()=>d.promise);const p=h.useAssetStore.getState().hydrateAccountAssets('a',true).catch(()=>{});
 let s=h.identity.beginSessionTransition('b','B');h.useAssetStore.getState().reset();h.identity.finishSessionTransition(s);s=h.identity.beginSessionTransition('a','A');h.useAssetStore.getState().reset();h.identity.finishSessionTransition(s);
 h.useAssetStore.setState({assets:[{id:'current',kind:'text',data:{content:'current'}}]});d.resolve({assets:[{id:'stale',kind:'text',data:{content:'old'}}]});await p;assert.equal(h.useAssetStore.getState().assets[0].id,'current');
});
test('asset reset preserves stored data while transition writes are disabled',async()=>{
 const h=harness();await h.useAssetStore.persist.rehydrate();h.memory.set('infinite-canvas:asset_store:A','snapshot-A');h.memory.set('infinite-canvas:asset_store:B','snapshot-B');h.identity.beginSessionTransition('b','B');h.useAssetStore.getState().reset();assert.equal(h.memory.get('infinite-canvas:asset_store:A'),'snapshot-A');assert.equal(h.memory.get('infinite-canvas:asset_store:B'),'snapshot-B');
});
test('old scheduled asset sync never submits with a new account',async()=>{
 const h=harness();await h.useAssetStore.persist.rehydrate();await h.useAssetStore.getState().hydrateAccountAssets('a',true);h.useAssetStore.getState().addAsset({kind:'text',data:{content:'A'},title:'A',coverUrl:'',tags:[]});const callbacks=[...h.timers.values()];const s=h.identity.beginSessionTransition('b','B');h.useAssetStore.getState().reset();h.identity.finishSessionTransition(s);for(const cb of callbacks)cb();await Promise.resolve();assert.equal(h.writes.length,0);
});
test('skill cache clears on switch and late requests do not replace current skills',async()=>{
 const h=harness();const d=deferred();h.setSkill(()=>d.promise);const old=h.useAgentSkillStore.getState().loadSkills();const s=h.identity.beginSessionTransition('b','B');assert.equal(h.useAgentSkillStore.getState().userSkills.length,0);h.identity.finishSessionTransition(s);h.setSkill(async()=>[{id:'B'}]);await h.useAgentSkillStore.getState().loadSkills();d.resolve([{id:'A'}]);await old;assert.equal(h.useAgentSkillStore.getState().userSkills[0].id,'B');
});
