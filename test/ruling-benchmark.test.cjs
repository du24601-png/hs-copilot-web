const test=require('node:test');
const assert=require('node:assert/strict');
let ab={};
try { ab=require('../tools/run-ruling-ab.cjs'); } catch(error) { if(error.code!=='MODULE_NOT_FOUND') throw error; }
let bench={};
try { bench=require('../tools/classification-benchmark.cjs'); } catch(error) { if(error.code!=='MODULE_NOT_FOUND') throw error; }

test('fact answering never reads expected labels or option codes',()=>{
  assert.equal(typeof bench.factAnswer,'function');
  const question={attr:'关键确认'};
  Object.defineProperty(question,'options',{get(){throw new Error('oracle access');}});
  const answer=bench.factAnswer(question,'未经烧制的氧化锆');
  assert.deepEqual(answer,[{attr:'关键确认',answer:'补充商品事实',freeText:'未经烧制的氧化锆'}]);
  assert.deepEqual(bench.factAnswer(null,'fact'),[]);
});

test('AB schedule has exactly four fresh arms and 80 fixed product flows',()=>{
  assert.equal(typeof ab.buildMatrix,'function');
  assert.deepEqual(ab.buildMatrix(),[
    {dataset:'export',enabled:false},{dataset:'export',enabled:true},
    {dataset:'difficult',enabled:false},{dataset:'difficult',enabled:true}
  ]);
});

test('scoring refuses does not count a coincidentally returned correct code as correct',()=>{
  assert.equal(typeof bench.scoreResult,'function');
  const value=bench.scoreResult({expectedCode:'1234567890'}, {selectedCode:'1234567890',refuse:true});
  assert.equal(value.correct,false);
  assert.equal(value.status,'refused');
});

test('summary counts final codes separately from retrieval and retains covered subgroups',()=>{
  assert.equal(typeof bench.summarize,'function');
  const value=bench.summarize([
    {id:'a',correct:true,status:'decided',headingHit:true,hs10Hit:true,latencyMs:100,llmCalls:3,poolSize:30,coveredByCorpus:true},
    {id:'b',correct:false,status:'refused',headingHit:true,hs10Hit:true,latencyMs:200,llmCalls:3,poolSize:30,coveredByCorpus:false}
  ]);
  assert.equal(value.correct,1);assert.equal(value.hs10CandidateRecall,2);
  assert.equal(value.subgroups.covered.total,1);assert.equal(value.subgroups.notCovered.correct,0);
});

test('paired comparison reports individual gains/regressions and gates any model fallback or changed evidence',()=>{
  assert.equal(typeof bench.compareReports,'function');
  const metadata={codeHash:'c',databaseHash:'d',configHash:'m',fixtureHash:'f',concurrency:2,timeoutMs:120000};
  const off={dataset:'export',metadata,summary:{total:2,correct:1,errors:0},results:[
    {id:'a',expectedCode:'1',correct:true,llmCalls:1,caseKnowledgeStatus:{status:'disabled'},modelTrace:[{model:'m',fallback:false}],latencyMs:1},
    {id:'b',expectedCode:'2',correct:false,llmCalls:1,caseKnowledgeStatus:{status:'disabled'},modelTrace:[{model:'m',fallback:false}],latencyMs:1}]};
  const on={...off,results:[{...off.results[0],correct:false,caseKnowledgeStatus:{status:'ready'}},{...off.results[1],correct:true,caseKnowledgeStatus:{status:'no_match'}}]};
  const value=bench.compareReports(off,on);
  assert.deepEqual(value.regressions,['a']);assert.deepEqual(value.improvements,['b']);assert.equal(value.eligible,true);
  assert.equal(bench.compareReports(off,{...on,metadata:{...metadata,databaseHash:'changed'}}).eligible,false);
  assert.equal(bench.compareReports(off,{...on,summary:{total:2,correct:0,errors:0}}).eligible,false);
  assert.equal(bench.compareReports(off,{...on,results:[{...on.results[0],modelTrace:[{model:'fallback',fallback:true}]},on.results[1]]}).eligible,false);
  assert.equal(bench.compareReports({...off,results:off.results.map(r=>({...r,modelTrace:[]}))},on).eligible,false);
  assert.equal(bench.compareReports(off,{...on,results:on.results.map(r=>({...r,llmCalls:3}))}).eligible,false);
  for(const status of ['error','unavailable','disabled']) {
    assert.equal(bench.compareReports(off,{...on,results:on.results.map(r=>({...r,caseKnowledgeStatus:{status}}))}).eligible,false);
  }
});
