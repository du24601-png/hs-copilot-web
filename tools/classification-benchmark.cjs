// Evaluation only. Labels never cross the classifier or answer-generator boundary.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.join(__dirname,'..');
const FIXTURES={export:'export-seller-noisy-20.json',difficult:'real-products-noisy-20.json'};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash=file=>hash(fs.readFileSync(file));

function factAnswer(question,description) {
  return question?[{attr:String(question.attr||'关键确认').slice(0,12),answer:'补充商品事实',freeText:String(description).slice(0,200)}]:[];
}
function scoreResult(item,decision) {
  const finalCode=decision.selectedCode?String(decision.selectedCode):null;
  const refused=!!decision.refuse||!finalCode;
  return {finalCode,correct:!refused&&finalCode===item.expectedCode,status:refused?'refused':'decided'};
}
function summarize(results) {
  const avg=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:0;
  const basic=rows=>({total:rows.length,correct:rows.filter(r=>r.correct).length});
  const latencies=results.map(r=>r.latencyMs).sort((a,b)=>a-b);
  const correct=results.filter(r=>r.correct).length;
  return {
    total:results.length,correct,exactMatchRate:results.length?correct/results.length:0,
    refuses:results.filter(r=>r.status.startsWith('refused')).length,errors:results.filter(r=>r.status==='error').length,
    headingRecall:results.filter(r=>r.headingHit).length,hs10CandidateRecall:results.filter(r=>r.hs10Hit).length,
    caseHitCount:results.filter(r=>r.retrievedCaseIds?.length).length,
    caseCitationCount:results.filter(r=>r.caseReferences?.length).length,
    fallbackCases:results.filter(r=>r.modelTrace?.some(t=>t.fallback)).length,
    meanLatencyMs:Math.round(avg(latencies)),p95LatencyMs:latencies[Math.max(0,Math.ceil(latencies.length*.95)-1)]||0,
    meanPoolSize:Number(avg(results.map(r=>r.poolSize||0)).toFixed(1)),
    meanLlmCalls:Number(avg(results.map(r=>r.llmCalls||0)).toFixed(2)),
    subgroups:{covered:basic(results.filter(r=>r.coveredByCorpus===true)),notCovered:basic(results.filter(r=>r.coveredByCorpus===false))}
  };
}
async function postJson(baseUrl,route,body,timeoutMs) {
  const response=await fetch(baseUrl+route,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(timeoutMs)});
  const text=await response.text();
  let payload;
  try { payload=JSON.parse(text); } catch { throw new Error(route+' returned non-JSON'); }
  if(!response.ok) throw new Error(payload.error||route+' HTTP '+response.status);
  return payload;
}
async function runCase(item,{baseUrl,dataset,timeoutMs,corpusIds}) {
  const started=performance.now();
  const query=String(item.description);
  let p1=null,p2=null,answers=[];
  try {
    p1=await postJson(baseUrl,'/api/classify',{query},timeoutMs);
    if(!p1.stats||!Array.isArray(p1.stats.poolCodes)) throw new Error('HS_DEBUG poolCodes missing; cannot report candidate recall');
    if(!p1.refuse) {
      answers=dataset==='export'?factAnswer(p1.questions?.[0],query):[];
      p2=await postJson(baseUrl,'/api/decide',{query,knownAttrs:p1.knownAttrs||[],answers},timeoutMs);
    }
    const pool=p1.stats.poolCodes;
    const result=p2?scoreResult(item,p2):{finalCode:null,correct:false,status:'refused-before-decision'};
    return {id:item.id,productName:item.productName,expectedCode:item.expectedCode,...result,
      coveredByCorpus:item.officialDecisionId?corpusIds.has(item.officialDecisionId):null,
      headingHit:pool.some(code=>code.slice(0,4)===item.expectedCode.slice(0,4)),hs10Hit:pool.includes(item.expectedCode),
      poolSize:pool.length,poolCodes:pool,finalPoolCodes:p2?.stats?.poolCodes||pool,
      asked:!!p1.questions?.length,answers,questions:p1.questions||[],
      llmCalls:(p1.stats.llmCalls||0)+(p2?.stats?.llmCalls||0),
      modelTrace:[...(p1.stats.modelTrace||[]),...(p2?.stats?.modelTrace||[])],
      retrievedCaseIds:p2?.stats?.rulings?.retrievedCaseIds||p1.stats.rulings?.retrievedCaseIds||[],
      addedCodes:p1.stats.rulings?.addedCodes||[],caseReferences:p2?.caseReferences||[],
      caseKnowledgeStatus:p2?.caseKnowledgeStatus||p1.caseKnowledgeStatus,
      reRetrieved:!!p2?.stats?.reRetrieved,reasons:p2?.reasons||[],detail:p2?.refuseReason||p1.refuseReason||'',
      degraded:!!p1.degraded||!!p2?.degraded,latencyMs:Math.round(performance.now()-started)};
  } catch(error) {
    return {id:item.id,productName:item.productName,expectedCode:item.expectedCode,finalCode:null,correct:false,status:'error',
      coveredByCorpus:item.officialDecisionId?corpusIds.has(item.officialDecisionId):null,
      headingHit:!!p1?.stats?.poolCodes?.some(code=>code.startsWith(item.expectedCode.slice(0,4))),
      hs10Hit:!!p1?.stats?.poolCodes?.includes(item.expectedCode),poolCodes:p1?.stats?.poolCodes||[],poolSize:p1?.stats?.poolCodes?.length||0,
      modelTrace:[...(p1?.stats?.modelTrace||[]),...(p2?.stats?.modelTrace||[])],
      llmCalls:(p1?.stats?.llmCalls||0)+(p2?.stats?.llmCalls||0),answers,
      latencyMs:Math.round(performance.now()-started),detail:String(error.message||error)};
  }
}
async function runBenchmark({dataset,baseUrl,output,metadata={},corpusIds=new Set(),only=[],concurrency=2,timeoutMs=120000}) {
  if(!FIXTURES[dataset]) throw new Error('Unknown dataset');
  const fixturePath=path.join(root,'test','fixtures',FIXTURES[dataset]);
  const fixtureBytes=fs.readFileSync(fixturePath);
  const fixture=JSON.parse(fixtureBytes.toString('utf8'));
  const fixtureHash=hash(fixtureBytes);
  const cases=fixture.cases.filter(item=>!only.length||only.includes(item.id));
  if(!cases.length) throw new Error('No test cases selected');
  const startedAt=new Date().toISOString();
  const results=new Array(cases.length);
  let cursor=0;
  async function worker() {
    while(cursor<cases.length) {
      const i=cursor++;
      const result=await runCase(cases[i],{baseUrl,dataset,timeoutMs,corpusIds});
      results[i]=result;
      console.log((result.correct?'PASS':'FAIL')+' '+result.id+' expected='+result.expectedCode+' final='+(result.finalCode||'none')+' cases='+(result.retrievedCaseIds?.length||0)+' status='+result.status);
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,cases.length)},worker));
  const report={startedAt,completedAt:new Date().toISOString(),dataset,baseUrl,
    method:dataset==='export'?'description -> classify -> fixed description facts in freeText -> decide -> exact HS10':'description -> classify -> empty answers -> decide -> exact HS10',
    metadata:{...metadata,fixtureHash,concurrency,timeoutMs},summary:summarize(results),results};
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report.summary));
  return report;
}
function compareReports(off,on) {
  const reasons=[];
  for(const key of ['codeHash','databaseHash','configHash','fixtureHash','concurrency','timeoutMs']) {
    if(off.metadata[key]!==on.metadata[key]) reasons.push('不同对照条件：'+key);
  }
  if(off.dataset!==on.dataset||off.summary.total!==on.summary.total) reasons.push('数据集或样本数不同');
  if(on.summary.correct<off.summary.correct) reasons.push('精确正确数下降');
  if(off.summary.errors||on.summary.errors) reasons.push('出现接口错误');
  const byId=new Map(off.results.map(r=>[r.id,r]));
  const improvements=[],regressions=[],incomparable=[];
  for(const item of on.results) {
    const before=byId.get(item.id);
    if(!before||before.expectedCode!==item.expectedCode) { reasons.push('样本或标准答案不一致：'+item.id);continue; }
    if(!before.correct&&item.correct) improvements.push(item.id);
    if(before.correct&&!item.correct) regressions.push(item.id);
    const traces=[...(before.modelTrace||[]),...(item.modelTrace||[])];
    const models=new Set(traces.map(t=>String(t.providerIndex??0)+':'+t.model));
    const traceComplete=row=>Array.isArray(row.modelTrace)&&row.modelTrace.length>0
      &&row.modelTrace.length===row.llmCalls&&row.modelTrace.every(t=>typeof t.model==='string'&&t.model.length>0);
    const caseLayerHealthy=before.caseKnowledgeStatus?.status==='disabled'
      &&['ready','no_match'].includes(item.caseKnowledgeStatus?.status);
    if(!traceComplete(before)||!traceComplete(item)||!caseLayerHealthy
      ||traces.some(t=>t.fallback)||models.size!==1||before.degraded||item.degraded) incomparable.push(item.id);
  }
  if(incomparable.length) reasons.push('存在模型降级、缺失遥测、判例层降级或不可比案例');
  return {dataset:off.dataset,before:off.summary,after:on.summary,
    deltaCorrect:on.summary.correct-off.summary.correct,improvements,regressions,incomparable,
    eligible:reasons.length===0,reasons};
}
function readArg(name,fallback) { const i=process.argv.indexOf(name);return i>=0&&process.argv[i+1]?process.argv[i+1]:fallback; }
async function cli(dataset) {
  const report=await runBenchmark({dataset,baseUrl:readArg('--base-url',process.env.HS_BASE_URL||'http://127.0.0.1:7100').replace(/\/$/,''),
    output:path.resolve(readArg('--output',path.join(__dirname,dataset==='export'?'export-seller-20-result.json':'real-products-20-simplified.json'))),
    concurrency:Math.min(4,Math.max(1,Number(readArg('--concurrency',2))||2)),
    timeoutMs:Math.max(1000,Number(readArg('--timeout-ms',120000))||120000),only:readArg('--only','').split(',').filter(Boolean)});
  process.exitCode=report.summary.errors?2:report.summary.correct===report.summary.total?0:1;
}
module.exports={factAnswer,scoreResult,summarize,compareReports,runBenchmark,cli,fileHash,hash};
