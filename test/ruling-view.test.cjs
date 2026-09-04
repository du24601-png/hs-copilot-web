const test = require('node:test');
const assert = require('node:assert/strict');
let view={};
try { view=require('../ruling-view'); } catch(error) { if(error.code!=='MODULE_NOT_FOUND') throw error; }
const example={decisionNo:'Z2024-0011',productName:'预烧制牙科氧化锆块',historicalCode:'6914.9000',
  candidateCount:1,mappingStatus:'pending',announcementNo:'公告116号',publishDate:null,
  validityStatus:'未在所附2025失效清单中',productDescription:'经过1040℃预烧',classificationDecision:'按陶瓷制品归类',
  ruleBasis:'归类总规则一及六',sourceFile:'source.docx',sourceUrl:null,
  analysis:{relation:'supports',matchedFacts:['经过预烧'],differingFacts:[],explanation:'加工状态匹配'}};

test('case evidence shows original text separately from AI analysis and pending mapping',()=>{
  assert.equal(typeof view.render,'function');
  const html=view.render({caseReferences:[example],caseKnowledgeStatus:{status:'ready'}});
  for(const text of ['Z2024-0011','6914.9000','待业务确认','AI适用性分析','经过1040℃预烧','发布日期未提供','支持本次判断']) assert.ok(html.includes(text));
  assert.ok(html.includes('<details'));
  assert.ok(!html.includes('现行有效'));
});

test('case HTML escapes text, omits incomplete or unsafe URLs and removes local paths',()=>{
  assert.equal(typeof view.render,'function');
  for(const url of ['javascript:alert(1)','https://example.com/notice...','https://example.com/notice…']) {
    const html=view.render({caseReferences:[{...example,productName:'<img src=x onerror=alert(1)>',sourceUrl:url,sourceFile:'C:\\private\\source.docx'}]});
    assert.ok(!html.includes('<img'));
    assert.ok(!html.includes('href='));
    assert.ok(!html.includes('C:\\private'));
  }
  const html=view.render({caseReferences:[{...example,sourceUrl:'https://example.com/notice'}]});
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

test('empty, disabled, failed and legacy states do not invent references',()=>{
  assert.equal(typeof view.render,'function');
  assert.match(view.render({}),/未保存判例/);
  assert.match(view.render({caseKnowledgeStatus:{status:'disabled'},caseReferences:[]}),/未启用/);
  assert.match(view.render({caseKnowledgeStatus:{status:'no_match'},caseReferences:[]}),/未检索到/);
  assert.match(view.render({caseKnowledgeStatus:{status:'error'},caseReferences:[]}),/不可用/);
  assert.match(view.render({caseKnowledgeStatus:{status:'ready',matchedCount:4},caseReferences:[]}),/未引用/);
  assert.match(view.render({caseReferences:[{...example,classificationDecision:null,analysis:{relation:'distinguishes'}}]}),/未提供独立/);
});
