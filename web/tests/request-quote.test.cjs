const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const ts=require('typescript');
const React=require('react');const {createRoot}=require('react-dom/client');const {create}=require('zustand');
const {createRequire}=require('node:module');const {JSDOM}=createRequire(process.env.XYB_RELAY_PACKAGE||path.resolve(__dirname,'../package.json'))('jsdom');
const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/services/api/request-quote.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function load(user,fetch){const scope={exports:{},setTimeout,clearTimeout,AbortController,fetch,require:id=>id==='./quote-queue'?{acquireQuoteSlot:async()=>()=>{}}:id==='react'?React:id==='@/stores/use-user-store'?{useUserStore:user}:id==='@/stores/use-config-store'?{channelIdForActiveModel:c=>c.activeChannelId}:require(id)};vm.runInNewContext(code,scope);return scope.exports;}
test('quote label distinguishes zero, missing, invalid and tiny positive points',()=>{
 const {quoteLabel,quoteDetails}=load(null,null);
 assert.equal(quoteLabel({status:'estimated',points_cost:0}),'预计消耗 0 积分');
 assert.notEqual(quoteLabel({status:'estimated',points_cost:1e-12}),'预计消耗 0 积分');
 assert.equal(quoteLabel({status:'estimated',points_cost:null}),'预计积分暂不可用');
 assert.equal(quoteLabel({status:'estimated',points_cost:NaN}),'预计积分暂不可用');
 assert.match(quoteDetails({status:'usage_required',unit_rates:[{dimension:'输入',points_cost:0.002,per:1000,unit:'token'}]}),/0.002 积分/);
});
test('hook aborts stale parameters and users, never quotes an external channel or sends missing metadata',async()=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://example.test'});const saved=new Map();
 for(const k of ['window','document','navigator','IS_REACT_ACT_ENVIRONMENT']){saved.set(k,Object.getOwnPropertyDescriptor(global,k));Object.defineProperty(global,k,{configurable:true,writable:true,value:k==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[k]});}
 const user=create(()=>({token:'a',user:{id:'A'}}));let pending=[];let visible;
 const api=load(user,(url,options)=>new Promise(resolve=>pending.push({url,options,resolve})));
 const config={channelMode:'remote',activeChannelId:'xyb-official-exclusive'};
 const descriptor={endpoint:'/v1/videos',body:{model:'video-model',seconds:'5',resolution_name:'720p'},batch_count:2,missing_fields:[]};
 function View({c,d}){visible=api.useRequestQuote(c,d);return React.createElement('span',null,visible.label);}
 const root=createRoot(document.getElementById('root'));
 async function render(c,d){await React.act(async()=>root.render(React.createElement(View,{c,d})));}
 async function tick(){await React.act(async()=>new Promise(r=>setTimeout(r,390)));}
 const result=p=>({ok:true,json:async()=>({code:0,data:{status:'estimated',points_cost:p}})});
 try{
  await render(config,descriptor);assert.equal(visible.label,'预计积分计算中…');await tick();assert.equal(pending.length,1);
  assert.equal(JSON.parse(pending[0].options.body).missing_fields,undefined);
  await render(config,{...descriptor,body:{...descriptor.body,seconds:'10'}});assert.equal(pending[0].options.signal.aborted,true);assert.equal(visible.quote,undefined);await tick();
  await React.act(async()=>pending[0].resolve(result(99)));assert.equal(visible.quote,undefined);
  await React.act(async()=>pending[1].resolve(result(2)));assert.equal(visible.label,'预计消耗 2 积分');
  await React.act(async()=>user.setState({token:'b',user:{id:'B'}}));assert.equal(visible.quote,undefined);await tick();
  assert.equal(pending[2].options.headers.Authorization,'Bearer b');
  await render({...config,channelMode:'local',activeChannelId:'private'},descriptor);await tick();assert.equal(pending.length,3);assert.equal(visible.quote,undefined);
  await React.act(async()=>pending[2].resolve(result(12)));assert.equal(visible.quote,undefined);
  await render(config,{...descriptor,missing_fields:['reference_media']});await tick();assert.equal(pending.length,3);assert.match(visible.detail,/reference_media/);
 }finally{await React.act(async()=>root.unmount());dom.window.close();for(const[k,d]of saved){if(d)Object.defineProperty(global,k,d);else delete global[k];}}
});
