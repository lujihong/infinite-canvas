const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const root=path.resolve(__dirname,'../src');
function functionsFrom(relative,names,globals={}) {
 const text=fs.readFileSync(path.join(root,relative),'utf8');
 const ast=ts.createSourceFile(relative,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fns=names.map(name=>{const f=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===name);assert.ok(f,name);return f.getText(ast);});
 const code=ts.transpileModule(fns.join('\n')+'\nexport { '+names.join(',')+' };',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const scope={exports:{},...globals};vm.runInNewContext(code,scope);return scope.exports;
}
const mimo=functionsFrom('lib/mimo-tts.ts',['isMimoVoiceCloneModel','isMimoPresetTtsModel','isMimoVoiceDesignModel']);
const sample={id:'speaker-a',url:'https://media.invalid/sample.wav',type:'audio/wav'};
const clone='mimo-v2.5-tts-voiceclone';
const config={audioInstructions:'自然',mimoVoiceDesignPrompt:'温暖',mimoTtsFormat:'wav'};
const selection=functionsFrom('app/(user)/canvas/[id]/canvas-client-page.tsx',['selectMiMoVoiceCloneReference'],mimo).selectMiMoVoiceCloneReference;
const body=functionsFrom('services/api/audio.ts',['buildAudioSpeechRequest','buildMiMoNativeRequest','unsupportedReferenceAudioError'],{
 ...mimo,isMimoTtsModel:m=>m.startsWith('mimo-v2.5-tts'),isGeminiTtsModel:m=>m.startsWith('gemini'),isGeminiConfig:()=>true,isGlmTtsModel:m=>m==='glm-tts',isGrok2APITtsConfig:(_,m)=>m==='grok-tts',
 normalizeMimoTtsFormat:()=> 'wav',normalizeMimoTtsVoice:()=> '冰糖',referenceAudioDataUrl:async r=>{assert.equal(r,sample);return 'data:audio/wav;base64,UklGRg==';}
});
test('canvas rejects ignored audio and never silently changes selected speaker',()=>{
 assert.throws(()=>selection({model:'tts-1'},undefined,[sample]),/不支持/);
 assert.equal(selection({model:'tts-1'},undefined,[]),undefined);
 assert.equal(selection({model:clone},undefined,[sample]),sample);
 assert.throws(()=>selection({model:clone},{mimoVoiceCloneAudioNodeId:'deleted'},[sample]),/已断开/);
 assert.throws(()=>selection({model:clone},undefined,[sample,{...sample,id:'b'}]),/多个/);
});
test('proxy and native builders reject unsupported audio rather than dropping it',async()=>{
 for(const model of ['tts-1','glm-tts','grok-tts','gemini-tts','mimo-v2.5-tts','mimo-v2.5-tts-voicedesign']) {
  await assert.rejects(body.buildAudioSpeechRequest(config,model,'text',sample),/不支持/);
 }
 for(const model of ['mimo-v2.5-tts','mimo-v2.5-tts-voicedesign']) await assert.rejects(body.buildMiMoNativeRequest(config,model,'text',sample),/不支持/);
});
test('clone preserves exact voice sample in both protocol request bodies',async()=>{
 const proxy=await body.buildAudioSpeechRequest(config,clone,'text',sample);
 const native=await body.buildMiMoNativeRequest(config,clone,'text',sample);
 assert.equal(proxy.mimo_voice_clone_audio,native.audio.voice);
 assert.equal(proxy.input,'text');assert.equal(native.messages.at(-1).content,'text');
});
test('AICC assets cannot be converted into cross-provider voice samples',async()=>{
 let calls=0;
 const {referenceAudioDataUrl}=functionsFrom('services/api/audio.ts',['referenceAudioDataUrl'],{resolveMediaUrl:()=>{calls++;throw Error('must not resolve');}});
 await assert.rejects(referenceAudioDataUrl({...sample,aiccUri:'asset://asset-abc'}),/移动云/);
 await assert.rejects(referenceAudioDataUrl({...sample,url:'asset://asset-abc'}),/移动云/);
 assert.equal(calls,0);
});
test('oversized samples are rejected before Base64 encoding',async()=>{
 let encoded=0,cancelled=0;
 const base={resolveMediaUrl:async()=>sample.url,normalizeCloneMimeType:()=> 'audio/wav',blobToBase64:async()=>{encoded++;return 'AAAA';}};
 const declared=functionsFrom('services/api/audio.ts',['referenceAudioDataUrl'],{...base,fetch:async()=>({ok:true,headers:new Headers({'content-length':String(8*1024*1024)}),body:{cancel:async()=>{cancelled++;}}})});
 await assert.rejects(declared.referenceAudioDataUrl(sample),/7.5/);
 const actual=functionsFrom('services/api/audio.ts',['referenceAudioDataUrl'],{...base,fetch:async()=>({ok:true,headers:new Headers(),blob:async()=>({size:8*1024*1024,type:'audio/wav'})})});
 await assert.rejects(actual.referenceAudioDataUrl(sample),/7.5/);
 assert.equal(encoded,0);assert.equal(cancelled,1);
});
