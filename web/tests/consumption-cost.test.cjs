const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
function load(file, modules={}) {
 const code=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
 const scope={exports:{},require:id=>modules[id]};vm.runInNewContext(code,scope);return scope.exports;
}
const points=load('lib/points.ts');
const show=load('components/wallet/consumption-cost.ts',{'@/lib/points':points}).consumptionCostPresentation;
test('charged failure uses authoritative decimal points, not rounded text or quota',()=>{
 const result=show({type:5,status:'failed',quota:null,points_cost:0.02,formatted_points:'0.0 积分'});
 assert.equal(result.amount,'-0.02 积分');assert.match(result.detail,/存在扣费/);
 assert.equal(show({type:5,points_cost:0}).amount,'0 积分');
});
test('refund uses one sign and exact tiny points',()=>{
 const result=show({type:6,status:'refunded',points_cost:0.00002,formatted_points:'+<0.001 积分',status_label:'差额退还'});
 assert.equal(result.amount,'+0.00002 积分');assert.equal(result.detail,'差额退还');
});
test('tiny debit remains charged and pending makes no no-charge promise',()=>{
 assert.equal(show({type:2,status:'success',points_cost:0.00002,formatted_money:'¥ 0.000002'}).amount,'-0.00002 积分');
 assert.equal(show({type:2,status:'processing'}).detail,'生成中，最终费用尚未结算');
});
test('difference charge is labeled in points without money conversion',()=>{
 const result=show({type:2,status_label:'差额补扣',points_cost:0.60592,formatted_points:'0.61 积分',formatted_money:'¥ 0.0606'});
 assert.equal(result.amount,'-0.60592 积分');assert.equal(result.detail,'差额补扣');
});
test('missing or invalid points never claim free even when quota or status says zero',()=>{
 for(const points_cost of [undefined,null,NaN,Infinity,-1,'0']) {
  for(const status of ['failed','free','success','refunded']) {
   const result=show({type:2,status,quota:0,points_cost,formatted_points:'0.00 积分'});
   assert.equal(result.amount,'积分暂不可用');assert.doesNotMatch(result.detail,/未扣费|为零|免费/);
  }
 }
});
