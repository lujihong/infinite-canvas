const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules = {}, globals = {}) {
    const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const scope = { exports: {}, AbortController, URLSearchParams, Uint8Array, Error, ...globals,
        require(id) { if (!(id in modules)) throw new Error(`Unexpected dependency: ${id}`); return modules[id]; } };
    vm.runInNewContext(code, scope);
    return scope.exports;
}
function setup() {
    const session = load('lib/session-identity.ts');
    const utils = load('components/wallet/consumption-log-utils.ts', { '@/lib/session-identity': session });
    session.initializeSessionIdentity('token-a', 'user-a');
    return { session, ...utils };
}
const requestId = '18d80285-9065-4150-ae28-5f4d4c45e589';
const seconds = value => Date.parse(value) / 1000;
const plain = value => JSON.parse(JSON.stringify(value));

for (const timezone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Auckland']) {
    test(`Beijing half-open day and Monday week are independent of timezone: ${timezone}`, () => {
        const old = process.env.TZ;
        process.env.TZ = timezone;
        try {
            const { consumptionLogBounds, formatConsumptionTime } = setup();
            // Sunday in Beijing, including DST transition in Los Angeles.
            const now = Date.parse('2026-03-08T10:30:00Z');
            assert.deepEqual(plain(consumptionLogBounds('day', '', '', now)), {
                startTimestamp: seconds('2026-03-07T16:00:00Z'), endTimestamp: seconds('2026-03-08T16:00:00Z'),
            });
            assert.deepEqual(plain(consumptionLogBounds('week', '', '', now)), {
                startTimestamp: seconds('2026-03-01T16:00:00Z'), endTimestamp: seconds('2026-03-08T16:00:00Z'),
            });
            assert.equal(formatConsumptionTime(seconds('2026-03-08T16:00:00Z')), '2026-03-09 00:00:00');
        } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
    });
}

test('Monday, leap month, December and year rollover boundaries', () => {
    const { consumptionLogBounds } = setup();
    for (const [period, now, from, to] of [
        ['week', '2026-03-08T16:00:00Z', '2026-03-08T16:00:00Z', '2026-03-15T16:00:00Z'],
        ['month', '2024-02-29T00:00:00Z', '2024-01-31T16:00:00Z', '2024-02-29T16:00:00Z'],
        ['month', '2026-12-31T15:59:59Z', '2026-11-30T16:00:00Z', '2026-12-31T16:00:00Z'],
        ['year', '2026-12-31T16:00:00Z', '2026-12-31T16:00:00Z', '2027-12-31T16:00:00Z'],
    ]) {
        assert.deepEqual(plain(consumptionLogBounds(period, '', '', Date.parse(now))), {
            startTimestamp: seconds(from), endTimestamp: seconds(to),
        });
    }
});

test('custom inputs strictly reject invalid/reversed/offset dates instead of falling back to all', () => {
    const { consumptionLogBounds } = setup();
    for (const [from, to] of [
        ['', ''], ['2026-02-30T00:00', '2026-03-02T00:00'],
        ['2026-01-01T24:00', '2026-01-03T00:00'], ['2026-01-01T00:60', '2026-01-03T00:00'],
        ['2026-01-01T00:00Z', '2026-01-03T00:00'], ['2026-01-01T00:00+08:00', '2026-01-03T00:00'],
        ['2026-01-02T00:00', '2026-01-01T00:00'], ['2026-01-01T00:00', '2026-01-01T00:00'],
    ]) assert.equal(consumptionLogBounds('custom', from, to), null);
    assert.deepEqual(plain(consumptionLogBounds('all')), {});
    assert.deepEqual(plain(consumptionLogBounds('custom', '1970-01-01T08:00:00', '1970-01-01T08:00:01')), { startTimestamp: 0, endTimestamp: 1 });
});

test('same custom boundaries drive list and export: submit fallback, start inclusive, end exclusive', () => {
    const { consumptionLogBounds, filterConsumptionLogs } = setup();
    const range = consumptionLogBounds('custom', '2026-03-01T00:00', '2026-03-02T00:00');
    const start = range.startTimestamp, end = range.endTimestamp;
    const logs = [
        { id: 1, created_at: start - 1 }, { id: 2, created_at: start },
        { id: 3, created_at: end - 1 }, { id: 4, created_at: end },
        { id: 5, created_at: start, submit_time: end }, { id: 6, created_at: end, submit_time: start },
    ];
    assert.deepEqual(plain(filterConsumptionLogs(logs, range).map(x => x.id)), [2, 3, 6]);
    assert.deepEqual(plain(filterConsumptionLogs(logs, null)), []);
});

test('category/status/keyword match only existing visible list fields, not arbitrary raw other', () => {
    const { filterConsumptionLogs } = setup();
    const logs = [
        { id: 1, model_name: 'seedance-image-video', status: 'failed', type: 5, task_id: 'TASK-01', task_action: '图生视频' },
        { id: 2, model_name: 'flux', status: 'success', type: 2, request_id: 'REQ-2' },
        { id: 3, model_name: 'suno', status: 'refunded', type: 6 },
        { id: 4, model_name: 'gpt', type: 5, other: 'private-match', error_detail: 'private-match' },
        { id: 5, model_name: 'voice', type: 6 },
    ];
    for (const [range, ids] of [
        [{ category: 'video', status: 'failed', keyword: '  task-01  ' }, [1]],
        [{ category: 'image', status: 'success', keyword: ' req-2 ' }, [2]],
        [{ category: 'audio', status: 'refunded' }, [3, 5]],
        [{ category: 'text', status: 'failed' }, [4]],
        [{ keyword: 'private-match' }, []],
    ]) assert.deepEqual(plain(filterConsumptionLogs(logs, range).map(x => x.id)), ids);
});

function api(fetch, request = {}) {
    return load('services/api/auth.ts', { '@/services/api/request': request }, { fetch });
}
const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// A minimal signature-bearing fixture for transport validation; not a full workbook parser.
const zipBytes = new Uint8Array(32); zipBytes.set([0x50, 0x4b, 0x03, 0x04]);

test('export sends all filters without offset or raw fields; zero timestamp survives; signal forwarded', async () => {
    const controller = new AbortController();
    let count = 0;
    const service = api(async (url, options) => {
        count++;
        const parsed = new URL(url, 'https://example.test');
        assert.equal(parsed.pathname, '/api/v1/user/logs/export');
        assert.deepEqual(Object.fromEntries(parsed.searchParams), { start_timestamp: '0', end_timestamp: '100', category: 'video', status: 'failed', keyword: '任务 & REQ' });
        assert.equal(options.signal, controller.signal);
        assert.equal(options.headers.Authorization, 'Bearer token-a');
        return new Response(zipBytes, { headers: { 'content-type': mime } });
    });
    const blob = await service.fetchUserConsumptionLogsExport('token-a', {
        startTimestamp: 0, endTimestamp: 100, category: 'video', status: 'failed', keyword: ' 任务 & REQ ', other: 'secret', offset: 100,
    }, controller.signal);
    assert.equal(blob.size, zipBytes.length);
    assert.equal(count, 1);
});

test('old optional range callers stay valid and list receives compatible filters', async () => {
    const service = api(async url => {
        assert.equal(new URL(url, 'https://example.test').search, '');
        return new Response(zipBytes, { headers: { 'content-type': mime } });
    }, { apiGet: async (url, range, token) => ({ url, range, token }) });
    await service.fetchUserConsumptionLogsExport('token-a');
    const old = await service.fetchUserConsumptionLogs('token-a');
    assert.equal(old.range, undefined);
    const result = await service.fetchUserConsumptionLogs('token-a', { category: 'audio', status: 'refunded', keyword: ' r ' });
    assert.deepEqual(plain(result.range), { category: 'audio', status: 'refunded', keyword: 'r' });
});

test('HTTP and HTTP-200 JSON business errors surface safe message fields, not raw payloads', async () => {
    for (const status of [200, 400, 401, 429, 500]) {
        for (const payload of [{ success: false, message: '请缩小时间范围' }, { error: { message: '导出繁忙' } }, { msg: '权限不足' }]) {
            const service = api(async () => new Response(JSON.stringify({ ...payload, other: 'private-secret' }), {
                status, headers: { 'content-type': 'application/json' },
            }));
            await assert.rejects(service.fetchUserConsumptionLogsExport('a'), error => {
                assert.match(error.message, /请缩小时间范围|导出繁忙|权限不足/);
                assert.doesNotMatch(error.message, /private-secret/);
                return true;
            });
        }
    }
});

test('malformed JSON, HTML, raw other, empty and invalid XLSX never resolve successfully', async () => {
    for (const [content, type] of [['{oops', 'application/json'], ['<html>login</html>', 'text/html'],
        [JSON.stringify({ other: 'private-secret' }), 'application/json'], ['', mime], ['not-a-workbook', mime]]) {
        const service = api(async () => new Response(content, { headers: { 'content-type': type } }));
        await assert.rejects(service.fetchUserConsumptionLogsExport('a'), error => {
            assert.doesNotMatch(error.message, /private-secret/);
            assert.match(error.message, /Excel/);
            return true;
        });
    }
});

test('blob read failure and cancellation after response or blob read propagate, not success', async () => {
    const service = api(async () => ({ ok: true, headers: new Headers({ 'content-type': mime }), blob: async () => { throw new Error('读取响应失败'); } }));
    await assert.rejects(service.fetchUserConsumptionLogsExport('a'), /读取响应失败/);
    for (const phase of ['response', 'blob']) {
        const controller = new AbortController();
        const service = api(async () => {
            if (phase === 'response') controller.abort();
            return { ok: true, headers: new Headers({ 'content-type': mime }), blob: async () => {
                controller.abort(); return new Blob([zipBytes]);
            } };
        });
        await assert.rejects(service.fetchUserConsumptionLogsExport('a', undefined, controller.signal), { name: 'AbortError' });
    }
});

test('duplicate clicks are blocked synchronously and close cancels immediately', () => {
    const { createConsumptionExportGuard } = setup();
    const guard = createConsumptionExportGuard();
    const first = guard.start('token-a', 'user-a');
    assert.ok(first.isCurrent());
    assert.equal(guard.start('token-a', 'user-a'), null);
    guard.cancel();
    assert.equal(first.controller.signal.aborted, true);
    assert.equal(first.isCurrent(), false);
    const second = guard.start('token-a', 'user-a');
    assert.ok(second.isCurrent());
    assert.equal(guard.finish(first), false); // old finally cannot clear the new request's loading state
    assert.ok(second.isCurrent());
    assert.equal(guard.finish(second), true);
});

test('A -> B -> A epoch prevents stale Blob download even with identical token and ID', async () => {
    const { session, createConsumptionExportGuard } = setup();
    const guard = createConsumptionExportGuard();
    const epoch = session.captureSessionIdentity().epoch;
    const unsubscribe = session.subscribeSessionIdentity(() => {
        if (session.captureSessionIdentity().epoch !== epoch) guard.cancel();
    });
    let resolve;
    const blob = new Promise(done => { resolve = done; });
    const ticket = guard.start('token-a', 'user-a');
    let downloads = 0;
    const result = blob.then(() => { if (ticket.isCurrent()) downloads++; });
    session.beginSessionTransition('token-b', 'user-b');
    assert.equal(ticket.controller.signal.aborted, true);
    session.initializeSessionIdentity('token-a', 'user-a');
    resolve(new Blob([zipBytes]));
    await result;
    assert.equal(downloads, 0);
    unsubscribe();
});

test('guard does not start for wrong identity or in-progress session transition', () => {
    const { session, createConsumptionExportGuard } = setup();
    const guard = createConsumptionExportGuard();
    assert.equal(guard.start('token-b', 'user-b'), null);
    assert.equal(guard.start('', ''), null);
    const identity = session.beginSessionTransition('token-a', 'user-a');
    assert.equal(guard.start('token-a', 'user-a'), null);
    session.finishSessionTransition(identity);
    assert.ok(guard.start('token-a', 'user-a').isCurrent());
});

test('native prepare forwards filters and signal, validates code/data, returns only safe download metadata', async () => {
    const controller = new AbortController();
    const service = api(async (url, options) => {
        const parsed = new URL(url, 'https://example.test');
        assert.equal(parsed.pathname, '/api/v1/user/logs/export/prepare');
        assert.deepEqual(Object.fromEntries(parsed.searchParams), { start_timestamp: '0', end_timestamp: '99', category: 'text', status: 'success', keyword: '模型', export_request_id: requestId });
        assert.equal(options.method, 'POST');
        assert.equal(options.signal, controller.signal);
        assert.equal(options.credentials, 'same-origin');
        assert.equal(options.headers.Authorization, 'Bearer a');
        return Response.json({ code: 0, data: { download_url: '/api/v1/user/logs/export/download/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', file_name: '消费明细.xlsx', row_count: 100000, other: 'secret' } });
    });
    const result = await service.prepareUserConsumptionLogsExport('a', { startTimestamp: 0, endTimestamp: 99, category: 'text', status: 'success', keyword: ' 模型 ' }, controller.signal, requestId);
    assert.deepEqual(plain(result), { download_url: '/api/v1/user/logs/export/download/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', file_name: '消费明细.xlsx', row_count: 100000 });
});

test('native prepare rejects malformed envelopes, arbitrary URLs and unsafe filenames without blob fallback', async () => {
    for (const data of [undefined, {},
        { download_url: 'https://evil.test/export', file_name: 'a.xlsx' },
        { download_url: '//evil.test/export', file_name: 'a.xlsx' },
        { download_url: '/api/v1/user/logs/export/download/../../auth', file_name: 'a.xlsx' },
        { download_url: '/api/v1/user/logs/export/download/%2e%2e/auth', file_name: 'a.xlsx' },
        { download_url: '/api/v1/user/logs/export/download/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', file_name: '../a.xlsx' },
        { download_url: '/api/v1/user/logs/export/download/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', file_name: 'a.html' },
    ]) {
        let calls = 0;
        const service = api(async () => { calls++; return Response.json({ code: 0, data }); });
        await assert.rejects(service.prepareUserConsumptionLogsExport('a', undefined, undefined, requestId), /无效/);
        assert.equal(calls, 1);
    }
    const invalidJSON = api(async () => new Response('{broken'));
    await assert.rejects(invalidJSON.prepareUserConsumptionLogsExport('a', undefined, undefined, requestId), /无效的 JSON/);
    const businessError = api(async () => Response.json({ code: 4, msg: '时间范围过大', other: 'secret' }));
    await assert.rejects(businessError.prepareUserConsumptionLogsExport('a', undefined, undefined, requestId), /时间范围过大/);
});

test('native prepare cannot deliver a late result after abort while reading JSON', async () => {
    let resolve;
    const pending = new Promise(done => { resolve = done; });
    const controller = new AbortController();
    const service = api(async () => ({ ok: true, status: 200, json: () => pending }));
    const result = service.prepareUserConsumptionLogsExport('a', undefined, controller.signal, requestId);
    await Promise.resolve();
    controller.abort();
    resolve({ code: 0, data: { download_url: '/api/v1/user/logs/export/download/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', file_name: 'a.xlsx' } });
    await assert.rejects(result, { name: 'AbortError' });
});

test('cancel cleanup is fire-and-forget with original token, only once per active ticket', async () => {
    const { session, createConsumptionExportGuard } = setup();
    const calls = [];
    const service = api(async (url, options) => { calls.push({ url, options }); throw new Error('offline'); });
    const guard = createConsumptionExportGuard();
    const ticket = guard.start('token-a', 'user-a', () => { void service.cancelUserConsumptionLogsExport('token-a', requestId); });
    session.initializeSessionIdentity('token-b', 'user-b');
    guard.cancel(); guard.cancel();
    assert.equal(ticket.controller.signal.aborted, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `/api/v1/user/logs/export/pending?export_request_id=${requestId}`);
    assert.equal(calls[0].options.method, 'DELETE');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer token-a');
    assert.equal(calls[0].options.keepalive, true);
    await Promise.resolve();
});

test('drawer wiring shares exact filter snapshot and includes close/unmount cancellation', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/components/wallet/consumption-logs-drawer.tsx'), 'utf8');
    assert.match(source, /filterConsumptionLogs\(logs, currentFilter\)/);
    assert.match(source, /prepareUserConsumptionLogsExport\(token, currentFilter, ticket\.controller\.signal, exportRequestId\)/);
    assert.match(source, /const exportRequestId = crypto\.randomUUID\(\)/);
    assert.doesNotMatch(source, /fetchUserConsumptionLogsExport|createObjectURL|\.blob\(/);
    assert.match(source, /link\.href = prepared\.download_url/);
    assert.match(source, /crypto\.randomUUID/);
    assert.match(source, /cancelUserConsumptionLogsExport\(token, exportRequestId\)/);
    assert.match(source, /onClose=\{handleClose\}/);
    assert.match(source, /return \(\) => \{\s*unsubscribe\(\);\s*cancelPending\(\);/);
    assert.match(source, /if \(!ticket\.isCurrent\(\) \|\| !isCurrentUser\(\)\) return;\s*link\.click\(\)/);
    assert.doesNotMatch(source, /getExportBounds|startOf\("week"\)|endOf\(|累计历史调用扣费|Excel 已下载/);
});
