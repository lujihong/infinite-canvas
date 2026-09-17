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

test('pricing hook loads on mount and updates consumer without opening a picker', async () => {
 const dom = new JSDOM('<div id="root"></div>');
 const previous = { window:global.window, document:global.document, IS_REACT_ACT_ENVIRONMENT:global.IS_REACT_ACT_ENVIRONMENT };
 global.window=dom.window; global.document=dom.window.document; global.IS_REACT_ACT_ENVIRONMENT=true;
 const users=create(()=>({token:'test-token',user:{id:'one'}}));
 const requests=[];
 const source=fs.readFileSync(path.join(__dirname,'../src/services/api/pricing.ts'),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const modules={react:React,zustand:{create},axios:{request:options=>new Promise(resolve=>requests.push({options,resolve}))},'@/stores/use-user-store':{useUserStore:users}};
 const scope={exports:{},require:id=>modules[id],AbortController,Date,Map,window:dom.window};
 vm.runInNewContext(code,scope);
 const api=scope.exports;
 function Consumer(){api.usePersonalPricing();return React.createElement('span',null,api.getModelPricing('m')?.formatted_points_cost || 'waiting');}
 const root=createRoot(document.getElementById('root'));
 try {
  await React.act(async()=>root.render(React.createElement(Consumer)));
  assert.equal(requests.length,1);
  await React.act(async()=>requests[0].resolve({status:200,data:{code:0,data:[{model_name:'m',estimated:true,group_quotes:[],formatted_points_cost:'按实际用量结算'}]}}));
  assert.equal(document.body.textContent,'按实际用量结算');
  await React.act(async()=>users.setState({token:'two-token',user:{id:'two'}}));
  assert.equal(document.body.textContent,'waiting');
  assert.equal(requests.length,2);
  for(const file of ['app/(user)/video/page.tsx','app/(user)/canvas/components/canvas-config-node-panel.tsx','app/(user)/canvas/components/canvas-node-prompt-panel.tsx']) {
   assert.match(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),/usePersonalPricing\(\)/);
  }
 } finally {await React.act(async()=>root.unmount());dom.window.close();Object.assign(global,previous);}
});
