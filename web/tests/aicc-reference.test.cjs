const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../src/services/api/video.ts'),'utf8');
const compiled=ts.transpileModule(source+'\nexport { imageReferenceToFormValue, mediaReferenceToFormValue, createVideoRequestBody };',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function helpers(){
 const exports={};
 vm.runInNewContext(compiled,{exports,require:()=>({}),FormData,Blob,File,console});
 return exports;
}
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
test('all reference positions reject AICC for non-Seedance models',async()=>{
 const h=helpers();
 for(const key of ['references','videoReferences','audioReferences','firstFrame','lastFrame']){
  const input={references:[],videoReferences:[],audioReferences:[],firstFrame:null,lastFrame:null};
  input[key]=key.endsWith('Frame')?{aiccUri:'asset://asset-a'}:[{aiccUri:'asset://asset-a'}];
  await assert.rejects(h.createVideoRequestBody({},'other-video-model','prompt',input),/仅支持 Seedance/);
 }
});
