const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('canvas-node-hover-toolbar action button does not trigger onClick when menuContent is present', () => {
    const toolbarSource = fs.readFileSync(path.resolve(__dirname, '../src/app/(user)/canvas/components/canvas-node-hover-toolbar.tsx'), 'utf8');
    
    // 验证核心防线：当有 menuContent 时，button 的 onClick 必须为 undefined，严禁调用外部上传回调
    assert.ok(
        toolbarSource.includes('onClick={menuContent ? undefined : onClick}'),
        'button onClick must be undefined when menuContent is provided to prevent firing upload file input dialog'
    );
    
    // 验证包含 Popover 受控与自关闭容器
    assert.ok(
        toolbarSource.includes('open={popoverOpen}'),
        'Popover must be state controlled'
    );
    assert.ok(
        toolbarSource.includes('setPopoverOpen(false)'),
        'menu click must auto-dismiss the Popover'
    );
    
    // 验证三路来源完整性：AICC 真人素材库、我的素材库、本地上传
    assert.ok(toolbarSource.includes('从真人素材库选择 (AICC)'), 'Must offer AICC image selection');
    assert.ok(toolbarSource.includes('从真人视频库选择 (AICC)'), 'Must offer AICC video selection');
    assert.ok(toolbarSource.includes('从我的素材库选择'), 'Must offer My Assets selection');
    assert.ok(toolbarSource.includes('从本地文件上传'), 'Must offer Local File upload option');
});

test('canvas-node-reference-bar plus button provides AICC and My Assets options without auto-connecting', () => {
    const refBarSource = fs.readFileSync(path.resolve(__dirname, '../src/app/(user)/canvas/components/canvas-node-reference-bar.tsx'), 'utf8');
    
    // 验证参考内容加号提供了 Popover 菜单
    assert.ok(refBarSource.includes('从真人素材库选用 (AICC)'), 'Reference bar must offer AICC option');
    assert.ok(refBarSource.includes('从我的素材库选用'), 'Reference bar must offer My Assets option');
    assert.ok(refBarSource.includes('从画布节点选择连线'), 'Reference bar must offer canvas node connection option');
});
