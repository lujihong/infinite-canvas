const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const source=fs.readFileSync(path.join(__dirname,'../src/components/wallet/consumption-cost.ts'),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
const scope={exports:{}};vm.runInNewContext(code,scope);
const show=scope.exports.consumptionCostPresentation;
test('charged failure is not rendered free',()=>{
 const result=show({type:5,status:'failed',quota:1000,formatted_points:'0.02 积分'});
 assert.equal(result.amount,'-0.02 积分');assert.match(result.detail,/存在扣费/);
 assert.equal(show({type:5,quota:0}).amount,'0.00 积分');
});
test('refund uses one sign and does not invent full failure refund',()=>{
 const result=show({type:6,status:'refunded',quota:1,formatted_points:'+<0.001 积分',status_label:'差额退还'});
 assert.equal(result.amount,'+<0.001 积分');assert.equal(result.detail,'差额退还');
});
test('tiny debit remains charged and pending makes no no-charge promise',()=>{
 assert.equal(show({type:2,status:'success',quota:1,formatted_points:'<0.001 积分',formatted_money:'¥ 0.000002'}).amount,'-<0.001 积分');
 assert.equal(show({type:2,status:'processing'}).detail,'生成中，最终费用尚未结算');
 const drawer=fs.readFileSync(path.join(__dirname,'../src/components/wallet/consumption-logs-drawer.tsx'),'utf8');
 assert.match(drawer,/consumptionCostPresentation\(log\)/);assert.match(drawer,/\{cost\.amount\}/);assert.match(drawer,/\{cost\.detail\}/);
});
test('difference charge is labeled explicitly with original money value',()=>{
 const result=show({type:2,status:'difference_charge',status_label:'差额补扣',quota:30296,formatted_points:'0.61 积分',formatted_money:'¥ 0.0606'});
 assert.equal(result.amount,'-0.61 积分');
 assert.equal(result.detail,'差额补扣 · 折合 ¥ 0.0606');
});
