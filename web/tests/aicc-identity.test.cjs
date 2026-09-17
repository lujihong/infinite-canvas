const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const React=require('react');
const {createRoot}=require('react-dom/client');
// Resolve jsdom from an existing test dependency; no installation or project mutation.
const {createRequire}=require('node:module');
const relayRequire=createRequire(process.env.XYB_RELAY_PACKAGE || path.resolve(__dirname,'../package.json'));
const {JSDOM}=relayRequire('jsdom');

test('switching users remounts real AICC component and releases pending authentication state',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://workbench.example'});
 const previous={window:global.window,document:global.document,IS_REACT_ACT_ENVIRONMENT:global.IS_REACT_ACT_ENVIRONMENT};
 global.window=dom.window;global.document=dom.window.document;global.IS_REACT_ACT_ENVIRONMENT=true;
 let identity='A';let settle;let signal;
 const tags={Alert:'div',Empty:'div',Input:'input',QRCode:'div',Select:'select',Spin:'div',Tag:'span'};
 const ui=Object.fromEntries(Object.entries(tags).map(([key,tag])=>[key,({children})=>React.createElement(tag,null,children)]));
 ui.Button=({children,loading,onClick,disabled})=>React.createElement('button',{onClick,disabled,'data-loading':String(!!loading)},children);
 ui.App={useApp:()=>({message:{success(){},info(){},error(){}}})};
 const modules={react:React,'react/jsx-runtime':require('react/jsx-runtime'),antd:ui,'@tanstack/react-query':{useQuery:()=>({data:{data:[]},refetch:async()=>{},isLoading:false,isFetching:false})},'@/stores/use-user-store':{useUserStore:select=>select({user:{id:identity}})},'@/services/api/aicc':{aiccSession:s=>{signal=s;return new Promise(resolve=>{settle=resolve});}}};
 const source=fs.readFileSync(path.join(__dirname,'../src/components/aicc/asset-picker.tsx'),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const scope={exports:{},require:id=>modules[id]||{},AbortController,Date,setInterval,clearInterval};
 vm.runInNewContext(compiled,scope);
 const Component=scope.exports.AiccAssetPicker;
 const root=createRoot(document.getElementById('root'));
 const button=()=>[...document.querySelectorAll('button')].find(el=>el.textContent==='发起真人认证');
 try {
  await React.act(async()=>root.render(React.createElement(Component,{onInsert(){}})));
  await React.act(async()=>button().click());
  assert.equal(button().dataset.loading,'true');
  identity='B';
  await React.act(async()=>root.render(React.createElement(Component,{onInsert(){}})));
  assert.equal(signal.aborted,true);
  assert.equal(button().dataset.loading,'false');
  await React.act(async()=>settle({bytedToken:'A-token',h5Link:'https://auth.example',expiresIn:120}));
  assert.equal(button().dataset.loading,'false');
  assert.equal(document.body.textContent.includes('链接剩余'),false);
 } finally {
  await React.act(async()=>root.unmount());dom.window.close();Object.assign(global,previous);
 }
});
