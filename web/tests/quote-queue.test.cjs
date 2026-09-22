const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const vm=require('node:vm');const ts=require('typescript');
test('quote queue caps concurrent work at four and releases cancelled waiters',async()=>{
 const scope={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/services/api/quote-queue.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,scope);
 const acquire=scope.exports.acquireQuoteSlot;
 const releases=await Promise.all(Array.from({length:4},()=>acquire(new AbortController().signal)));
 let started=false;const cancelled=new AbortController();const fifth=acquire(cancelled.signal);const rejected=assert.rejects(fifth,/取消/);cancelled.abort();await rejected;
 const sixth=acquire(new AbortController().signal).then(release=>{started=true;return release;});await Promise.resolve();assert.equal(started,false);
 releases[0]();const release=await sixth;assert.equal(started,true);releases[0]();release();releases.slice(1).forEach(r=>r());
 const again=await Promise.all(Array.from({length:4},()=>acquire(new AbortController().signal)));again.forEach(r=>r());
});
