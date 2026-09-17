const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Execute the real production helper with network/storage boundaries stubbed.
function harness(responseFactory, { taskResponse, token = 'user-test-token', failServerUpload = false } = {}) {
  const requests = [];
  const apiRequests = [];
  const stored = [];
  const localStored = [];
  const source = fs.readFileSync(path.join(__dirname, '../src/services/api/video.ts'), 'utf8');
  const compiled = ts.transpileModule(source + '\nexport { cacheProtectedVideoContent };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules = {
    axios: { default: {
      get: async (url, options) => {
        apiRequests.push({ method: 'GET', url, options });
        if (taskResponse instanceof Error) throw taskResponse;
        return { data: taskResponse };
      },
      post: async (url, options) => {
        apiRequests.push({ method: 'POST', url, options });
        throw new Error('must not create a generation');
      },
    } },
    nanoid: { nanoid: () => 'offline-id' },
    '@/stores/use-user-store': { useUserStore: { getState: () => ({ token }) } },
    '@/stores/use-config-store': {
      channelIdForActiveModel: () => 'channel-test',
      localChannelForActiveModel: () => ({ baseUrl: 'https://provider.example/v1', apiKey: 'never-send-to-cdn' }),
      buildApiUrl: (base, endpoint) => `${base}${endpoint}`,
    },
    '@/lib/gemini': { isGeminiConfig: () => false },
    '@/services/file-storage': {
      uploadAssetMediaFile: async file => {
        if (failServerUpload) throw new Error('server storage unavailable');
        stored.push(file);
        return {url:'/api/files/video.mp4',storageKey:'video-key'};
      },
      uploadMediaFile: async blob => {
        assert.ok(failServerUpload, 'unexpected local storage fallback');
        localStored.push(blob);
        return {url:'blob:local-video',storageKey:'local-video-key'};
      },
    },
  };
  const sandbox = {
    exports: {}, require: id => modules[id] || {}, Blob, File, Response, Uint8Array,
    console: { warn() {} },
    fetch: async (url, options) => { requests.push({url, options}); return responseFactory(url); },
  };
  vm.runInNewContext(compiled, sandbox);
  return { call: sandbox.exports.cacheProtectedVideoContent, requests, apiRequests, stored, localStored };
}
const completed = {id:'client_video_task_test',task_id:'task_upstream',status:'completed'};
const mp4 = () => new Response(new Uint8Array([0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0]), {headers:{'Content-Type':'video/mp4'}});

test('completed metadata without URL downloads content and persists playable video', async () => {
  const h = harness(mp4);
  const result = await h.call({channelMode:'remote'}, 'doubao-seedance-2.0', completed);
  assert.equal(h.requests[0].url, '/api/v1/videos/task_upstream/content?model=doubao-seedance-2.0');
  assert.equal(h.requests[0].options.headers.Authorization, 'Bearer user-test-token');
  assert.equal(result.video_url, '/api/files/video.mp4');
  assert.equal(result.id, completed.id);
  assert.equal(result.task_id, completed.task_id);
  assert.equal(h.apiRequests.length, 0);
  assert.equal(h.stored.length, 1);
});

test('client ID resolves via one authenticated detail GET for either response shape', async () => {
  for (const channelMode of ['remote', 'local']) {
    for (const taskResponse of [completed, {code:0,data:completed}]) {
      const task = {id:completed.id,status:'completed',model:'doubao-seedance-2.0'};
      const h = harness(mp4, { taskResponse });
      const result = await h.call({channelMode}, '', task);
      assert.equal(h.apiRequests.length, 1);
      const request = h.apiRequests[0];
      assert.equal(request.method, 'GET');
      assert.equal(request.url, `/api/v1/videos/${task.id}`);
      assert.equal(request.options.params.model, task.model);
      assert.equal(request.options.headers.Authorization, 'Bearer user-test-token');
      assert.equal(request.options.headers[channelMode === 'remote' ? 'X-Model-Channel-ID' : 'X-User-Model-Channel-ID'], 'channel-test');
      assert.equal(h.requests.length, 1);
      assert.equal(h.requests[0].url, '/api/v1/videos/task_upstream/content?model=doubao-seedance-2.0');
      assert.equal(result.id, task.id);
      assert.equal(result.task_id, completed.task_id);
      assert.equal(result.storageKey, 'video-key');
      assert.equal(task.task_id, undefined);
    }
  }
});

test('local storage fallback also preserves the client identity after mapping', async () => {
  const task = {id:completed.id,task_id:completed.id,status:'completed'};
  const h = harness(mp4, { taskResponse: {code:0,data:completed}, failServerUpload: true });
  const result = await h.call({channelMode:'remote'}, 'doubao-seedance-2.0', task);
  assert.equal(h.apiRequests.length, 1);
  assert.equal(h.requests[0].url, '/api/v1/videos/task_upstream/content?model=doubao-seedance-2.0');
  assert.equal(result.id, task.id);
  assert.equal(result.task_id, completed.task_id);
  assert.equal(task.task_id, task.id);
  assert.equal(result.storageKey, 'local-video-key');
  assert.equal(h.stored.length, 0);
  assert.equal(h.localStored.length, 1);
});

test('mapping accepts only explicit upstream task_id and never retries or creates', async () => {
  for (const taskResponse of [
    {code:0,data:{id:'inferred-id',video_id:'inferred-video'}},
    {id:'inferred-id',video_id:'inferred-video'},
    {task_id:123}, {task_id:' '}, {task_id:'client_video_task_other'},
    {code:1,data:completed}, {code:0,data:[completed]},
    {code:0,data:{...completed,error:{message:'failed'}}},
    {...completed,error:{message:'failed'}},
    new Error('detail unavailable'),
  ]) {
    const task = {id:completed.id,status:'completed'};
    const h = harness(() => new Response('',{status:404}), { taskResponse });
    const result = await h.call({channelMode:'remote'}, 'doubao-seedance-2.0', task);
    assert.equal(h.apiRequests.length, 1);
    assert.equal(h.apiRequests[0].method, 'GET');
    assert.equal(h.apiRequests[0].url, `/api/v1/videos/${task.id}`);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, `/api/v1/videos/${task.id}/content?model=doubao-seedance-2.0`);
    assert.equal(result, task);
    assert.equal(h.stored.length, 0);
    assert.equal(h.localStored.length, 0);
  }
});

test('200 errors, including forged video MIME, and empty bodies are never stored', async () => {
  for (const [body, type] of [
    ['{"code":1,"msg":"failed"}','application/json'],
    ['<html>error</html>','text/html'],
    ['{"code":1,"msg":"failed"}','video/mp4'],
    ['<html>error</html>','video/mp4'],
    ['not a video','video/webm'],
    ['','video/mp4'],
  ]) {
    const h = harness(() => new Response(body,{headers:{'Content-Type':type}}));
    const result = await h.call({channelMode:'remote'},'doubao-seedance-2.0',completed);
    assert.equal(h.stored.length,0);
    assert.equal(h.localStored.length,0);
    assert.equal(result,completed);
  }
});

test('ISO image brands and image MIME are never persisted as video', async () => {
  for (const brand of ['avif','avis','heic','heix','mif1','msf1']) {
    for (const mime of ['image/avif','video/mp4','application/octet-stream']) {
      const bytes = new Uint8Array([0,0,0,20,102,116,121,112,...Buffer.from('isom'),0,0,0,0,...Buffer.from(brand)]);
      const h = harness(() => new Response(bytes,{headers:{'Content-Type':mime}}));
      const result = await h.call({channelMode:'remote'},'doubao-seedance-2.0',completed);
      assert.equal(h.stored.length,0);
      assert.equal(result,completed);
    }
  }
});

test('MP4 and WebM signatures are accepted even with generic MIME', async () => {
  for (const bytes of [
    [0,0,0,16,102,116,121,112,105,115,111,109,0,0,0,0],
    [0x1a,0x45,0xdf,0xa3,0x9f,0x42,0x86,0x81],
  ]) {
    const h = harness(() => new Response(new Uint8Array(bytes), {headers:{'Content-Type':'application/octet-stream'}}));
    const result = await h.call({channelMode:'remote'},'doubao-seedance-2.0',completed);
    assert.equal(h.stored.length,1);
    assert.equal(result.id,completed.id);
    assert.equal(result.storageKey,'video-key');
  }
});

test('HTTP errors, network failures and failed body reads preserve the task without storage', async () => {
  for (const responseFactory of [
    () => new Response('error',{status:502,headers:{'Content-Type':'video/mp4'}}),
    () => { throw new Error('network unavailable'); },
    () => ({ok:true,blob:async () => { throw new Error('body interrupted'); }}),
  ]) {
    const task = {...completed,video_url:'https://cdn.example/result.mp4'};
    const h = harness(responseFactory);
    const result = await h.call({channelMode:'remote'},'doubao-seedance-2.0',task);
    assert.equal(result,task);
    assert.equal(h.stored.length,0);
    assert.equal(h.localStored.length,0);
    for (const request of h.requests.filter(item => item.url.startsWith('https://cdn.example/'))) {
      assert.equal(request.options,undefined);
    }
  }
});

test('signed CDN fallback never receives API credentials', async () => {
  const h = harness(url => url.startsWith('/api/') ? new Response('',{status:502}) : mp4());
  const result = await h.call({channelMode:'remote',apiKey:'do-not-leak'},'doubao-seedance-2.0',{...completed,video_url:'https://cdn.example/result.mp4'});
  assert.equal(h.requests[1].url,'https://cdn.example/result.mp4');
  assert.equal(h.requests[1].options,undefined);
  assert.equal(result.video_url,'/api/files/video.mp4');
});

test('direct provider key is sent only to its configured content endpoint, not cross-origin fallback', async () => {
  const h = harness(url => url.startsWith('https://provider.example/') ? new Response('',{status:502}) : mp4(), {token:''});
  const result = await h.call({channelMode:'local',apiKey:'do-not-leak'},'doubao-seedance-2.0',{...completed,video_url:'https://cdn.example/result.mp4'});
  assert.equal(h.apiRequests.length,0);
  assert.equal(h.requests.length,2);
  assert.equal(h.requests[0].url,'https://provider.example/v1/videos/task_upstream/content');
  assert.equal(h.requests[0].options.headers.Authorization,'Bearer never-send-to-cdn');
  assert.equal(h.requests[1].url,'https://cdn.example/result.mp4');
  assert.equal(h.requests[1].options,undefined);
  assert.equal(result.id,completed.id);
  assert.equal(result.storageKey,'video-key');
});

test('pending and failed tasks never download content', async () => {
  for (const status of ['processing','failed']) {
    const h = harness(mp4);
    await h.call({channelMode:'remote'},'doubao-seedance-2.0',{...completed,status});
    assert.equal(h.requests.length,0);
  }
});
