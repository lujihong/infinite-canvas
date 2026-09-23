const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { create } = require('zustand');
const { persist, createJSONStorage } = require('zustand/middleware');

const root = path.resolve(__dirname, '..');
function compile(file) { return ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; }
function loadTs(file, modules, extra = {}) { const module = { exports: {} }; vm.runInNewContext(compile(file), { exports: module.exports, require: (id) => modules[id] || {}, Promise, setTimeout, clearTimeout, ...extra }); return module.exports; }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function user(id) { return { id, username: id, displayName: id, avatarUrl: '', role: 'user', credits: 0, createdAt: '', updatedAt: '' }; }
function harness() {
    const local = new Map(); const window = { localStorage: { getItem: (key) => local.get(key) ?? null, setItem: (key, value) => local.set(key, value), removeItem: (key) => local.delete(key) } };
    const identity = loadTs(path.join(root, 'src/lib/session-identity.ts'), {});
    const effects = { reset: 0, skill: 0, loads: [] };
    const store = () => ({ getState: () => ({ reset: () => { effects.reset++; }, loadUserConfig: (id) => effects.loads.push(id), loadUserProject: (id) => effects.loads.push(id), clearProject() {} }) });
    const canvas = store(); canvas.persist = { rehydrate: async () => {} }; const assets = store(); assets.persist = { rehydrate: async () => {} };
    let currentUser = async (token) => user(token); let loginRequest = async () => ({ token: 'login-token', user: user('LOGIN') }); let registerRequest = async () => ({ token: 'register-token', user: user('REGISTER') });
    const modules = {
        '@/services/api/auth': { AUTH_TOKEN_KEY: 'auth-token', fetchCurrentUser: (...a) => currentUser(...a), login: (...a) => loginRequest(...a), register: (...a) => registerRequest(...a) },
        '@/lib/session-identity': identity, '@/components/layout/app-providers': { appQueryClient: { clear() { effects.reset++; } } },
        '@/app/(user)/canvas/stores/use-canvas-store': { useCanvasStore: canvas }, '@/stores/use-asset-store': { useAssetStore: assets },
        '@/stores/use-config-store': { useConfigStore: store() }, '@/stores/use-editor-store': { useEditorStore: store() },
        '@/stores/use-agent-skill-store': { resetAgentSkillCache: () => { effects.skill++; } }, '@/services/image-storage': { clearGuestStorageProviders: async () => {} },
        zustand: { create }, 'zustand/middleware': { persist, createJSONStorage },
    };
    const result = loadTs(path.join(root, 'src/stores/use-user-store.ts'), modules, { window });
    return { ...result, identity, effects, local, setCurrentUser: (fn) => { currentUser = fn; }, setLogin: (fn) => { loginRequest = fn; }, modules };
}

test('real store transitions login and register, persisting only the current token', async () => {
    const h = harness(); await h.useUserStore.getState().login({ username: 'a', password: 'p' });
    assert.equal(h.useUserStore.getState().user.id, 'LOGIN'); await h.useUserStore.getState().register({ username: 'b', password: 'p' });
    assert.equal(JSON.parse(h.local.get('auth-token')).state.token, 'register-token'); assert.ok(h.effects.skill >= 2);
});

test('late hydrate success and failure cannot replace newer identity', async () => {
    for (const fail of [false, true]) { const h = harness(); await h.useUserStore.getState().setSession('old', user('OLD')); const request = deferred(); h.setCurrentUser(() => request.promise);
        const hydrating = h.useUserStore.getState().hydrateUser(); await Promise.resolve(); await h.useUserStore.getState().setSession('new', user('NEW'));
        fail ? request.reject(new Error('expired')) : request.resolve(user('STALE')); await hydrating;
        assert.equal(h.useUserStore.getState().token, 'new'); assert.equal(h.useUserStore.getState().user.id, 'NEW'); }
});

test('same account refresh updates user without resetting stores', async () => {
    const h = harness(); await h.useUserStore.getState().setSession('token', user('A')); const before = h.effects.reset;
    h.setCurrentUser(async () => ({ ...user('A'), displayName: 'Refreshed' })); await h.useUserStore.getState().hydrateUser();
    assert.equal(h.useUserStore.getState().user.displayName, 'Refreshed'); assert.equal(h.effects.reset, before);
});

test('rapid A-B-A transitions retain latest token and identity', async () => {
    const h = harness(); await h.useUserStore.getState().setSession('a1', user('A')); await h.useUserStore.getState().setSession('b', user('B')); await h.useUserStore.getState().setSession('a2', user('A'));
    assert.deepEqual({ token: h.identity.captureSessionIdentity().token, id: h.identity.captureSessionIdentity().userId }, { token: 'a2', id: 'A' });
});

test('logout invalidates in-flight hydration and finishes empty-token clearing', async () => {
    const h = harness(); await h.useUserStore.getState().setSession('a', user('A')); const request = deferred(); h.setCurrentUser(() => request.promise);
    const hydration = h.useUserStore.getState().hydrateUser(); await Promise.resolve(); const clearing = h.useUserStore.getState().clearSession(); request.resolve(user('STALE')); await Promise.all([hydration, clearing]);
    assert.equal(h.useUserStore.getState().token, ''); assert.equal(h.useUserStore.getState().user, null); assert.equal(h.useUserStore.getState().isReady, true);
});

test('transition failure clears session and does not persist stale account', async () => {
    const h = harness(); await h.useUserStore.getState().setSession('a', user('A'));
    const original = h.modules['@/stores/use-agent-skill-store']; h.modules['@/stores/use-agent-skill-store'] = null;
    const transition = h.useUserStore.getState().setSession('b', user('B'));
    await assert.rejects(transition); assert.equal(h.useUserStore.getState().token, ''); assert.equal(h.useUserStore.getState().user, null); assert.equal(h.useUserStore.getState().isReady, true);
    h.modules['@/stores/use-agent-skill-store'] = original;
});
