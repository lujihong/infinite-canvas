const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const React=require('react');
const {createRoot}=require('react-dom/client');
const {createRequire}=require('node:module');
const relayRequire=createRequire(process.env.XYB_RELAY_PACKAGE||path.resolve(__dirname,'../package.json'));
const {JSDOM}=relayRequire('jsdom');
const base=path.resolve(__dirname,'../src/app/(user)/canvas');
const raw=JSON.stringify({error:{code:'InputImageSensitiveContentDetected.PrivacyInformation',message:'Input image contains a real person. '+ 'long-diagnostic-'.repeat(250)}},null,2);
const helperScope={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(base,'utils/canvas-error.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,helperScope);
const {describeCanvasError}=helperScope.exports;
test('classifies privacy without inventing the actor identity or hiding ordinary errors',()=>{
 assert.equal(describeCanvasError(raw).title,'参考素材未通过人物隐私审核');
 assert.match(describeCanvasError(raw).guidance,/虚拟人物/);
 assert.equal(describeCanvasError('{"error":{"code":"InputImageSensitiveContentDetected.Other","message":"blocked"}}').title,'参考素材未通过内容审核');
 assert.equal(describeCanvasError('quota insufficient').summary,'quota insufficient');
 assert.equal(describeCanvasError('').title,'生成未完成');
 assert.equal(describeCanvasError('{broken-json').message,'{broken-json');
});
test('failure card keeps bounded regions, exposes complete detail and copies original error',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://workbench.example',pretendToBeVisual:true});
 const saved=new Map();
 for(const key of ['window','document','navigator','HTMLElement','SVGElement','Element','Node','ShadowRoot','getComputedStyle','MutationObserver','IS_REACT_ACT_ENVIRONMENT','ResizeObserver']){
  saved.set(key,Object.getOwnPropertyDescriptor(global,key));
  Object.defineProperty(global,key,{configurable:true,writable:true,value:key==='IS_REACT_ACT_ENVIRONMENT'?true:key==='ResizeObserver'?class{observe(){}unobserve(){}disconnect(){}}:dom.window[key]});
 }
 dom.window.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 const source=fs.readFileSync(path.join(base,'components/canvas-node.tsx'),'utf8');
 const ast=ts.createSourceFile('node.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='ErrorContent');assert.ok(fn);
 let copied='',retries=0,repairs=0;
 const Icon=()=>React.createElement('span');
 const scope={exports:{},require,describeCanvasError,useState:React.useState,useEffect:React.useEffect,Modal:require('antd').Modal,useCopyText:()=>text=>{copied=text;},FolderPlus:Icon,RefreshCw:Icon};
 const compiled=ts.transpileModule(fn.getText(ast)+'\nexport {ErrorContent};',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(compiled,scope);
 const root=createRoot(document.getElementById('root'));
 const theme={node:{text:'#f5f5f5',muted:'#c0c0c0',fill:'#222222'},toolbar:{panel:'#292929',border:'#777777'}};
 const click=async(text)=>{const b=[...document.querySelectorAll('button')].find(n=>n.textContent===text);assert.ok(b,text);await React.act(async()=>{b.click();await new Promise(r=>setTimeout(r,30));});};
 try{
  const props={node:{id:'failed',width:220,height:160,metadata:{errorDetails:raw}},theme,onRetry:()=>{retries++;},onReplaceAicc:()=>{repairs++;}};
  await React.act(async()=>root.render(React.createElement(scope.exports.ErrorContent,props)));
  const card=document.querySelector('[data-canvas-error]');assert.ok(card.classList.contains('h-full'));assert.ok(card.classList.contains('overflow-hidden'));
  assert.ok(document.querySelector('[data-canvas-error-body]').classList.contains('min-h-0'));
  assert.ok(document.querySelector('[data-canvas-error-body]').classList.contains('overflow-y-auto'));
  assert.ok(document.querySelector('[data-canvas-error-actions]').classList.contains('flex-wrap'));
  assert.ok(!card.textContent.includes('long-diagnostic-'));
  const canvasSource=fs.readFileSync(path.join(base,'components/infinite-canvas.tsx'),'utf8');
  const canvasAst=ts.createSourceFile('canvas.tsx',canvasSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let listener;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(canvasAst)==='preventWheelScroll')listener=n.initializer.getText(canvasAst);ts.forEachChild(n,visit);}visit(canvasAst);assert.ok(listener);
  const native=vm.runInNewContext(ts.transpileModule('('+listener+')',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,{Element});
  const host=document.getElementById('root');host.addEventListener('wheel',native,{passive:false});
  const wheel=new dom.window.WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:50});
  document.querySelector('[data-canvas-error-body]').dispatchEvent(wheel);assert.equal(wheel.defaultPrevented,false,'canvas must not cancel native text scrolling');
  host.removeEventListener('wheel',native);
  await click('检查参考');assert.equal(repairs,1);assert.equal(retries,0);
  await click('错误详情');assert.equal(document.querySelector('pre').textContent,raw);
  await click('复制完整错误');assert.equal(copied,raw);assert.equal(retries,0);
  await click('关闭');await click('重试');assert.equal(retries,1);
  await React.act(async()=>root.render(React.createElement(scope.exports.ErrorContent,{...props,node:{...props.node,id:'plain',metadata:{errorDetails:'X'.repeat(5000)}}})));
  assert.ok(document.querySelector('[data-canvas-error-body]').textContent.includes('X'.repeat(5000)));
  assert.ok(![...document.querySelectorAll('button')].some(n=>n.textContent==='检查参考'));
 }finally{
  await React.act(async()=>root.unmount());dom.window.close();
  for(const [key,d] of saved){if(d)Object.defineProperty(global,key,d);else delete global[key];}
 }
});
