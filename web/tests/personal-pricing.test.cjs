const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { create } = require('zustand');

function harness() {
    const users = create(() => ({ token: 'a-token', user: { id: 'a' } }));
    const requests = [];
    const modules = {
        axios: { request: options => new Promise(resolve => requests.push({ options, resolve })) },
        react: { useEffect() {} }, zustand: { create },
        '@/stores/use-user-store': { useUserStore: users },
    };
    function load(relative, overrides = {}) {
        const source = fs.readFileSync(path.resolve(__dirname, relative), 'utf8');
        const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, reportDiagnostics: true });
        assert.equal(compiled.diagnostics.length, 0);
        const scope = { exports: {}, require: id => overrides[id] || modules[id] || {}, AbortController, Date, Map, window: {} };
        vm.runInNewContext(compiled.outputText, scope);
        return scope.exports;
    }
    const api = load('../src/services/api/pricing.ts');
    return { users, requests, api, load };
}
const model = (price, extra = {}) => ({ model_name: 'image', quota_type: 1, points_cost: 0, formatted_points_cost: `${price} USD/次 · 按平台账单结算`, estimated: true, billing_mode: '', billing_expr: '', billing_description: '实际计费组由路由决定', group_quotes: [{ group: 'vip', final_ratio: 0.5, usd_price: price, base_usd: 2, unit: 'USD/次', formatted_points_cost: `${price} USD/次` }], ...extra });
const succeed = (request, value) => request.resolve({ status: 200, data: { code: 0, data: [value] } });

test('identity switch aborts old request, clears prices and rejects late responses', async () => {
    const { api, users, requests } = harness();
    const a = api.loadRemotePricing();
    assert.equal(requests[0].options.headers.Authorization, 'Bearer a-token');
    users.setState({ token: 'b-token', user: { id: 'b' } });
    assert.equal(requests[0].options.signal.aborted, true);
    assert.equal(api.getModelPricing('image'), undefined);
    const b = api.loadRemotePricing();
    assert.equal(requests[1].options.headers.Authorization, 'Bearer b-token');
    succeed(requests[1], model(1)); await b;
    succeed(requests[0], model(0.5)); await a;
    assert.equal(api.getModelPricing('image').group_quotes[0].usd_price, 1);
    users.setState({ token: '', user: null });
    assert.equal(api.getModelPricing('image'), undefined);
    assert.equal((await api.loadRemotePricing()).size, 0);
    await assert.rejects(api.fetchModelPricingList(), /登录/);
});

test('same identity shares only in-flight session request; next user gets a fresh price', async () => {
    const { api, users, requests } = harness();
    const first = api.loadRemotePricing();
    assert.equal(api.loadRemotePricing(), first);
    succeed(requests[0], model(0.5)); await first;
    users.setState({ token: 'b-token', user: { id: 'b' } });
    assert.equal(api.getModelPricing('image'), undefined);
    const second = api.loadRemotePricing();
    requests[1].resolve({ status: 200, data: { code: 1, data: [model(100)] } }); await second;
    assert.equal(api.getModelPricing('image'), undefined);
    const retry = api.loadRemotePricing();
    succeed(requests[2], model(0)); await retry;
    assert.equal(api.getModelPricing('image').group_quotes[0].usd_price, 0);
});

test('switching away and back rejects the first session even with identical token', async () => {
    const { api, users, requests } = harness();
    const pending = api.fetchModelPricingList();
    users.setState({ token: 'b-token', user: { id: 'b' } });
    users.setState({ token: 'a-token', user: { id: 'a' } });
    succeed(requests[0], model(0.5));
    await assert.rejects(pending, /身份已改变/);
});

test('model IDs remain exact including case and spaces; public payloads are rejected', async () => {
    const { api, requests, users } = harness();
    const pending = api.loadRemotePricing();
    requests[0].resolve({ status: 200, data: { code: 0, data: [model(1, { model_name: 'Model' }), model(2, { model_name: 'model' }), model(3, { model_name: ' model ' })] } });
    await pending;
    assert.equal(api.getModelPricing('Model').group_quotes[0].usd_price, 1);
    assert.equal(api.getModelPricing('model').group_quotes[0].usd_price, 2);
    assert.equal(api.getModelPricing(' model ').group_quotes[0].usd_price, 3);
    assert.equal(api.getModelPricing('MODEL'), undefined);
    users.setState({ token: 'b-token', user: { id: 'b' } });
    const publicPayload = api.fetchModelPricingList();
    succeed(requests[1], { model_name: 'model', points_cost: 7 });
    await assert.rejects(publicPayload, /不完整/);
});

test('pricing details keep discount zero, final group rate, units and expression', () => {
    const { api } = harness();
    const text = api.personalPricingDetails(model(0, { discount: { factor: 0, source: 'user' }, billing_mode: 'tiered_expr', billing_expr: 'duration * 0.3' }));
    assert.match(text, /本人优惠倍率 0/);
    assert.match(text, /最终倍率 0.5/);
    assert.match(text, /基价 2 USD\/次/);
    assert.match(text, /duration \* 0.3/);
});

test('credit display never applies video multipliers or guesses credits for personal USD/tiered quotes', () => {
    const { load } = harness();
    let pricing = model(0, { billing_mode: 'tiered_expr', billing_expr: 'duration * 0.3', formatted_points_cost: '按实际用量结算' });
    const credits = load('../src/constant/credits.tsx', { '@/services/api/pricing': { getModelPricing: () => pricing } });
    const options = { model: 'image', mode: 'video', seconds: 10, resolution: '1080p' };
    assert.equal(credits.formatModelCostTag(options), '按实际用量结算');
    assert.equal(credits.requestCreditCost(options), 0);
    pricing = model(0);
    assert.equal(credits.formatModelCostTag(options), '0 USD/次 · 按平台账单结算');
    assert.equal(credits.requestCreditCost(options), 0);
    pricing = undefined;
    assert.equal(credits.formatModelCostTag(options), '本人报价暂不可用');
});

test('edited display consumers transpile without syntax diagnostics', () => {
    for (const name of ['model-picker', 'config-model-input']) {
        const source = fs.readFileSync(path.resolve(__dirname, `../src/components/${name}.tsx`), 'utf8');
        const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }, reportDiagnostics: true });
        assert.equal(compiled.diagnostics.length, 0);
    }
});
