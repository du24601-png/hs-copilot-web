const test=require('node:test');
const assert=require('node:assert/strict');
const {once}=require('node:events');
process.env.PORT='0';process.env.HS_DEBUG='1';
const server=require('../server');
const firedId='cn_ruling:Z2024-0011';
const glassId='cn_ruling:J2025-0004';
const profile=(core,heading,terms=[],category='',sub_category='')=>({category,sub_category,core_product:core,materials:[],specifications:[],search_terms:terms,hs_synonyms:[],possible_headings:heading?[heading]:[]});
const assessment=id=>({case_id:id,relation:'supports',matched_facts:['结构'],differing_facts:[],explanation:'按实际结构判断'});
const comparison=(code,id)=>({plausible_candidates:[{code,reason:'结构匹配'}],need_clarification:false,case_assessments:id?[assessment(id)]:[]});
const decision=(code,id,changed=false)=>({selectedCode:code,confidence:'medium',case_assessments:id?[assessment(id)]:[],product_nature_changed:changed,change_note:changed?'申报对象改变':'',reasons:['结构：实际结构匹配']});

async function withHttp(queue,run) {
  const before=global.fetch,previous=process.env.HS_RULINGS;
  process.env.HS_RULINGS='1';
  const requests=[];
  const listener=server.startServer();await once(listener,'listening');
  const url='http://127.0.0.1:'+listener.address().port;
  global.fetch=async (address,options)=>{
    if(String(address).startsWith(url)) return before(address,options);
    requests.push(JSON.parse(options.body));
    const next=queue.shift();
    assert.ok(next,'No unplanned model calls');
    return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(next)}}]})};
  };
  const post=async(route,body)=>{
    const response=await before(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;
  };
  try {await run(post,requests,url,before);} finally {
    global.fetch=before;if(previous===undefined) delete process.env.HS_RULINGS;else process.env.HS_RULINGS=previous;
    await new Promise(resolve=>listener.close(resolve));
    await new Promise(resolve=>setImmediate(resolve));
  }
}

test('HTTP ordinary classification uses three model calls and database-backed case references',async()=>{
  await withHttp([profile('氧化锆块','3824',['氧化锆','牙科'],'玻璃陶瓷制品'),comparison('6914900000',firedId),decision('6914900000',firedId)],async(post,requests)=>{
    const query='HTTP普通流程 预烧制牙科氧化锆块，已1040℃预烧';
    const p1=await post('/api/classify',{query});
    assert.equal(p1.caseKnowledgeStatus.status,'ready');
    assert.ok(p1.stats.poolCodes.includes('6914900000'));
    assert.ok(p1.stats.rulings.retrievedCaseIds.includes(firedId));
    const p2=await post('/api/decide',{query,answers:[]});
    assert.equal(requests.length,3);
    assert.equal(p1.stats.llmCalls+p2.stats.llmCalls,3);
    assert.equal(p2.hs.code,'6914900000');
    assert.equal(p2.caseReferences[0].decisionNo,'Z2024-0011');
    assert.match(p2.caseReferences[0].classificationDecision,/1040/);
  });
});

test('changed nature with empty new recall refuses instead of returning old candidates or evidence',async()=>{
  await withHttp([profile('氧化锆块','6914',['氧化锆'],'玻璃陶瓷制品'),comparison('6914900000',firedId),decision('6914900000',firedId,true),profile('龘靐齉齾',null)],async(post,requests)=>{
    const query='龘靐齉齾';
    await post('/api/classify',{query});
    const p2=await post('/api/decide',{query,answers:[{attr:'对象',answer:'对象已更改',freeText:'龘靐齉齾'}]});
    assert.equal(p2.refuse,true);assert.equal(p2.selectedCode,null);assert.equal(p2.hs,null);
    assert.deepEqual(p2.caseReferences,[]);assert.deepEqual(p2.legalReferences||[],[]);
    assert.deepEqual(p2.stats.poolCodes,[]);assert.equal(p2.stats.reRetrieved,true);
    assert.equal(requests.length,4);
  });
});

test('changed nature refreshes both evidence types and removes old case IDs from final whitelist',async()=>{
  await withHttp([profile('氧化锆块','6914',['氧化锆'],'玻璃陶瓷制品'),comparison('6914900000',firedId),decision('6914900000',firedId,true),
    profile('玻璃淋浴房','7308',['淋浴房','不锈钢框架'],'家具家居','金属制品'),
    {...decision('7308300000',glassId),case_assessments:[assessment(glassId),assessment(firedId)]}],async(post,requests)=>{
    const query='Qzxvvrefresh';await post('/api/classify',{query});
    const p2=await post('/api/decide',{query,answers:[{attr:'对象',answer:'对象已更改',freeText:'是全不锈钢框架的玻璃淋浴房'}]});
    assert.equal(p2.stats.reRetrieved,true);assert.equal(p2.hs.code,'7308300000');
    assert.ok(p2.stats.rulings.retrievedCaseIds.includes(glassId));
    assert.ok(!p2.stats.rulings.retrievedCaseIds.includes(firedId));
    assert.ok(!p2.caseReferences.some(r=>r.caseId===firedId));
    assert.ok(requests[4].messages[1].content.includes(glassId));
    assert.ok(!requests[4].messages[1].content.includes(firedId));
    assert.equal(requests.length,5);
  });
});

test('flag change bypasses all old query caches and direct code lookup stays model-free',async()=>{
  await withHttp([profile('氧化锆块','6914',['氧化锆'],'玻璃陶瓷制品'),comparison('6914900000',firedId),
    profile('氧化锆块','6914',['氧化锆'],'玻璃陶瓷制品'),comparison('6914900000')],async(post,requests,url,fetch)=>{
    const query='HTTP开关流程 预烧制牙科氧化锆块';
    const on=await post('/api/classify',{query});assert.equal(on.caseKnowledgeStatus.status,'ready');
    process.env.HS_RULINGS='0';
    const off=await post('/api/classify',{query});assert.equal(off.caseKnowledgeStatus.status,'disabled');
    assert.deepEqual(off.caseReferences,[]);assert.equal(requests.length,4);
    assert.ok(!requests[3].messages[1].content.includes('历史判例证据'));
    const row=await (await fetch(url+'/api/hs/6914900000')).json();assert.equal(row.code,'6914900000');assert.equal(requests.length,4);
  });
});
