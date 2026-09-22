const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const ts=require('typescript');
const React=require('react');const {createRoot}=require('react-dom/client');const {create}=require('zustand');
const {createRequire}=require('node:module');const {JSDOM}=createRequire(process.env.XYB_RELAY_PACKAGE||path.resolve(__dirname,'../package.json'))('jsdom');
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/services/api/request-quote.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function load(user,fetch){const scope={exports:{},setTimeout,clearTimeout,AbortController,fetch,require:id=>id==='./quote-queue'?{acquireQuoteSlot:async()=>()=>{}}:id==='react'?React:id==='@/stores/use-user-store'?{useUserStore:user}:id==='@/stores/use-config-store'?{channelIdForActiveModel:c=>c.activeChannelId}:require(id)};vm.runInNewContext(code,scope);return scope.exports;}
test('quote transport matches production image/text, video and audio senders',()=>{
 const {requestUsesSiteBackend}=load(null,null);
 let token='';
 for(const file of ['image','video','audio']) {
  const source=fs.readFileSync(path.join(__dirname,`../src/services/api/${file}.ts`),'utf8');
  const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  const names=['usesAccountProxy','aiApiUrl'];
  const selected=ast.statements.filter(n=>ts.isFunctionDeclaration(n)&&names.includes(n.name?.text));
  assert.equal(selected.length,2);
  const code=ts.transpileModule(selected.map(n=>n.getText(ast)).join('\n')+'\nexport { aiApiUrl };',{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const scope={exports:{},useUserStore:{getState:()=>({token})},localChannelForActiveModel:c=>({baseUrl:c.baseUrl}),buildApiUrl:(base,p)=>base+p};
  vm.runInNewContext(code,scope);
  for(token of ['', 'session']) for(const channelMode of ['remote','local']) for(const activeChannelId of ['channel-xyb','private','xyb-official-exclusive']) {
   const c={channelMode,activeChannelId,baseUrl:'https://external.example/v1'};
   assert.equal(requestUsesSiteBackend(c,token),scope.exports.aiApiUrl(c,'/test').startsWith('/api/v1/'));
  }
 }
 const agent=fs.readFileSync(path.join(__dirname,'../src/services/api/canvas-agent.ts'),'utf8');
 assert.match(agent,/import \{ aiApiUrl, aiHeaders, refreshRemoteUser \} from "@\/services\/api\/image"/);
});

test('quote label distinguishes zero, missing, invalid and tiny positive points',()=>{
 const {quoteLabel,quoteDetails}=load(null,null);
 assert.equal(quoteLabel({status:'estimated',points_cost:0}),'预计消耗 0 积分');
 assert.notEqual(quoteLabel({status:'estimated',points_cost:1e-12}),'预计消耗 0 积分');
 assert.equal(quoteLabel({status:'estimated',points_cost:0.000019999999999999998}),'预计消耗 0.00002 积分');
 assert.notEqual(quoteLabel({status:'estimated',points_cost:Number.MIN_VALUE}),'预计消耗 0 积分');
 assert.equal(quoteLabel({status:'estimated',points_cost:null}),'预计积分暂不可用');
 assert.equal(quoteLabel({status:'estimated',points_cost:NaN}),'预计积分暂不可用');
 assert.match(quoteDetails({status:'usage_required',unit_rates:[{dimension:'输入',points_cost:0.002,per:1000,unit:'token'}]}),/0.002 积分/);
});
test('hook follows backend transport for historical IDs, aborts stale identities and never quotes browser-direct requests',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://example.test'});const saved=new Map();
 for(const k of ['window','document','navigator','IS_REACT_ACT_ENVIRONMENT']){saved.set(k,Object.getOwnPropertyDescriptor(global,k));Object.defineProperty(global,k,{configurable:true,writable:true,value:k==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[k]});}
 const user=create(()=>({token:'a',user:{id:'A'}}));let pending=[];let visible;
 const api=load(user,(url,options)=>new Promise(resolve=>pending.push({url,options,resolve})));
 const config={channelMode:'remote',activeChannelId:'channel-xyb'};
 const descriptor={endpoint:'/v1/videos',body:{model:'video-model',seconds:'5',resolution_name:'720p'},batch_count:2,missing_fields:[]};
 function View({c,d}){visible=api.useRequestQuote(c,d);return React.createElement('span',null,visible.label);}
 const root=createRoot(document.getElementById('root'));
 async function render(c,d){await React.act(async()=>root.render(React.createElement(View,{c,d})));}
 async function tick(){await React.act(async()=>new Promise(r=>setTimeout(r,390)));}
 const result=p=>({ok:true,json:async()=>({code:0,data:{status:'estimated',points_cost:p}})});
 try{
  await render(config,descriptor);assert.equal(visible.label,'预计积分计算中…');await tick();assert.equal(pending.length,1);
  assert.equal(JSON.parse(pending[0].options.body).missing_fields,undefined);
  assert.equal(pending[0].options.headers['X-Model-Channel-ID'],'channel-xyb');
  await render(config,{...descriptor,body:{...descriptor.body,seconds:'10'}});assert.equal(pending[0].options.signal.aborted,true);assert.equal(visible.quote,undefined);await tick();
  await React.act(async()=>pending[0].resolve(result(99)));assert.equal(visible.quote,undefined);
  await React.act(async()=>pending[1].resolve(result(2)));assert.equal(visible.label,'预计消耗 2 积分');
  await React.act(async()=>user.setState({token:'b',user:{id:'B'}}));assert.equal(visible.quote,undefined);await tick();
  assert.equal(pending[2].options.headers.Authorization,'Bearer b');
  const local={...config,channelMode:'local',activeChannelId:'private',baseUrl:'https://external.example/v1',apiKey:'external-key'};
  await render(local,descriptor);await tick();assert.equal(pending.length,4);assert.equal(visible.quote,undefined);
  assert.equal(pending[3].options.headers['X-User-Model-Channel-ID'],'private');
  await React.act(async()=>pending[2].resolve(result(12)));assert.equal(visible.quote,undefined);
  await React.act(async()=>pending[3].resolve(result(0.000019999999999999998)));assert.equal(visible.label,'预计消耗 0.00002 积分');
  for(const endpoint of ['/v1/images/generations','/v1/images/edits','/v1/chat/completions','/v1/responses','/v1/audio/speech']) {
   await render(local,{...descriptor,endpoint});await tick();
   assert.equal(JSON.parse(pending.at(-1).options.body).endpoint,endpoint);
  }
  const count=pending.length;
  await React.act(async()=>user.setState({token:'',user:{id:'B'}}));await tick();
  assert.equal(pending.length,count);assert.equal(visible.quote,undefined);assert.match(visible.detail,/浏览器直连/);
  for(const protocol of ['openai','gemini','kie','apimart','mimo','grok2api']) {
   await render({...local,protocol,activeChannelId:'xyb-official-exclusive'},descriptor);await tick();
   assert.equal(pending.length,count);assert.equal(visible.quote,undefined);
  }
  await React.act(async()=>user.setState({token:'b',user:{id:'B'}}));
  await render(config,{...descriptor,missing_fields:['reference_media']});await tick();assert.equal(pending.length,count);assert.match(visible.detail,/reference_media/);
 }finally{await React.act(async()=>root.unmount());dom.window.close();for(const[k,d]of saved){if(d)Object.defineProperty(global,k,d);else delete global[k];}}
});
