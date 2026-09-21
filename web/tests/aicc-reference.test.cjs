const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../src/services/api/video.ts'),'utf8');
const compiled=ts.transpileModule(source+'\nexport { imageReferenceToFormValue, mediaReferenceToFormValue, createVideoRequestBody };',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function helpers(token='test-user-token'){
 const exports={};
 vm.runInNewContext(compiled,{exports,require:(name)=>name==='@/stores/use-user-store'?{useUserStore:{getState:()=>({token})}}:{},FormData,Blob,File,console});
 return exports;
}
test('saved AICC assets retain identity and never rehydrate obsolete storage',async()=>{
 const storeSource=fs.readFileSync(path.join(__dirname,'../src/stores/use-asset-store.ts'),'utf8');
 const code=ts.transpileModule(storeSource+'\nexport { resolveStoredAsset };',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={};
 const modules={zustand:{create:()=>()=>({})},'zustand/middleware':{persist:()=>({})},'@/services/image-storage':{resolveImageUrl:()=>{throw new Error('must not load old image')},uploadImage:()=>{throw new Error('must not upload preview')}},'@/services/file-storage':{resolveMediaUrl:()=>{throw new Error('must not load old media')}}};
 vm.runInNewContext(code,{exports,require:(name)=>modules[name]||{},console});
 for(const kind of ['image','video','audio']){
  const asset={id:'saved',kind,data:{aiccUri:'asset://asset-person',aiccChannelId:6,storageKey:'obsolete',dataUrl:'https://preview.invalid/a.png',url:'https://preview.invalid/a.mp4'}};
  const restored=await exports.resolveStoredAsset(JSON.parse(JSON.stringify(asset)));
  assert.equal(restored.data.aiccUri,asset.data.aiccUri);
  assert.equal(restored.data.aiccChannelId,6);
  assert.equal(restored.data.storageKey,undefined);
  assert.equal(asset.data.storageKey,'obsolete','restoration must not mutate persisted input');
 }
});
test('asset references are preserved without reading preview URL or storage',async()=>{
 const h=helpers();
 for(const aiccUri of ['asset://asset-person','asset://asset-video','asset://asset-audio']){
  assert.equal(await h.imageReferenceToFormValue({aiccUri,dataUrl:'https://preview.example/temporary.png'}),aiccUri);
  assert.equal(await h.mediaReferenceToFormValue({aiccUri,url:'https://preview.example/temporary.mp4'}),aiccUri);
 }
});
test('malformed asset URIs are rejected before any upload',async()=>{
 const h=helpers();
 for(const aiccUri of ['asset://group-person','asset://asset-a/other','https://example.com/asset','asset://asset-a?key=x']){
  await assert.rejects(h.imageReferenceToFormValue({aiccUri}),/引用格式异常/);
  await assert.rejects(h.mediaReferenceToFormValue({aiccUri}),/引用格式异常/);
 }
});
test('missing source, mixed channels and unauthenticated references are rejected before upload',async()=>{
 const input=(refs)=>({references:refs,videoReferences:[],audioReferences:[],firstFrame:null,lastFrame:null});
 const config={channelMode:'remote'};
 const h=helpers();
 for(const aiccChannelId of [undefined,0,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
  await assert.rejects(h.createVideoRequestBody(config,'doubao-seedance-2.0','prompt',input([{aiccUri:'asset://asset-a',aiccChannelId}])),/来源信息缺失/);
 }
 await assert.rejects(h.createVideoRequestBody(config,'doubao-seedance-2.0','prompt',input([{aiccUri:'asset://asset-a',aiccChannelId:6},{aiccUri:'asset://asset-b',aiccChannelId:7}])),/不同渠道/);
 await assert.rejects(helpers('').createVideoRequestBody(config,'doubao-seedance-2.0','prompt',input([{aiccUri:'asset://asset-a',aiccChannelId:6}])),/请登录/);
});
test('all reference positions reject AICC for non-Seedance models',async()=>{
 const h=helpers();
 for(const key of ['references','videoReferences','audioReferences','firstFrame','lastFrame']){
  const input={references:[],videoReferences:[],audioReferences:[],firstFrame:null,lastFrame:null};
  input[key]=key.endsWith('Frame')?{aiccUri:'asset://asset-a'}:[{aiccUri:'asset://asset-a'}];
  await assert.rejects(h.createVideoRequestBody({},'other-video-model','prompt',input),/仅支持 Seedance/);
 }
});
