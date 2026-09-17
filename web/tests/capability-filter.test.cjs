const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function loadModule(filePath) {
    const source = fs.readFileSync(filePath, 'utf8');
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            jsx: ts.JsxEmit.ReactJSX,
            esModuleInterop: true,
        },
    });
    const scope = {
        exports: {},
        require: (id) => {
            if (id === '@/lib/audio-generation' || id === './audio-generation') {
                return {
                    RECOMMENDED_AUDIO_MODELS: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd', 'glm-tts'],
                };
            }
            if (id === 'zustand' || id.startsWith('zustand')) {
                const fn = () => ({});
                return { create: () => fn, persist: (x) => x, createJSONStorage: () => ({}) };
            }
            return {};
        },
    };
    vm.runInNewContext(compiled.outputText, scope);
    return scope.exports;
}

test('audio-generation exports valid recommended audio models', () => {
    const audioModule = loadModule(path.resolve(__dirname, '../src/lib/audio-generation.ts'));
    assert.ok(Array.isArray(audioModule.RECOMMENDED_AUDIO_MODELS));
    assert.ok(audioModule.RECOMMENDED_AUDIO_MODELS.includes('gpt-4o-mini-tts'));
    assert.ok(audioModule.RECOMMENDED_AUDIO_MODELS.includes('tts-1'));
    assert.ok(audioModule.RECOMMENDED_AUDIO_MODELS.includes('glm-tts'));
});

test('model capability filtering strictly isolates audio, video, and text', () => {
    const storeModule = loadModule(path.resolve(__dirname, '../src/stores/use-config-store.ts'));
    const filter = storeModule.filterModelsByCapability;

    const sampleModels = [
        'MiniMax-H3',
        'claude-opus-4-8',
        'claude-opus-5',
        'doubao-seedance-2.0',
        'gpt-image-2-1k',
        'gpt-5.6-sol',
        'gpt-4o-mini-tts',
    ];

    // Audio capability filter
    const audio = filter(sampleModels, 'audio');
    assert.deepEqual(audio, ['gpt-4o-mini-tts']);
    assert.ok(!audio.includes('MiniMax-H3'), 'MiniMax-H3 must never match audio capability');
    assert.ok(!audio.includes('claude-opus-4-8'), 'claude-opus must never match audio capability');

    // Video capability filter
    const video = filter(sampleModels, 'video');
    assert.ok(video.includes('MiniMax-H3'));
    assert.ok(video.includes('doubao-seedance-2.0'));
    assert.ok(!video.includes('claude-opus-4-8'));
    assert.ok(!video.includes('gpt-4o-mini-tts'));

    // Text capability filter
    const text = filter(sampleModels, 'text');
    assert.ok(text.includes('claude-opus-4-8'));
    assert.ok(text.includes('claude-opus-5'));
    assert.ok(text.includes('gpt-5.6-sol'));
    assert.ok(!text.includes('MiniMax-H3'));
    assert.ok(!text.includes('gpt-4o-mini-tts'));
    assert.ok(!text.includes('gpt-image-2-1k'));

    // Image capability filter
    const image = filter(sampleModels, 'image');
    assert.deepEqual(image, ['gpt-image-2-1k']);
});
