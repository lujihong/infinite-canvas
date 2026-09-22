const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const imagePath = path.resolve(__dirname, '../src/app/(user)/image/page.tsx');
const workflowPath = path.resolve(__dirname, '../src/components/workflows/creative-workflow-workspace.tsx');
const image = fs.readFileSync(imagePath, 'utf8');
const workflow = fs.readFileSync(workflowPath, 'utf8');
// Execute the actual pure functions, with only IO/application boundaries stubbed.
function functions(source, names, context = {}) {
    const ast = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const declarations = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text));
    assert.equal(declarations.length, names.length);
    const code = declarations.map(n => n.getText(ast)).join('\n') + '\nexports.result = {' + names.join(',') + '};';
    const scope = { exports: {}, ...context };
    vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, scope);
    return scope.exports.result;
}
const plain = value => JSON.parse(JSON.stringify(value));
const imageFns = functions(image, ['normalizeImageRequestSnapshot', 'resolveImageChannelId', 'buildGenerationLogConfig'], { normalizeLocalChannels: c => c.localChannels });
const workflowFns = functions(workflow, ['buildWorkflowImagePlan', 'workflowPlanTotal', 'buildWorkflowTextQuote', 'buildRunConfig', 'resolveWorkflowRuntime', 'resolveWorkflowImageChannelId'], { normalizeLocalChannels: c => c.localChannels, buildQuoteDescriptor: input => input });
const config = { channelMode: 'remote', model: 'text', imageModel: 'image', imageChannelId: 'old', activeChannelId: 'old', count: '8', apiMode: 'images', quality: 'high', size: '1:1', systemPrompt: 'base', systemPrompts: { image: '', text: '', workflow: 'workflow system' }, publicChannels: [{ id: 'old', models: ['image'] }, { id: 'retry', models: ['other'] }], models: ['image', 'other'] };

test('image snapshot preserves exact retry model/channel overrides, prompt/refs and outer batch', () => {
    const refs = [{ id: 'ref', dataUrl: 'blob:must-not-read' }];
    const snapshot = imageFns.normalizeImageRequestSnapshot(config, '  retry actual prompt  ', refs, 4, { imageModel: 'other', imageChannelId: 'retry', quality: 'low', size: '16:9', apiMode: 'responses' });
    assert.equal(snapshot.requestConfig.model, 'other');
    assert.equal(snapshot.requestConfig.activeChannelId, 'retry');
    assert.equal(snapshot.requestConfig.count, '1');
    assert.equal(snapshot.displayConfig.count, '4');
    assert.equal(snapshot.requestConfig.quality, 'low');
    assert.equal(snapshot.requestConfig.apiMode, 'responses');
    assert.equal(snapshot.text, 'retry actual prompt');
    assert.deepEqual(plain(snapshot.references), refs);
    assert.notEqual(snapshot.references, refs);
});

test('single workflow quotes each actual task with count one and existing clamp ten', () => {
    const template = { mode: 'single_image', config: { imageModel: 'other', imageChannelId: 'retry', count: '100', quality: 'low', systemPrompt: 'template' } };
    const run = workflowFns.buildRunConfig(config, template.config, workflowFns.resolveWorkflowRuntime(template, config));
    const refs = [{ dataUrl: 'https://cdn.example/ref.png' }];
    const plan = workflowFns.buildWorkflowImagePlan(template, run, 'rendered variables and negative prompt', refs, []);
    assert.equal(plan.length, 10);
    for (const item of plan) {
        assert.equal(item.config.model, 'other');
        assert.equal(item.config.activeChannelId, 'retry');
        assert.equal(item.config.count, '1');
        assert.equal(item.batchCount, 1);
        assert.equal(item.batchMode, 'separate');
        assert.equal(item.prompt, 'rendered variables and negative prompt');
        assert.deepEqual(plain(item.references.references), refs);
    }
});

test('series quotes distinct edited prompts and refs, excludes completed/running/empty just like execution', () => {
    const drafts = Array.from({ length: 20 }, (_, i) => ({ prompt: 'edited ' + i, status: i === 1 ? 'success' : i === 2 ? 'running' : 'draft' }));
    drafts.push({ prompt: ' ', status: 'failed' });
    const plan = workflowFns.buildWorkflowImagePlan({ mode: 'multi_image_series' }, config, 'unused base', [{ dataUrl: 'blob:local' }], drafts);
    assert.equal(plan.length, 18);
    assert.equal(plan[0].prompt, 'edited 0');
    assert.equal(plan[1].prompt, 'edited 3');
    assert.equal(plan[17].prompt, 'edited 19');
    assert.equal(plan[0].references.references[0].dataUrl, 'blob:local');
    assert.equal(workflowFns.buildWorkflowImagePlan({ mode: 'multi_image_series' }, config, 'base', [], []).length, 0);
});

test('plan sum never turns unresolved usage, errors, absent data or invalid amounts into zero', () => {
    const total = workflowFns.workflowPlanTotal;
    const quote = n => ({ status: 'estimated', points_cost: n });
    assert.equal(total([quote(2), quote(3)]), 5);
    assert.equal(total([quote(0), quote(0)]), 0);
    assert.equal(total([quote(1e-12)]), 1e-12);
    for (const missing of [undefined, { status: 'usage_required', points_cost: null }, { status: 'unavailable' }, quote(null), quote(NaN), quote(-1), quote(Infinity)]) assert.equal(total([quote(2), missing]), null);
    assert.equal(total([]), null);
    assert.equal(total([quote(Number.MAX_VALUE), quote(Number.MAX_VALUE)]), null);
});

test('text descriptor matches real system prompt precedence and leaves future token usage unknown', () => {
    const descriptor = workflowFns.buildWorkflowTextQuote({ ...config, model: 'planner', systemPrompts: { text: 'text system' } }, 'actual planning prompt');
    assert.equal(descriptor.endpoint, '/v1/chat/completions');
    assert.deepEqual(plain(descriptor.body), { model: 'planner', messages: [{ role: 'system', content: 'text system' }, { role: 'user', content: 'actual planning prompt' }], stream: true });
    assert.equal(descriptor.batch_count, 1);
    assert.doesNotMatch(JSON.stringify(descriptor), /input_tokens|output_tokens|max_tokens|usage/);
});

test('all three create layouts and retry cards use normalized snapshots without new confirmation or IO', () => {
    assert.match(image, /const snapshot = normalizeImageRequestSnapshot\(effectiveConfig, text, referenceItems, taskCount, configOverride\)/);
    assert.match(image, /const snapshot = normalizeImageRequestSnapshot\(config, prompt, references, generationCount\)/);
    assert.equal((image.match(/\{estimatedCredits\}/g) || []).length, 2); // one responsive bottom area + side area
    assert.match(image, /<ImageRetryCredits item=\{result\} count=\{1\}/);
    assert.match(image, /<ImageRetryCredits item=\{log\} count=\{Number\(log.config.count\) \|\| 1\}/);
    const credits = image.slice(image.indexOf('function ImageRetryCredits'), image.indexOf('function buildGenerationLogConfig'));
    assert.match(credits, /imageTaskChannelId\(item.task\)/);
    assert.doesNotMatch(credits, /upload|imageToDataUrl|resolveImageUrl|fetch\(|submitGenerationBatch|modal.confirm/);
});

test('workflow totals reset on user/plan changes and single-item retries show exact draft quote', () => {
    assert.equal((workflow.match(/key=\{JSON.stringify\(\[token, quoteUserId, runConfig.channelMode, runConfig.activeChannelId, imagePlan\]\)\}/g) || []).length, 2);
    assert.match(workflow, /prompt: draft.prompt.trim\(\), references: \{ references \}, batchCount: 1, batchMode: "separate"/);
    assert.match(workflow, /<WorkflowDraftCredits token=\{token\} active=\{agentOpen\} prompt=\{agentPrompt\} model=\{agentTextModel \|\| effectiveConfig.textModel \|\| effectiveConfig.model\} channelMode=\{effectiveConfig.channelMode\} channelId=\{agentTextChannelId \|\| effectiveConfig.textChannelId\}/);
    const draftQuote = workflow.slice(workflow.indexOf('function WorkflowDraftCredits'), workflow.indexOf('type WorkflowVariableType'));
    assert.match(draftQuote, /apiPost<WorkflowDraftQuote>\("\/api\/v1\/workflows\/agent-draft\/quote", \{ prompt: text, model, channelMode, channelId \}, token\)/);
    assert.match(draftQuote, /result\?\.key === key/);
    assert.match(draftQuote, /cancelled = true; clearTimeout\(timer\)/);
    assert.doesNotMatch(draftQuote, /apiKey|baseUrl|references|draftUserWorkflow/);
    assert.match(workflow, /config=\{promptConfig\} descriptor=\{promptDescriptor\}/);
    assert.doesNotMatch(workflow.slice(workflow.indexOf('function buildWorkflowTextQuote'), workflow.indexOf('function WorkflowCard')), /upload|imageToDataUrl|resolveImageUrl|fetch\(|¥/);
});
