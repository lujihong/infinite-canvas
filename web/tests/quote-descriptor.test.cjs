const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Run production TS; only IO and application state boundaries are replaced.
function harness() {
  const cache = new Map();
  const io = [];
  let allowStorage = false;
  const forbidden = name => () => { io.push(name); throw new Error(`unexpected IO: ${name}`); };
  const storage = value => { if (!allowStorage) return forbidden('storage')(); return Promise.resolve(value || ''); };
  const modules = {
    axios: { default: { post: forbidden('post'), get: forbidden('get') } },
    nanoid: { nanoid: () => 'test-id' },
    '@/lib/image-utils': { dataUrlToFile: () => { if (!allowStorage) return forbidden('file')(); return new File(['fixture'], 'input.png', {type:'image/png'}); }, readFileAsDataUrl: forbidden('file') },
    '@/services/image-storage': { resolveImageUrl: () => storage(''), imageToDataUrl: ref => storage(ref.url || ref.dataUrl) },
    '@/services/file-storage': { resolveMediaUrl: (_key, url) => storage(url) },
    '@/stores/use-user-store': { useUserStore: { getState: () => ({token:'test-token'}) } },
    '@/stores/use-wallet-store': {},
    '@/stores/use-config-store': {
      channelProtocolForConfig: c => c.protocol || 'openai',
      localChannelForActiveModel: c => ({protocol:c.protocol || 'openai',baseUrl:c.baseUrl || ''}),
      channelIdForActiveModel: () => 'test-channel',
    },
    '@/components/video-settings-panel': { isKIEKlingV3Config: () => false, kieKlingOmniVariant: () => '', isKIEGrokVideoModel: () => false },
  };
  function load(name, from = path.join(__dirname, '../src/services/api/quote-descriptor.ts')) {
    if (modules[name]) return modules[name];
    const file = name.startsWith('@/') ? path.join(__dirname, '../src', name.slice(2) + '.ts') : path.resolve(path.dirname(from), name + '.ts');
    if (cache.has(file)) return cache.get(file);
    const source = fs.readFileSync(file, 'utf8');
    const extras = file.endsWith('/video.ts') ? '\nexport { createVideoRequestBody };' : file.endsWith('/image.ts') ? '\nexport { createCanvasImageTaskRequest };' : '';
    const compiled = ts.transpileModule(source + extras, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports = {};
    cache.set(file, exports);
    vm.runInNewContext(compiled, {exports,require: id => load(id, file),URL,FormData,Blob,File,console,window:{location:{origin:'https://workbench.example'}},fetch:forbidden('fetch')}, {filename:file});
    return exports;
  }
  return {quote:load('./quote-descriptor').buildQuoteDescriptor, video:load('./video'), image:load('./image'), io, enableStorage: () => {allowStorage = true;}};
}
const config = (overrides = {}) => ({
  channelMode:'remote',baseUrl:'https://provider.example/v1',model:'gpt-image-1',videoModel:'sora-2',apiMode:'images',quality:'high',size:'1:1',count:'3',streamPartialImages:'1',
  systemPrompt:'',systemPrompts:{image:'',video:''},videoSeconds:'6',vquality:'auto',videoGenerateAudio:'false',videoMode:'std',videoElementList:[], ...overrides,
});
test('same-origin uploaded media references normalize without IO',()=>{
 const h=harness();const q=h.quote({config:config({model:'doubao-seedance-2.0',videoSeconds:'5',vquality:'720p'}),mode:'video',prompt:'test',references:{references:[{url:'/api/files/id/content'}]}});
 assert.ok(!q.missing_fields?.length);assert.equal(q.body['input_reference[]'][0],'https://workbench.example/api/files/id/content');assert.equal(h.io.length,0);
});
const plain = value => JSON.parse(JSON.stringify(value));
const emptyRefs = () => ({references:[],videoReferences:[],audioReferences:[],firstFrame:null,lastFrame:null});
function formFields(form) {
  const out = {};
  for (const [key,value] of form) {
    assert.equal(typeof value, 'string');
    if (key.endsWith('[]')) (out[key] ||= []).push(value);
    else out[key] = value;
  }
  return out;
}

test('image single n and separate task batches preserve GPT quality/size and prompt', () => {
  const h = harness();
  const c = config({systemPrompts:{image:'System',video:''}});
  const single = h.quote({config:c,mode:'image',prompt:'Actual prompt',batchMode:'single'});
  assert.deepEqual(plain(single.body), {model:'gpt-image-1',prompt:'System\n\nActual prompt',quality:'high',size:'2880x2880',n:3});
  assert.equal(single.batch_count,1);
  const separate = h.quote({config:c,mode:'image',prompt:'Actual prompt'});
  assert.equal(separate.body.n,undefined);
  assert.equal(separate.batch_count,3);
  const changed = h.quote({config:config({quality:'1k',size:'16:9'}),mode:'image',prompt:'Changed',batchCount:5});
  assert.equal(changed.body.quality,'low');
  assert.equal(changed.body.size,'1280x720');
  assert.equal(changed.batch_count,5);
  assert.deepEqual(h.io,[]);
});

test('image descriptors match the real canvas JSON sender for generation, responses and chat', async () => {
  const h = harness();
  for (const apiMode of ['images','responses','chat']) {
    const c = config({count:'1',apiMode,streamImages:true,codexCli:true});
    const d = h.quote({config:c,mode:'image',prompt:'Actual'});
    const request = await h.image.createCanvasImageTaskRequest(c,'Actual',[],h.image.createImageRequestParams(c),{});
    const sent = JSON.parse(request.body);
    assert.equal(d.endpoint, '/v1' + sent.endpoint);
    assert.deepEqual(plain(d.body),sent.request);
  }
});

test('responses/chat single mode uses real forced splitting; edit action and URL retained', () => {
  const h = harness();
  for (const apiMode of ['responses','chat']) {
    const d = h.quote({config:config({apiMode}),mode:'image',prompt:'Edit',batchMode:'single',references:{references:[{url:'https://cdn.example/image.png'}]}});
    assert.equal(d.batch_count,3);
    assert.ok(JSON.stringify(d.body).includes('https://cdn.example/image.png'));
    if (apiMode === 'responses') assert.equal(d.body.tools[0].action,'edit');
  }
});

test('missing prompt/local references are explicit, with no placeholder URL or media reads', () => {
  const h = harness();
  for (const mode of ['image','video']) {
    const d = h.quote({config:config({model: mode === 'video' ? 'doubao-seedance-2.0' : 'gpt-image-1'}),mode,references:{references:[{storageKey:'local',dataUrl:'data:image/png;base64,AAAA'},{url:'blob:local'}]}});
    assert.ok(d.missing_fields.includes('prompt'));
    assert.equal(d.missing_fields.filter(x => x.endsWith('.public_url')).length,2);
    assert.ok(!JSON.stringify(d.body).includes('quote'));
    assert.ok(!JSON.stringify(d.body).includes('base64'));
  }
  assert.deepEqual(h.io,[]);
});

test('video descriptor equals actual FormData scalars across model, duration, size and sound changes', async () => {
  const h = harness();
  for (const overrides of [
    {model:'sora-2',videoSeconds:'6',size:'9:16'},
    {model:'veo3.1-official',videoSeconds:'4',videoGenerateAudio:'true',vquality:'1080P'},
    {model:'doubao-seedance-2.0',videoSeconds:'',videoGenerateAudio:'true',size:'auto'},
    {model:'doubao-seedance-2.0',videoSeconds:'12',videoGenerateAudio:'false',size:'16:9'},
    {model:'kling-v2-6',protocol:'apimart',videoSeconds:'12',videoMode:'pro',videoNegativePrompt:' blur '},
    {model:'kling-v3',protocol:'apimart',videoSeconds:'30',videoMode:'4k',videoMultiShot:'true',videoShotType:'customize',videoMultiPrompt:[{prompt:'Scene',duration:'5'}]},
  ]) {
    const c = config(overrides);
    const d = h.quote({config:c,mode:'video',prompt:'Actual',batchCount:4});
    const form = await h.video.createVideoRequestBody(c,c.model,'Actual',emptyRefs());
    assert.deepEqual(plain(d.body),formFields(form));
    assert.equal(d.batch_count,4);
    assert.equal(d.missing_fields,undefined);
    if (c.model.includes('veo')) assert.equal(d.body.seconds,'8');
  }
  assert.deepEqual(h.io,[]);
});

test('video defaults, system prompt, audio switches, and outer count are exact', () => {
  const h = harness();
  const c = config({model:'doubao-seedance-2.0',videoSeconds:'',size:'',vquality:'',systemPrompts:{image:'',video:'System'}});
  const off = h.quote({config:c,mode:'video',prompt:'Actual'});
  assert.equal(off.body.seconds,'6');
  assert.equal(off.body.resolution_name,'720p');
  assert.equal(off.body.video_generate_audio,'false');
  assert.equal(off.body.prompt,'System\n\nActual');
  assert.equal(off.batch_count,1);
  assert.equal(h.quote({config:{...c,videoGenerateAudio:'true'},mode:'video',prompt:'Actual'}).body.video_generate_audio,'true');
  assert.ok(h.quote({config:c,mode:'video',prompt:'Actual',batchCount:NaN}).missing_fields.includes('batch_count'));
});

test('AICC and public references keep identifiers and match real FormData', async () => {
  const h = harness();
  const c = config({model:'doubao-seedance-2.0'});
  const refs = {...emptyRefs(),references:[{aiccUri:'asset://asset-person',aiccChannelId:6}],videoReferences:[{url:'https://cdn.example/video.mp4'}],audioReferences:[{url:'https://cdn.example/audio.mp3'}],firstFrame:{url:'https://cdn.example/frame.png'}};
  const d = h.quote({config:c,mode:'video',prompt:'Actual',references:refs});
  assert.equal(d.body['input_reference[]'][0],'asset://asset-person');
  assert.deepEqual(h.io,[]);
  h.enableStorage();
  const sent = await h.video.createVideoRequestBody(c,c.model,'Actual',refs);
  assert.deepEqual(plain(d.body),formFields(sent));
});

test('image edit scalars match actual multipart sender and normalize quality aliases', async () => {
  const h = harness();
  const c = config({quality:'2k',size:'3:4',count:'1'});
  const refs = [{url:'https://cdn.example/input.png'}];
  const d = h.quote({config:c,mode:'image',prompt:'Edit',references:{references:refs}});
  assert.equal(d.endpoint,'/v1/images/edits');
  assert.equal(d.body.quality,'medium');
  assert.deepEqual(plain(d.body.image),['https://cdn.example/input.png']);
  assert.deepEqual(h.io,[]);
  h.enableStorage();
  const request = await h.image.createCanvasImageTaskRequest(c,'Edit',refs,h.image.createImageRequestParams(c),{});
  const sentScalars = Object.fromEntries([...request.body].filter(([key]) => key !== 'image' && !key.startsWith('_canvas_')));
  assert.ok(request.body.get('image') instanceof File);
  const withoutImage = {...d.body};
  delete withoutImage.image;
  assert.deepEqual(Object.fromEntries(Object.entries(withoutImage).map(([k,v]) => [k,String(v)])),sentScalars);
});

test('both mobile Seedance models share effective audio in quote and actual FormData', async () => {
  const h = harness();
  for (const model of ['moma-seedance-2.0','nm-moma-seedance-2.0']) {
    const key = model.replaceAll('.', '-');
    for (const [settings, expected] of [
      [{}, 'true'],
      [{videoGenerateAudioByModel:{[key]:false}}, 'false'],
      [{videoGenerateAudioByModel:{[key]:true}}, 'true'],
      [{videoGenerateAudioByModel:{[key]:true},videoGenerateAudioExplicit:false}, 'false'],
      [{videoGenerateAudioByModel:{[key]:false},videoGenerateAudioExplicit:true}, 'true'],
    ]) {
      const c=config({model,videoGenerateAudio:'false',...settings});
      const q=h.quote({config:c,mode:'video',prompt:'Actual'});
      const form=await h.video.createVideoRequestBody(c,model,'Actual',emptyRefs());
      assert.equal(q.body.video_generate_audio,expected);
      assert.equal(form.get('video_generate_audio'),expected);
    }
  }
});

test('unsupported protocols and invalid AICC metadata cannot masquerade as complete quotes', () => {
  const h = harness();
  for (const overrides of [{model:'agnes-video'},{model:'agnes-video-2.5'},{model:'agnes_video_2_5'},{model:'cogvideox-3'},{model:'veo-3.1-generate-preview',protocol:'gemini'}]) {
    const d = h.quote({config:config(overrides),mode:'video',prompt:'Actual'});
    assert.ok(d.missing_fields.includes('unsupported.video_protocol'));
    assert.equal(d.body.seconds,undefined);
  }
  const d = h.quote({config:config({model:'doubao-seedance-2.0'}),mode:'video',prompt:'Actual',references:{references:[{aiccUri:'asset://asset-a',aiccChannelId:1},{aiccUri:'asset://asset-b',aiccChannelId:2}]}});
  assert.ok(d.missing_fields.includes('references.aiccChannelId_mismatch'));
  assert.deepEqual(h.io,[]);
});
