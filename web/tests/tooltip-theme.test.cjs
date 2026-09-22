const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
function load(file, modules) {
    const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
    const scope = { exports: {}, require: name => modules[name] ?? require(name) };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, scope);
    return scope.exports;
}
function luminance(hex) {
    const rgb = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
test('tooltip contrast stays above 7:1 in both themes without changing primary button text', () => {
    const { getAntThemeConfig } = load('lib/app-theme.ts', { antd: { theme: { darkAlgorithm: 'dark', defaultAlgorithm: 'light' } } });
    for (const dark of [false, true]) {
        const config = getAntThemeConfig(dark), tooltip = config.components.Tooltip;
        const values = [luminance(tooltip.colorTextLightSolid), luminance(tooltip.colorBgSpotlight)].sort((a, b) => b - a);
        assert.ok((values[0] + 0.05) / (values[1] + 0.05) >= 7);
        assert.equal(config.token.colorTextLightSolid, dark ? '#171717' : '#ffffff');
    }
});
test('credit tooltip renders one detail with line breaks and bounded overflow, without native title', () => {
    const detail = '需实际用量\n待确定：usage.input_tokens';
    const Tooltip = () => null;
    const { EstimatedCredits } = load('components/estimated-credits.tsx', { antd: { Tooltip }, '@/services/api/request-quote': { useRequestQuote: () => ({ label: '按实际用量结算积分', detail, quote: { missing_fields: ['usage.input_tokens'] } }) } });
    const node = EstimatedCredits({ config: {}, descriptor: null });
    assert.equal(node.type, Tooltip);
    assert.equal(node.props.title.props.children, detail);
    assert.match(node.props.title.props.className, /whitespace-pre-line/);
    assert.equal(node.props.children.props.title, undefined);
    assert.equal(node.props.styles.container.overflowY, 'auto');
    assert.match(node.props.styles.root.maxWidth, /100vw/);
});
