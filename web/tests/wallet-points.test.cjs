const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { create } = require('zustand');
const { createRequire } = require('node:module');
const { JSDOM } = createRequire(process.env.XYB_RELAY_PACKAGE || path.resolve(__dirname, '../package.json'))('jsdom');

function load(file, modules = {}, globals = {}) {
    const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const scope = { exports: {}, require: id => {
        if (id in modules) return modules[id];
        if (['react', 'react/jsx-runtime', 'dayjs'].includes(id)) return require(id);
        throw new Error(`Unexpected module ${id}`);
    }, setTimeout, clearTimeout, setInterval, clearInterval, ...globals };
    vm.runInNewContext(code, scope);
    return scope.exports;
}
const points = load('lib/points.ts');
const walletValue = points => ({ points, quota: null, balanceYuan: null, exchangeRate: null, formattedPoints: '0.0 积分', formattedBalance: '¥999.00', minTopup: 1 });
function setup() {
    const users = create(() => ({ token: 'token-a', user: { id: 'a', username: 'a' }, openLoginModal() {} }));
    const requests = [], timers = [];
    const api = { fetchUserWallet: token => new Promise((resolve, reject) => requests.push({ token, resolve, reject })) };
    const modules = { zustand: { create }, '@/services/api/auth': api, '@/stores/use-user-store': { useUserStore: users }, '@/lib/points': points };
    const store = load('stores/use-wallet-store.ts', modules, { setTimeout: fn => timers.push(fn) }).useWalletStore;
    return { users, requests, timers, store, modules: { ...modules, '@/stores/use-wallet-store': { useWalletStore: store } } };
}

test('format preserves decimals, tiny positives, true zero and unknown', () => {
    for (const value of [0, 0.04, 0.00002, 1e-12, 12.3456789]) assert.equal(points.formatPoints(value), `${value} 积分`);
    for (const value of [null, undefined, NaN, Infinity, -1, '0']) assert.equal(points.formatPoints(value), '积分暂不可用');
    assert.equal(points.formatPoints(1 / 500000 * 10), '0.00002 积分');
    assert.equal(points.formatPoints(0.1 + 0.2), '0.3 积分');
    assert.equal(points.formatPoints(1 / 500000 * 10, '+'), '+0.00002 积分');
});
test('wallet failure clears old balance; unknown is not zero; local null quota is usable', async () => {
    const { store, requests } = setup();
    let promise = store.getState().fetchWallet(); requests[0].resolve(walletValue(0.04)); await promise;
    assert.equal(store.getState().checkBalanceOrIntercept(), true);
    promise = store.getState().fetchWallet(); requests[1].reject(new Error('offline')); await promise;
    assert.equal(store.getState().wallet, null); assert.equal(store.getState().isLoading, false);
    let intercepted = 0;
    assert.equal(store.getState().checkBalanceOrIntercept(() => intercepted++), true);
    assert.equal(store.getState().isRechargeOpen, false);
    promise = store.getState().fetchWallet(); requests[2].resolve(walletValue(0)); await promise;
    assert.equal(store.getState().checkBalanceOrIntercept(() => intercepted++), false);
    assert.equal(intercepted, 1); assert.equal(store.getState().isRechargeOpen, true);
});
test('latest request wins and stale errors cannot clear its balance or loading state', async () => {
    const { store, requests } = setup();
    const first = store.getState().fetchWallet(), second = store.getState().fetchWallet();
    requests[0].resolve(walletValue(99)); assert.equal(await first, null);
    assert.equal(store.getState().isLoading, true);
    requests[1].resolve(walletValue(0.02)); await second;
    assert.equal(store.getState().wallet.points, 0.02);
    const third = store.getState().fetchWallet(), fourth = store.getState().fetchWallet();
    requests[3].resolve(walletValue(5)); await fourth;
    requests[2].reject(new Error('old error')); await third;
    assert.equal(store.getState().wallet.points, 5);
});
test('token and user changes invalidate immediately, including A-B-A and logout', async () => {
    const { users, store, requests, timers } = setup();
    const first = store.getState().fetchWallet(); requests[0].resolve(walletValue(10)); await first;
    store.getState().triggerWalletSync();
    users.setState({ user: { id: 'b' } });
    assert.equal(store.getState().wallet, null);
    const second = store.getState().fetchWallet(); requests[2].resolve(walletValue(20)); await second;
    requests[1].resolve(walletValue(11)); await Promise.resolve();
    assert.equal(store.getState().wallet.points, 20);
    timers[0](); assert.equal(requests.length, 3);
    users.setState({ token: 'token-b' }); assert.equal(store.getState().wallet, null);
    const third = store.getState().fetchWallet();
    users.setState({ token: 'token-c' }); users.setState({ token: 'token-b' });
    requests[3].resolve(walletValue(30)); assert.equal(await third, null);
    const fourth = store.getState().fetchWallet(); users.setState({ token: '', user: null });
    requests[4].resolve(walletValue(40)); assert.equal(await fourth, null);
    assert.equal(store.getState().wallet, null); assert.equal(store.getState().isLoading, false);
    await store.getState().fetchWallet(); assert.equal(requests.length, 5);
});

test('late success cannot restore a wallet after the newest request failed', async () => {
    const { store, requests } = setup();
    const old = store.getState().fetchWallet(), latest = store.getState().fetchWallet();
    requests[1].reject(new Error('new failure')); await latest;
    requests[0].resolve(walletValue(99)); assert.equal(await old, null);
    assert.equal(store.getState().wallet, null); assert.equal(store.getState().isLoading, false);
});
test('profile refresh preserves wallet, but missing user requires login even with a token', async () => {
    const { store, users, requests } = setup();
    const promise = store.getState().fetchWallet(); requests[0].resolve(walletValue(0.04)); await promise;
    users.setState({ user: { id: 'a', displayName: 'updated' } });
    assert.equal(store.getState().wallet.points, 0.04);
    let login = 0;
    users.setState({ user: null, openLoginModal: () => login++ });
    assert.equal(store.getState().checkBalanceOrIntercept(), false); assert.equal(login, 1);
    await store.getState().fetchWallet(); assert.equal(requests.length, 1);
});

test('recharge ignores late orders and paid responses after account change or close', async () => {
    const dom = new JSDOM('<div id="root"></div>');
    const previous = { window: global.window, document: global.document, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
    Object.assign(global, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
    const root = createRoot(document.getElementById('root'));
    const context = setup(), modules = uiModules(context), orders = [], checks = [], timers = new Map();
    let timerID = 0, success = 0;
    modules['@/services/api/auth'].createRechargeOrder = (_amount, token) => new Promise(resolve => orders.push({ token, resolve }));
    modules['@/services/api/auth'].checkRechargeStatus = (_id, token) => new Promise(resolve => checks.push({ token, resolve }));
    const Recharge = load('components/wallet/recharge-modal.tsx', modules, { setInterval: fn => { timers.set(++timerID, fn); return timerID; }, clearInterval: id => timers.delete(id) }).RechargeModal;
    const render = open => React.act(async () => root.render(React.createElement(Recharge, { open, onClose() {}, onSuccess() { success++; } })));
    const pay = () => React.act(async () => [...document.querySelectorAll('button')].find(b => b.textContent.includes('立即充值')).click());
    const order = id => ({ trade_no: id, amount: 50, qrcode: id, payurl: '', orderName: id });
    try {
        await render(true); await pay();
        await React.act(async () => context.users.setState({ token: 'token-b', user: { id: 'b' } }));
        await React.act(async () => orders[0].resolve(order('ACCOUNT_A_ORDER')));
        assert.equal(timers.size, 0); assert.doesNotMatch(document.body.textContent, /ACCOUNT_A_ORDER/);
        await pay(); await React.act(async () => orders[1].resolve(order('B_ORDER')));
        assert.equal(timers.size, 1);
        const pending = [...timers.values()][0]();
        await React.act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '我已完成支付').click());
        assert.equal(checks.length, 2);
        await React.act(async () => context.users.setState({ token: 'token-c', user: { id: 'c' } }));
        await React.act(async () => { checks[0].resolve({ paid: true }); checks[1].resolve({ paid: true }); await pending; });
        assert.equal(success, 0); assert.equal(timers.size, 0); assert.doesNotMatch(document.body.textContent, /支付成功/);
        await pay(); await render(false);
        await React.act(async () => orders[2].resolve(order('CLOSED_ORDER')));
        assert.equal(timers.size, 0);
    } finally { await React.act(async () => root.unmount()); dom.window.close(); Object.assign(global, previous); }
});

function uiModules(context) {
    const Box = ({ children }) => React.createElement('div', null, children);
    const Overlay = ({ open, children, title }) => open ? React.createElement('section', null, title, children) : null;
    const Button = ({ children, onClick }) => React.createElement('button', { onClick }, children);
    const Skeleton = Object.assign(() => React.createElement('span', null, 'loading'), { Input: () => React.createElement('span', null, 'loading') });
    const antd = { App: { useApp: () => ({ message: { warning() {}, error() {}, success() {} } }) }, Button, Modal: Overlay, Drawer: Overlay, Skeleton, QRCode: Box, Dropdown: Box, Tooltip: Box, Empty: Box, Input: Box, Tag: Box };
    return { ...context.modules, antd, 'lucide-react': new Proxy({}, { get: () => () => null }), '@/components/ui/animated-theme-toggler': { AnimatedThemeToggler: Box }, '@/constant/credits': {}, '@/lib/utils': { cn: (...values) => values.join(' ') }, '@/lib/canvas-theme': { canvasThemes: { light: { node: { text: 'black' } } } }, '@/stores/use-config-store': { useConfigStore: selector => selector({ openConfigDialog() {} }) }, '@/stores/use-theme-store': { useThemeStore: selector => selector({ theme: 'light', setTheme() {} }) }, 'next/link': Box };
}

test('jsdom: header, recharge and logs show exact points, failed reads and retained RMB payment', async () => {
    const dom = new JSDOM('<div id="root"></div>');
    const previous = { window: global.window, document: global.document, IS_REACT_ACT_ENVIRONMENT: global.IS_REACT_ACT_ENVIRONMENT };
    Object.assign(global, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
    const root = createRoot(document.getElementById('root'));
    try {
        const context = setup(), modules = uiModules(context);
        modules['@/services/api/auth'].fetchUserConsumptionLogs = async () => [{ id: 1, model_name: 'test', type: 2, status: 'success', points_cost: 0.00002, formatted_points: '0.0 积分', formatted_money: '¥9', created_at: 0 }];
        modules['@/services/api/auth'].fetchUserRechargeLogs = async () => [];
        modules['./consumption-cost'] = load('components/wallet/consumption-cost.ts', modules);
        const Drawer = load('components/wallet/consumption-logs-drawer.tsx', modules).ConsumptionLogsDrawer;
        const Recharge = load('components/wallet/recharge-modal.tsx', modules).RechargeModal;
        const Header = load('components/layout/user-status-actions.tsx', { ...modules, '@/components/wallet/recharge-modal': { RechargeModal: () => null }, '@/components/wallet/consumption-logs-drawer': { ConsumptionLogsDrawer: () => null } }).UserStatusActions;
        await React.act(async () => root.render(React.createElement(Header)));
        await React.act(async () => context.requests[0].resolve(walletValue(0.04)));
        assert.match(document.body.textContent, /0\.04 积分/); assert.doesNotMatch(document.body.textContent, /¥/);
        const balance = [...document.querySelectorAll('button')].find(button => button.title.includes('当前可用算力'));
        assert.match(balance.title, /0\.04 积分/); assert.doesNotMatch(balance.title, /¥/);
        await React.act(async () => { const promise = context.store.getState().fetchWallet(); context.requests[1].reject(new Error('offline')); await promise; });
        assert.match(document.body.textContent, /积分暂不可用/); assert.doesNotMatch(balance.title, /0\.0|¥/);
        await React.act(async () => root.render(React.createElement(Recharge, { open: true, onClose() {} })));
        await React.act(async () => context.requests[2].resolve(walletValue(0.00002)));
        assert.match(document.body.textContent, /账户当前可用算力0\.00002 积分/);
        assert.match(document.body.textContent, /支付 ¥50/); assert.match(document.body.textContent, /充值积分暂不可用/);
        assert.doesNotMatch(document.body.textContent, /¥999|500 积分/);
        await React.act(async () => context.users.setState({ user: { id: 'b' } }));
        await React.act(async () => context.requests[3].reject(new Error('offline')));
        assert.match(document.body.textContent, /账户当前可用算力积分暂不可用/); assert.doesNotMatch(document.body.textContent, /0\.00002 积分/);
        await React.act(async () => root.render(React.createElement(Drawer, { open: true, onClose() {} })));
        assert.match(document.body.textContent, /当前可用算力余额积分暂不可用/);
        assert.match(document.body.textContent, /累计历史调用扣费0\.00002 积分/);
        assert.match(document.body.textContent, /-0\.00002 积分/); assert.doesNotMatch(document.body.textContent, /¥/);
        const detail = [...document.querySelectorAll('button')].find(button => button.textContent === '查看详情');
        await React.act(async () => detail.click());
        assert.match(document.body.textContent, /积分结算：-0\.00002 积分/); assert.doesNotMatch(document.body.textContent, /¥/);
        modules['@/services/api/auth'].fetchUserConsumptionLogs = async () => { throw new Error('offline'); };
        await React.act(async () => document.querySelector('button[title="刷新记录"]').click());
        assert.match(document.body.textContent, /累计历史调用扣费积分暂不可用/);
        await React.act(async () => context.store.setState({ wallet: walletValue(0) }));
        assert.match(document.body.textContent, /当前可用算力余额0 积分/);
        modules['@/services/api/auth'].fetchUserRechargeLogs = async () => [{ id: 1, trade_no: 'tiny', status: 'success', points: 0.00002, money: 10, amount: 10 }];
        await React.act(async () => root.render(React.createElement(Drawer, { open: true, initialTab: 'recharge', onClose() {} })));
        assert.match(document.body.textContent, /累计获得算力\+0\.00002 积分/);
        assert.match(document.body.textContent, /实付 ¥10\.00/);
        modules['@/services/api/auth'].fetchUserRechargeLogs = async () => [{ id: 1, trade_no: 'unknown', status: 'success', points: null, money: 10, amount: 10 }];
        await React.act(async () => document.querySelector('button[title="刷新记录"]').click());
        assert.match(document.body.textContent, /累计获得算力积分暂不可用/);
        assert.doesNotMatch(document.body.textContent, /100 积分/);
    } finally {
        await React.act(async () => root.unmount()); dom.window.close(); Object.assign(global, previous);
    }
});
