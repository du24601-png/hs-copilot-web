#!/usr/bin/env node
// One immutable-snapshot experiment: four fresh server processes, exactly 20 products per arm.
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {DatabaseSync,backup}=require('node:sqlite');
const {runBenchmark,compareReports,fileHash,hash}=require('./classification-benchmark.cjs');
const root=path.join(__dirname,'..');
const buildMatrix=()=>[
  {dataset:'export',enabled:false},{dataset:'export',enabled:true},
  {dataset:'difficult',enabled:false},{dataset:'difficult',enabled:true}
];
const runtimeFiles=['server.js','legal-knowledge.js','ruling-knowledge.js','app.js','index.html',
  'styles.css','ruling-view.js','tools/classification-benchmark.cjs','tools/run-ruling-ab.cjs'];
const codeHash=()=>hash(runtimeFiles.map(file=>file+':'+fileHash(path.join(root,file))).join('\n'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort() {
  const server=net.createServer();
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));return port;
}
async function startArm(arm,dbPath,logPath) {
  const port=await freePort();
  const runId=crypto.randomUUID();
  const out=fs.openSync(logPath,'wx');
  let child;
  try {
    child=spawn(process.execPath,[path.join(root,'server.js'),'--port',String(port),'--host','127.0.0.1'],{
      cwd:root,windowsHide:true,stdio:['ignore',out,out],
      env:{...process.env,HS_DEBUG:'1',HS_RULINGS:arm.enabled?'1':'0',HS_DB_PATH:dbPath,HS_RUN_ID:runId}
    });
  } finally { fs.closeSync(out); }
  let spawnError;
  child.on('error',error=>{spawnError=error;});
  const stop=async()=>{
    if(child.exitCode!==null||child.signalCode) return;
    const exited=once(child,'exit').catch(()=>{});
    child.kill();
    await Promise.race([exited,sleep(3000)]);
  };
  const baseUrl='http://127.0.0.1:'+port;
  try {
    for(let i=0;i<100;i++) {
      if(spawnError) throw spawnError;
      if(child.exitCode!==null) throw new Error('Test server exited: '+child.exitCode);
      try {
        const response=await fetch(baseUrl+'/api/health',{signal:AbortSignal.timeout(500)});
        const health=await response.json();
        if(health.runId===runId&&health.rulings.enabled===arm.enabled&&health.db&&health.llm) return {baseUrl,stop,runId,health};
      } catch { /* wait for owned child to start */ }
      await sleep(100);
    }
    throw new Error('Fresh test server did not become ready');
  } catch(error) {await stop();throw error;}
}
async function main() {
  const arg=process.argv.indexOf('--output-dir');
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const directory=path.resolve(arg>=0?process.argv[arg+1]:path.join(__dirname,'ruling-ab-'+stamp));
  // Existing output directories cannot be reused to accidentally rerun a partial experiment.
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory,'RUN_STARTED.json'),JSON.stringify({startedAt:new Date().toISOString(),matrix:buildMatrix(),productFlows:80},null,2));
  const snapshotDir=path.join(__dirname,'backup');fs.mkdirSync(snapshotDir,{recursive:true});
  const snapshot=path.join(snapshotDir,'ruling-ab-'+stamp+'.db');
  const source=new DatabaseSync(path.join(root,'hs_copilot.db'),{readOnly:true});
  try {await backup(source,snapshot);} finally {source.close();}
  const frozen=new DatabaseSync(snapshot,{readOnly:true});
  const ids=new Set(frozen.prepare('SELECT decision_no FROM ruling_case').all().map(r=>r.decision_no));
  if(ids.size!==104) throw new Error('AB requires exactly104 approved rulings');
  for(const name of ['export-seller-noisy-20.json','real-products-noisy-20.json']) {
    const rows=JSON.parse(fs.readFileSync(path.join(root,'test','fixtures',name),'utf8')).cases;
    if(rows.length!==20||new Set(rows.map(r=>r.id)).size!==20) throw new Error('Expected20 unique fixtures: '+name);
    for(const row of rows) if(!frozen.prepare('SELECT 1 FROM hs_code WHERE code=?').get(row.expectedCode)) throw new Error('Expected code absent: '+row.id);
    if(name.startsWith('real-')&&rows.filter(r=>ids.has(r.officialDecisionId)).length!==14) throw new Error('Corpus overlap changed');
  }
  frozen.close();
  const metadata={codeHash:codeHash(),databaseHash:fileHash(snapshot),configHash:fileHash(path.join(root,'llm.config.json')),
    nodeVersion:process.version,protocol:'ruling-ab-v1',corpusSize:104};
  const reports=[];
  try {
    for(const arm of buildMatrix()) {
      if(codeHash()!==metadata.codeHash||fileHash(snapshot)!==metadata.databaseHash||fileHash(path.join(root,'llm.config.json'))!==metadata.configHash) throw new Error('Frozen experiment inputs changed; do not continue');
      const name=arm.dataset+'-'+(arm.enabled?'on':'off');
      console.log('ARM '+name);
      const server=await startArm(arm,snapshot,path.join(directory,name+'.log'));
      try {
        const report=await runBenchmark({dataset:arm.dataset,baseUrl:server.baseUrl,output:path.join(directory,name+'.json'),
          metadata:{...metadata,enabled:arm.enabled,runId:server.runId,sourceVersion:server.health.rulings.version},
          corpusIds:ids,concurrency:2,timeoutMs:120000});
        reports.push(report);
      } finally {await server.stop();}
    }
    if(codeHash()!==metadata.codeHash||fileHash(snapshot)!==metadata.databaseHash||fileHash(path.join(root,'llm.config.json'))!==metadata.configHash) throw new Error('Frozen experiment inputs changed during last arm');
    const pairs=[compareReports(reports[0],reports[1]),compareReports(reports[2],reports[3])];
    const result={completedAt:new Date().toISOString(),metadata,productFlows:reports.reduce((n,r)=>n+r.results.length,0),
      recommendedEnabled:pairs.every(p=>p.eligible),pairs,
      limitations:['单轮小样本回归，不是总体业务准确率或统计显著性证明。','疑难集14例对应判例已入库，6例未入库；分别报告。','旧电商17/20使用标准编码反选选项，不与本次事实作答结果直接比较。']};
    fs.writeFileSync(path.join(directory,'comparison.json'),JSON.stringify(result,null,2)+'\n');
    const rows=pairs.map(p=>'| '+p.dataset+' | '+p.before.correct+'/20 | '+p.after.correct+'/20 | '+(p.deltaCorrect>=0?'+':'')+p.deltaCorrect+' | '+p.after.errors+' | '+p.improvements.join(', ')+' | '+p.regressions.join(', ')+' |');
    fs.writeFileSync(path.join(directory,'comparison.md'),'# 判例层单轮对照结果\n\n默认启用建议：'+(result.recommendedEnabled?'通过':'不通过，保持关闭')+'。共80个商品流程。\n\n| 数据集 | 关闭 | 开启 | 净变化 | 开启接口错误 | 修正案例 | 退化案例 |\n|---|---:|---:|---:|---:|---|---|\n'+rows.join('\n')+'\n\n'+pairs.map(p=>p.dataset+'：'+(p.reasons.join('；')||'满足约定门槛')).join('\n\n')+'\n\n'+result.limitations.join('\n\n')+'\n');
    console.log('COMPARISON '+JSON.stringify(result));
    console.log('OUTPUT '+directory);
    process.exitCode=result.recommendedEnabled?0:1;
  } catch(error) {
    fs.writeFileSync(path.join(directory,'RUN_FAILED.json'),JSON.stringify({message:error.message,completedArms:reports.length,doNotAutomaticallyRerun:true},null,2));
    throw error;
  }
}
if(require.main===module) main().catch(error=>{console.error(error);process.exitCode=2;});
module.exports={buildMatrix};
