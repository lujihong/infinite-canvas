const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { createRoot } = require('react-dom/client');
const { createRequire } = require('node:module');
const relayRequire = createRequire(process.env.XYB_RELAY_PACKAGE || path.resolve(__dirname, '../package.json'));
const { JSDOM } = relayRequire('jsdom');
const base = path.resolve(__dirname, '../src');

function load(file, modules, globals = {}, suffix = '') {
    const source = fs.readFileSync(path.join(base, file), 'utf8') + suffix;
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const scope = { exports: {}, require: id => modules[id] || {}, Error, AbortController, Date, setInterval, clearInterval, setTimeout, clearTimeout, ...globals };
    vm.runInNewContext(compiled, scope);
    return scope.exports;
}
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const success = data => ({ data: { success: true, data } });

async function setup(options = {}) {
    const dom = new JSDOM('<div id="root"></div>', { url: 'https://workbench.example', pretendToBeVisual: true });
    const saved = new Map();
    for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'ShadowRoot', 'File', 'Blob', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT']) {
        saved.set(key, Object.getOwnPropertyDescriptor(global, key));
        Object.defineProperty(global, key, { configurable: true, writable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : dom.window[key] });
    }
    dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    let state = { user: { id: 'A' }, token: 'workbench-A' };
    const store = Object.assign(select => select(state), { getState: () => state });
    const calls = [];
    const uploads = [];
    const api = load('services/api/aicc.ts', {
        axios: { request: async config => {
            calls.push(config);
            if (options.request) { const result = options.request(config, calls); if (result !== undefined) return result; }
            if (config.url.endsWith('/uploads')) {
                const value = { id: 'upload-1', url: 'https://private.example/signed', assetType: config.data.get('assetType'), bytes: 8, mimeType: 'image/png', expiresAt: Math.floor(Date.now() / 1000) + 600 };
                uploads.push(value); return success(value);
            }
            return success({ state: 'OK' });
        } },
        '@/stores/use-user-store': { useUserStore: store },
    }, { FormData: dom.window.FormData });
    const ui = {};
    ui.Button = ({ children, disabled, loading, onClick, ...props }) => React.createElement('button', { disabled, onClick, 'aria-label': props['aria-label'], 'data-loading': String(!!loading) }, children);
    ui.Input = ({ value, onChange, ...props }) => React.createElement('input', { value, onChange, disabled: props.disabled, 'aria-label': props['aria-label'], placeholder: props.placeholder });
    ui.Select = ({ value, options, onChange, ...props }) => React.createElement('select', { value, 'aria-label': props['aria-label'], onChange: e => onChange(e.target.value) }, options?.map(item => React.createElement('option', { key: item.value, value: item.value }, item.label)));
    ui.Alert = ({ message }) => React.createElement('div', { role: 'alert' }, message);
    for (const name of ['Empty', 'QRCode', 'Spin', 'Tag']) ui[name] = ({ children }) => React.createElement('div', null, children);
    ui.App = { useApp: () => ({ message: { success() {}, info() {}, error() {} } }) };
    // Use the actual antd uploader, so click/drop checks exercise rc-upload rather than a fake file control.
    ui.Upload = require('antd').Upload;
    const groupData = { data: [{ groupId: 'group-1', groupName: '本人', groupType: 'LivenessFace' }, { groupId: 'group-2', groupName: '另一个组', groupType: 'LivenessFace' }] };
    const assetData = { data: [{ assetId: 'asset-active', assetName: '已入库', assetType: 'Image', status: 'ACTIVE', assetUrl: 'https://preview.example/a.png' }, { assetId: 'asset-video', assetName: '视频', assetType: 'Video', status: 'PROCESSING', assetUrl: 'https://preview.example/a.mp4' }, { assetId: 'asset-audio', assetName: '音频', assetType: 'Audio', status: 'ACTIVE', assetUrl: 'https://preview.example/a.wav' }] };
    const queryOptions = [];
    const modules = { react: React, 'react/jsx-runtime': require('react/jsx-runtime'), antd: ui, 'lucide-react': { Radio: () => null },
        '@tanstack/react-query': { useQuery: opts => { queryOptions.push(opts); return { data: opts.queryKey[0] === 'aicc-channels' ? [{id:6,name:'移动云',models:[]}] : opts.queryKey.includes('groups') ? groupData : {data:assetData.data.map(asset=>({...asset,channelId:6}))}, refetch: async () => {}, isPending: false, isLoading: false, isFetching: false, dataUpdatedAt: 0 }; } },
        '@/stores/use-user-store': { useUserStore: store }, '@/services/api/aicc': api,
    };
    const picker = load('components/aicc/asset-picker.tsx', modules, { document, URL: dom.window.URL });
    const root = createRoot(document.getElementById('root'));
    const inserted = [];
    const render = async (selectionEnabled = true) => React.act(async () => root.render(React.createElement(picker.AiccAssetPicker, { selectionEnabled, onInsert: value => inserted.push(value) })));
    const button = text => [...document.querySelectorAll('button')].find(el => el.textContent === text);
    const click = async text => { assert.ok(button(text), `missing button ${text}`); await React.act(async () => button(text).click()); };
    const choose = async (name = 'portrait.png', type = 'image/png', drop = false) => {
        const file = new dom.window.File(['contents'], name, { type });
        await React.act(async () => {
            if (drop) {
                const event = new dom.window.Event('drop', { bubbles: true });
                Object.defineProperty(event, 'dataTransfer', { value: { files: [file], items: [] } });
                document.querySelector('.ant-upload-btn').dispatchEvent(event);
            } else {
                const input = document.querySelector('input[type="file"]');
                assert.ok(input && !input.disabled, 'real enabled file input is present');
                Object.defineProperty(input, 'files', { configurable: true, value: [file] });
                input.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
            }
            await new Promise(resolve => setTimeout(resolve, 30));
        });
        return file;
    };
    const select = async (label, value) => React.act(async () => { const el = document.querySelector(`select[aria-label="${label}"]`); el.value = value; el.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    const cleanup = async () => {
        await React.act(async () => root.unmount());
        dom.window.close();
        for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(global, key, descriptor); else delete global[key]; }
    };
    await render(options.selectionEnabled ?? true);
    return { dom, api, ui, modules, calls, uploads, queryOptions, root, button, click, choose, select, render, inserted, setState: value => { state = value; }, cleanup };
}

test('real file control is clickable and two-step multipart upload uses workbench bearer, then creates asset', async () => {
    const h = await setup();
    try {
        const input = document.querySelector('input[type="file"]');
        let clicked = 0;
        input.addEventListener('click', () => clicked++);
        await React.act(async () => document.querySelector('.ant-upload-btn').click());
        assert.equal(clicked, 1);
        await h.choose();
        await h.click('提交入库');
        assert.deepEqual(h.calls.map(c => c.url), ['/api/aicc/uploads', '/api/aicc/assets']);
        const [upload, create] = h.calls;
        assert.equal(upload.method, 'POST');
        assert.equal(upload.headers.Authorization, 'Bearer workbench-A');
        assert.equal(upload.headers['Content-Type'], undefined);
        assert.equal(upload.data.get('file').name, 'portrait.png');
        assert.equal(upload.data.get('groupId'), 'group-1');
        assert.equal(upload.data.get('assetType'), 'Image');
        assert.equal(create.data.assetUrl, 'https://private.example/signed');
        assert.equal(create.data.groupId, 'group-1');
        assert.equal(upload.params.channel_id,6);
        assert.equal(create.params.channel_id,6);
        assert.equal(upload.signal, create.signal);
        assert.ok(upload.timeout > 0 && create.timeout > 0);
        assert.equal(h.button('提交入库').disabled, true);
        const nameInput = document.querySelector('input[aria-label="素材名称"]');
        await React.act(async () => {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(nameInput, '仅修改名称');
            nameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
            nameInput.dispatchEvent(new window.Event('change', { bubbles: true }));
        });
        assert.equal(h.button('提交入库').disabled, true);
        assert.equal(h.calls.length, 2);
        assert.match(document.querySelector('.ant-upload-btn').textContent, /点击选择或拖拽/);
        assert.ok(document.querySelector('video[controls]'));
        assert.ok(document.querySelector('audio[controls]'));
    } finally { await h.cleanup(); }
});

test('pending create locks file selection and dragging cannot submit twice', async () => {
    const pending = deferred();
    const h = await setup({ request: c => c.url.endsWith('/assets') ? pending.promise : undefined });
    try {
        await h.choose();
        await h.click('提交入库');
        assert.equal(document.querySelector('input[type="file"]').disabled, true);
        assert.equal(document.querySelector('input[aria-label="素材名称"]').disabled, true);
        const signal = h.calls[1].signal;
        await h.choose('portrait.png', 'image/png', true);
        assert.equal(signal.aborted, false);
        assert.equal(h.button('提交入库').disabled, true);
        assert.equal(h.calls.length, 2);
        await React.act(async () => pending.resolve(success({ state: 'OK' })));
        assert.equal(h.calls.length, 2);
    } finally { await h.cleanup(); }
});

test('real drag-and-drop upload and failed create retry reuse the successful URL, expiry forces reupload', async () => {
    let fail = true;
    const h = await setup({ request: c => c.url.endsWith('/assets') && fail ? Promise.reject(new Error('移动云暂不可用')) : undefined });
    try {
        await h.choose('dropped.png', 'image/png', true);
        assert.equal(h.button('提交入库').disabled, false);
        await h.click('提交入库');
        assert.match(document.body.textContent, /上传已完成/);
        await h.click('重试提交');
        assert.equal(h.calls.filter(c => c.url.endsWith('/uploads')).length, 1);
        h.uploads[0].expiresAt = Math.floor(Date.now() / 1000) - 1;
        fail = false;
        await h.click('重试提交');
        assert.equal(h.calls.filter(c => c.url.endsWith('/uploads')).length, 2);
        assert.equal(h.calls.filter(c => c.url.endsWith('/assets')).length, 3);
    } finally { await h.cleanup(); }
});

for (const change of ['cancel', 'group', 'type', 'file', 'user']) {
    test(`${change} cancels pending upload and late completion never creates an asset`, async () => {
        const pending = deferred();
        const h = await setup({ request: c => c.url.endsWith('/uploads') ? pending.promise : undefined });
        try {
            await h.choose();
            await h.click('提交入库');
            assert.match(document.querySelector('[role="status"]').textContent, /第 1\/2 步/);
            const signal = h.calls[0].signal;
            if (change === 'cancel') await h.click('取消');
            if (change === 'group') await h.select('选择人物素材组', 'group-2');
            if (change === 'type') await h.select('素材类型', 'Video');
            if (change === 'file') await h.choose('second.png');
            if (change === 'user') { h.setState({ user: { id: 'B' }, token: 'workbench-B' }); await h.render(); }
            assert.equal(signal.aborted, true);
            await React.act(async () => pending.resolve(success({ id: 'upload-old', url: 'https://private.example/old', assetType: 'Image', expiresAt: Math.floor(Date.now() / 1000) + 600 })));
            assert.equal(h.calls.length, 1);
            assert.doesNotMatch(document.body.textContent, /第 2\/2 步：提交移动云入库…/);
        } finally { await h.cleanup(); }
    });
}

test('disabled selection still permits authentication, upload, group management; insert stays blocked', async () => {
    const h = await setup({ selectionEnabled: false });
    try {
        assert.match(document.body.textContent, /先选择支持的 Seedance 模型/);
        assert.equal(h.button('发起真人认证').disabled, false);
        assert.ok([...document.querySelectorAll('button')].filter(el => el.textContent === '选用此素材').every(el => el.disabled));
        await h.choose();
        await h.click('提交入库');
        assert.equal(h.calls.length, 2);
        assert.equal(h.inserted.length, 0);
        await h.click('虚拟人物');
        assert.ok(document.querySelector('input[aria-label="新素材组名称"]'));
        assert.ok(h.button('新建组'));
    } finally { await h.cleanup(); }
});

test('limits reject unsafe formats and oversized files before network; polling is bounded/background disabled', async () => {
    const h = await setup();
    try {
        await h.choose('animation.gif', 'image/gif');
        assert.match(document.querySelector('[role="alert"]').textContent, /文件格式/);
        assert.equal(h.button('重试提交').disabled, true);
        assert.equal(h.calls.length, 0);
        assert.throws(() => h.api.validateAiccFile({ name: 'large.png', type: 'image/png', size: 30 * 1024 * 1024 + 1 }, 'Image'), /文件大小/);
        assert.throws(() => h.api.validateAiccFile({ name: 'fake.png', type: 'text/html', size: 100 }, 'Image'), /文件格式/);
        for (const [kind, name, mime, limit] of [['Image', 'a.webp', 'image/webp', 30], ['Video', 'a.mov', 'video/quicktime', 50], ['Audio', 'a.wav', 'audio/wav', 15]]) {
            assert.doesNotThrow(() => h.api.validateAiccFile({ name, type: mime, size: limit * 1024 * 1024 }, kind));
        }
        const query = h.queryOptions.find(o => o.queryKey.includes('assets'));
        assert.equal(query.refetchIntervalInBackground, false);
        assert.equal(query.refetchOnWindowFocus, false);
        assert.equal(query.refetchInterval({ state: { data: { data: [{ status: 'ACTIVE' }] } } }), false);
        assert.equal(query.refetchInterval({ state: { data: { data: [{ status: 'PROCESSING' }] } } }), 10000);
    } finally { await h.cleanup(); }
});

test('group and asset pagination have explicit spacing and aligned page labels', async () => {
    const h = await setup();
    try {
        for (const label of ['人物素材组分页', '人物素材分页']) {
            const nav = document.querySelector(`nav[aria-label="${label}"]`);
            assert.ok(nav);
            assert.ok(nav.className.includes('items-center'));
            assert.ok(nav.className.includes('justify-between'));
            assert.ok(nav.className.includes('gap-2'));
            assert.equal(nav.querySelectorAll('button').length, 2);
            const pageText = nav.textContent || '';
            assert.match(pageText, /第 1 页/);
        }
    } finally { await h.cleanup(); }
});

test('modal aicc defaultTab opens management with selection flag forwarded; existing asset tabs preserved', async () => {
    const h = await setup();
    try {
        let active;
        let props;
        const modal = load('app/(user)/canvas/components/asset-picker-modal.tsx', {
            ...h.modules,
            antd: { ...h.ui, Modal: ({ children }) => children, Tabs: ({ activeKey, items }) => { active = activeKey; assert.deepEqual(Array.from(items, i => i.key), ['my-assets', 'library', 'aicc']); return items.find(i => i.key === activeKey)?.children; } },
            '@/components/aicc/asset-picker': { AiccAssetPicker: value => { props = value; return React.createElement('div', null, '人物素材管理'); } },
        });
        await React.act(async () => h.root.render(React.createElement(modal.AssetPickerModal, { open: true, allowAicc: true, defaultTab: 'aicc', aiccSelectionEnabled: false, onInsert() {}, onClose() {} })));
        assert.equal(active, 'aicc');
        assert.equal(props.selectionEnabled, false);
        assert.match(document.body.textContent, /人物素材管理/);
    } finally { await h.cleanup(); }
});

test('actual direct-entry callbacks set aicc tab/open and toolbar button invokes its callback', async () => {
    const h = await setup();
    try {
        const videoSource = fs.readFileSync(path.join(base, 'app/(user)/video/page.tsx'), 'utf8');
        const canvasSource = fs.readFileSync(path.join(base, 'app/(user)/canvas/[id]/canvas-client-page.tsx'), 'utf8');
        const match = videoSource.match(/const openAssetPicker = ([\s\S]*?\n    });/);
        assert.ok(match);
        let tab, open, target;
        const source = ts.transpileModule(`const openAssetPicker = ${match[1]}; openAssetPicker('general', 'aicc');`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
        vm.runInNewContext(source, { setAssetPickerTab: x => tab = x, setAssetPickerOpen: x => open = x, setAssetPickerTarget: x => target = x });
        assert.equal(tab, 'aicc'); assert.equal(open, true); assert.equal(target, 'general');
        assert.match(videoSource, /openAssetPicker\("general", "aicc"\)/);
        assert.match(videoSource, /onOpenAssetPicker\("general", "aicc"\)/);
        assert.match(videoSource, /allowAicc aiccSelectionEnabled=\{aiccSelectionEnabled\} open=\{assetPickerOpen\} defaultTab=\{assetPickerTab\}/);
        const callback = canvasSource.match(/onOpenAiccAssets=\{(\(\) => \{[\s\S]*?\n                    \})\}/);
        assert.ok(callback);
        open = false; tab = '';
        const ref = { current: { x: 1 } };
        const onOpen = vm.runInNewContext(`(${callback[1]})`, { assetInsertPositionRef: ref, setAssetPickerTab: x => tab = x, setAssetPickerOpen: x => open = x });
        const icons = new Proxy({}, { get: () => () => null });
        const toolbar = load('app/(user)/canvas/components/canvas-toolbar.tsx', {
            ...h.modules, 'lucide-react': icons,
            '@/lib/canvas-theme': { canvasThemes: { light: { toolbar: {} } } },
            '@/stores/use-theme-store': { useThemeStore: select => select({ theme: 'light', setTheme() {} }) },
        });
        await React.act(async () => h.root.render(React.createElement(toolbar.CanvasToolbar, { canvasTool: 'select', onOpenAiccAssets: onOpen })));
        await h.click('人物素材与认证');
        assert.equal(tab, 'aicc'); assert.equal(open, true); assert.equal(ref.current, null);
    } finally { await h.cleanup(); }
});
