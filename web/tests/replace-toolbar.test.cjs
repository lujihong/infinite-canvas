const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const {createRoot} = require('react-dom/client');
const {createRequire} = require('node:module');
const relayRequire = createRequire(process.env.XYB_RELAY_PACKAGE || path.resolve(__dirname,'../package.json'));
const {JSDOM} = relayRequire('jsdom');

test('real Popover trigger opens sources without file click; only local choice opens file input',async()=>{
 const dom = new JSDOM('<div id="root"></div><input id="file" type="file">',{url:'https://workbench.example',pretendToBeVisual:true});
 const saved=new Map();
 saved.set('ResizeObserver',Object.getOwnPropertyDescriptor(global,'ResizeObserver'));
 global.ResizeObserver=class {observe(){} unobserve(){} disconnect(){}};
 for(const key of ['window','document','navigator','HTMLElement','HTMLInputElement','SVGElement','Element','Node','ShadowRoot','getComputedStyle','MutationObserver','IS_REACT_ACT_ENVIRONMENT']){
  saved.set(key,Object.getOwnPropertyDescriptor(global,key));
  Object.defineProperty(global,key,{configurable:true,writable:true,value:key==='IS_REACT_ACT_ENVIRONMENT'?true:dom.window[key]});
 }
 dom.window.matchMedia=()=>({matches:false,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}});
 const source=fs.readFileSync(path.join(__dirname,'../src/app/(user)/canvas/components/canvas-node-hover-toolbar.tsx'),'utf8');
 const ast=ts.createSourceFile('toolbar.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 const fn=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='ToolbarAction');
 assert.ok(fn);
 const compiled=ts.transpileModule('import {useState} from "react";import {Popover,Tooltip} from "antd";'+fn.getText(ast)+'\nexport {ToolbarAction};',{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 const scope={exports:{},require:id=>id==='react'?React:id==='antd'?require('antd'):require(id)};
 vm.runInNewContext(compiled,scope);
 const Action=scope.exports.ToolbarAction;
 let files=0, aicc=0, mine=0;
 const input=document.getElementById('file');
 input.addEventListener('click',()=>files++);
 const upload=()=>input.click();
 const menu=React.createElement('div',null,
  React.createElement('button',{onClick:()=>aicc++},'移动云素材'),
  React.createElement('button',{onClick:()=>mine++},'我的素材'),
  React.createElement('button',{onClick:upload},'本地文件'));
 const root=createRoot(document.getElementById('root'));
 const click=async text=>{const button=[...document.querySelectorAll('button')].find(n=>n.textContent===text);assert.ok(button,text);await React.act(async()=>{button.click();await new Promise(r=>setTimeout(r,40));});};
 try{
  await React.act(async()=>root.render(React.createElement(Action,{title:'替换图片',label:'替换图片',showLabel:true,onClick:upload,menuContent:menu})));
  await click('替换图片'); assert.equal(files,0);
  await click('移动云素材');assert.equal(aicc,1);assert.equal(files,0);
  await click('替换图片');await click('我的素材');assert.equal(mine,1);assert.equal(files,0);
  await click('替换图片');await click('本地文件');assert.equal(files,1);
  await React.act(async()=>root.render(React.createElement(Action,{key:'new-video-node',title:'替换视频',label:'替换视频',showLabel:true,onClick:upload,menuContent:menu})));
  assert.equal(document.querySelectorAll('.ant-popover:not(.ant-popover-hidden)').length,0);
  await click('替换视频');assert.equal(files,1);await click('本地文件');assert.equal(files,2);
 }finally{
  await React.act(async()=>root.unmount());dom.window.close();
  for(const [key,descriptor] of saved){if(descriptor)Object.defineProperty(global,key,descriptor);else delete global[key];}
 }
});
