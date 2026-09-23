const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadHelper() {
  const source = fs.readFileSync(path.join(__dirname, '../src/lib/video-audio-preference.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const context = {
    exports,
    require: id => id === '@/lib/session-identity'
          ? { captureSessionIdentity: () => ({ userId: 'test-user', token: 'test-token', epoch: 1 }) }
          : { modelKey: model => model.trim().toLowerCase().replace(/[._/]+/g, '-') },
    localStorage: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, value),
    },
  };
  vm.runInNewContext(compiled, context, { filename: 'video-audio-preference.ts' });
  return exports;
}

test('target cloud Seedance models default audio on while other models preserve configured false', () => {
  const { resolveVideoAudioPreference } = loadHelper();
  assert.equal(resolveVideoAudioPreference('moma-seedance-2.0', 'false'), true);
  assert.equal(resolveVideoAudioPreference('nm-moma-seedance-2.0', 'false'), true);
  assert.equal(resolveVideoAudioPreference('doubao-seedance-2.0', 'false'), false);
  assert.equal(resolveVideoAudioPreference('moma-seedance-2.0', 'false'), true);
});

test('explicit per-model false and true survive legacy global config values', () => {
  const { resolveVideoAudioPreference } = loadHelper();
  assert.equal(resolveVideoAudioPreference('moma-seedance-2.0', 'true', {}, false), false);
  assert.equal(resolveVideoAudioPreference('moma-seedance-2.0', 'false', {}, true), true);
  assert.equal(resolveVideoAudioPreference('sora-2', 'true', {}, false), false);
});
