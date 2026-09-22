const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '../src');
const canvasFile = 'app/(user)/canvas/[id]/canvas-client-page.tsx';
const videoFile = 'app/(user)/video/page.tsx';
function functionsFrom(file, names, globals = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const selected = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.includes(s.name?.text));
  assert.equal(selected.length, names.length);
  const code = ts.transpileModule(selected.map(s => s.getText(ast)).join('\n') + `\nexport { ${names.join(',')} };`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const scope = { exports: {}, ...globals };
  vm.runInNewContext(code, scope);
  return scope.exports;
}
function context(extra = {}) { return { prompt: '场景', referenceImages: [], referenceVideos: [], referenceAudios: [], firstFrame: null, lastFrame: null, videoMultiPrompt: [], videoElementList: [], ...extra }; }
function canvas(extra = {}) {
  return functionsFrom(canvasFile, ['buildCanvasGenerationQuote'], {
    buildQuoteDescriptor: input => input,
    sourceNodeReferenceImages: () => [],
    isPanoramaNodeType: type => type === 'panorama', PANORAMA_IMAGE_SIZE: '2:1',
    isKIESeedreamLayerDecompositionModel: model => model === 'layers',
    getGenerationCount: count => Math.min(15, Math.max(1, Number(count))),
    buildPanoramaPrompt: text => '全景 ' + text, applyCameraPrompt: text => text,
    withCanvasVideoAdvancedConfig: (config, context) => ({ ...config, videoMultiPrompt: context.videoMultiPrompt, videoElementList: context.videoElementList }),
    supportsVideoFrameReferences: () => true, channelProtocolForConfig: () => 'openai',
    buildNodeChatMessages: context => [{ role: 'user', content: context.prompt }],
    isMimoTtsModel: model => model === 'clone', isMimoVoiceCloneModel: model => model === 'clone', isMimoPresetTtsModel: () => false, isMimoVoiceDesignModel: () => false,
    normalizeMimoTtsFormat: value => value,
    ...extra,
  }).buildCanvasGenerationQuote;
}
test('canvas image counts outer tasks with one image per request; panorama normalizes auto', () => {
  const quote = canvas()({ model: 'image', count: '4', quality: 'auto' }, { type: 'panorama' }, 'image', context());
  assert.equal(quote.descriptor.batchCount, 4);
  assert.equal(quote.descriptor.config.count, '1');
  assert.equal(quote.descriptor.config.quality, 'medium');
  assert.equal(quote.descriptor.config.size, '2:1');
  assert.equal(quote.descriptor.batchMode, 'separate');
  assert.equal(canvas()({ model: 'layers', count: '4' }, { type: 'image' }, 'image', context()).descriptor.batchCount, 1);
});
test('canvas keeps channel identity and advanced metadata, including frame fallback', () => {
  const image = { aiccUri: 'asset://asset-123', aiccChannelId: 17 };
  const refs = context({ referenceImages: [image], firstFrame: { url: 'https://x/first' }, lastFrame: { url: 'https://x/last' }, referenceVideos: [{ url: 'https://x/video' }], referenceAudios: [{ url: 'https://x/audio' }], videoMultiPrompt: [{ duration: '5', prompt: 'shot' }], videoElementList: [{ name: '角色' }] });
  const quote = canvas()({ model: 'video', activeChannelId: '17' }, {}, 'video', refs);
  assert.equal(quote.descriptor.references.references[0], image);
  assert.equal(quote.config.activeChannelId, '17');
  assert.equal(quote.config.videoElementList, refs.videoElementList);
  assert.equal(quote.descriptor.references.videoReferences, refs.referenceVideos);
  assert.equal(quote.descriptor.references.audioReferences, refs.referenceAudios);
  assert.equal(quote.descriptor.references.firstFrame, refs.firstFrame);
  const fallback = canvas({ supportsVideoFrameReferences: () => false })({ model: 'video' }, {}, 'video', refs);
  assert.equal(fallback.descriptor.references.references.length, 3);
  assert.equal(fallback.descriptor.references.firstFrame, null);
});
test('composer quotation uses only selected refs from real generation context', () => {
  const types = { Text: 'text', Image: 'image', Config: 'config', Video: 'video', Audio: 'audio' };
  const source = fs.readFileSync(path.join(root, 'app/(user)/canvas/components/canvas-node-generation.ts'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const modules = {
    '../types': { CanvasNodeType: types }, '../utils/canvas-panorama': { isCanvasImageNodeType: type => type === 'image' },
    '../utils/canvas-resource-references': { getGenerationResourceNodes: (id, nodes) => nodes.filter(n => n.id !== id) },
    '@/lib/image-reference-prompt': { imageReferenceLabel: i => `图片${i + 1}` }, '@/lib/seedance-video': { seedanceReferenceLabel: (kind, i) => `${kind}${i}` },
  };
  const scope = { exports: {}, require: name => modules[name] || {} };
  vm.runInNewContext(code, scope);
  const nodes = [{ id: 'cfg', type: 'config', metadata: { composerContent: '@[node:chosen]' } }, { id: 'chosen', type: 'image', metadata: { aiccUri: 'asset://asset-123', aiccChannelId: 17 } }, { id: 'unused', type: 'image', metadata: { content: 'https://x/unused' } }];
  const generated = scope.exports.buildNodeGenerationContext('cfg', nodes, [], '@[node:chosen]');
  const quote = canvas()({ model: 'video' }, nodes[0], 'video', generated);
  assert.equal(quote.descriptor.references.references.length, 1);
  assert.equal(quote.descriptor.references.references[0].aiccChannelId, 17);
});
test('text usage is left unknown; MiMo clone never becomes ordinary speech', () => {
  const quote = canvas()({ model: 'text' }, {}, 'text', context());
  assert.equal(quote.descriptor.endpoint, '/v1/chat/completions');
  assert.equal(quote.descriptor.body.max_tokens, undefined);
  const clone = canvas()({ model: 'clone', mimoTtsFormat: 'wav', audioInstructions: '' }, {}, 'audio', context());
  assert.equal(clone.descriptor.body.response_format, 'wav');
  assert.ok(clone.descriptor.missing_fields.includes('声音复刻参考音频'));
  assert.equal(clone.descriptor.body.voice, undefined);
});
test('video snapshot preserves five reference types and normalized config with outer task count', () => {
  const snapshot = functionsFrom(videoFile, ['buildVideoSubmissionSnapshot'], {
    isAPIMartKlingV26Config: () => false, isKlingV3Config: () => false, kieKlingOmniVariant: () => '', supportsVideoFrameReferences: () => true,
    channelProtocolForConfig: () => 'openai', buildVideoConfig: (config, model) => ({ ...config, model, videoSeconds: '8' }), normalizeVideoCount: value => Math.min(6, value),
  }).buildVideoSubmissionSnapshot;
  const input = { model: 'video', config: { videoSeconds: '8.0', activeChannelId: 'channel' }, prompt: ' 镜头 ', references: [{ aiccUri: 'asset://asset-123', aiccChannelId: 17 }], firstFrame: { url: 'https://x/first' }, lastFrame: { url: 'https://x/last' }, videoReferences: [{ url: 'https://x/video' }], audioReferences: [{ url: 'https://x/audio' }], taskCount: 3 };
  const result = snapshot(input);
  assert.equal(result.config.videoSeconds, '8');
  assert.equal(result.taskCount, 3);
  assert.equal(result.references[0], input.references[0]);
  assert.equal(result.firstFrame, input.firstFrame);
  assert.equal(result.lastFrame, input.lastFrame);
  assert.equal(result.videoReferences[0], input.videoReferences[0]);
  assert.equal(result.audioReferences[0], input.audioReferences[0]);
});
test('Kling side panel receives the same quote snapshot as the general workbench', () => {
  const page = fs.readFileSync(path.join(root, videoFile), 'utf8');
  const panel = fs.readFileSync(path.join(root, 'app/(user)/video/components/kling-v26-workbench-panel.tsx'), 'utf8');
  assert.match(page, /<KlingV26WorkbenchPanel\s+generationQuote=\{generationQuote\}/);
  assert.match(panel, /<EstimatedCredits \{\.\.\.generationQuote\}/);
});
test('EstimatedCredits renders hook status and explains missing usage without currency', () => {
  const source = fs.readFileSync(path.join(root, 'components/estimated-credits.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  for (const label of ['预计消耗 12 积分', '预计积分计算中…', '按实际用量结算积分', '预计积分暂不可用']) {
    const scope = { exports: {}, require: name => name === 'react/jsx-runtime' ? require(name) : name === 'antd' ? { Tooltip: ({ children, title }) => React.createElement('div', null, title, children) } : { useRequestQuote: () => ({ quote: { missing_fields: ['输出时长'] }, label, detail: '按实际用量\n待确定：输出时长' }) } };
    vm.runInNewContext(code, scope);
    const html = renderToStaticMarkup(React.createElement(scope.exports.EstimatedCredits, { config: {}, descriptor: null }));
    assert.ok(html.includes(label)); assert.ok(html.includes('输出时长')); assert.ok(html.includes('whitespace-normal')); assert.ok(!html.includes('¥'));
  }
});
