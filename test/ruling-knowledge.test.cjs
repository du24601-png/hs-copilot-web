const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
let api = {};
try { api = require('../ruling-knowledge.js'); } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ruling_source(source_id TEXT PRIMARY KEY,source_sha256 TEXT);
    INSERT INTO ruling_source VALUES('test','v1');
    CREATE TABLE ruling_case(case_id TEXT PRIMARY KEY,source_id TEXT,decision_no TEXT,product_name_cn TEXT,
      product_name_en TEXT,product_description TEXT,classification_decision TEXT,rule_basis TEXT,
      hs_code_original TEXT,historical_code TEXT,heading_4 TEXT,subheading_6 TEXT,code_level TEXT,
      announcement_no TEXT,publish_date TEXT,effective_date TEXT,validity_status TEXT,
      source_file TEXT,content_source_url TEXT,official_notice_url TEXT,knowledge_status TEXT);
    CREATE TABLE ruling_code_map(case_id TEXT,code TEXT,tariff_year INTEGER,match_method TEXT,review_status TEXT);
    CREATE TABLE hs_code(code TEXT PRIMARY KEY,name TEXT);
    CREATE VIRTUAL TABLE ruling_case_fts USING fts5(case_id UNINDEXED,source_id UNINDEXED,product_name,
      product_description,classification_decision,rule_basis,tokenize='trigram');
  `);
  function add(id, name, description, code, decision = '按商品实际加工状态判断。') {
    db.prepare(`INSERT INTO ruling_case VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,'test',id,name,null,description,decision,'归类总规则一',code.slice(0,8),code.slice(0,8),code.slice(0,4),code.slice(0,6),'8位',
      '测试公告',null,null,'未在所附2025失效清单中','C:/private/source.docx',null,'https://example.com/notice...', '可入库');
    db.prepare('INSERT OR IGNORE INTO hs_code VALUES(?,?)').run(code,name);
    db.prepare('INSERT INTO ruling_code_map VALUES(?,?,2026,?,?)').run(id,code,'prefix','pending');
    db.prepare('INSERT INTO ruling_case_fts VALUES(?,?,?,?,?,?)').run(id,'test',name,description,decision,'归类总规则一');
  }
  add('fired','预烧制牙科用氧化锆块','氧化锆，经1040℃高温预烧，用于制作假牙。','6914900000');
  add('unfired','未烧制牙科用氧化锆块','氧化锆，冷压成型，未经高温烧制，用于制作假牙。','3824999999');
  add('tea','茶','发酵的茶。','0902300000');
  add('glass','玻璃淋浴房','单边金属附件，其余为钢化玻璃门。','7020009990');
  add('steel','玻璃淋浴房','全不锈钢框架构成主要结构。','7308300000');
  add('scope-only','工业化学混合物','具有其他工业用途。','3824999000');
  return { db, add };
}

test('ruling repository API exists and missing schema degrades without exception', () => {
  assert.equal(typeof api.createRulingRepository, 'function');
  const db = new DatabaseSync(':memory:');
  const repo = api.createRulingRepository(db);
  assert.equal(repo.available, false);
  assert.equal(repo.query('商品', {}, []).status, 'unavailable');
  db.close();
});

test('rulings retrieve text across wrong headings and preserve opposite processing examples', () => {
  assert.equal(typeof api.createRulingRepository, 'function');
  const { db } = fixture();
  const context = api.createRulingRepository(db).query('牙科氧化锆块，未经高温烧制', {
    core_product: '氧化锆块', search_terms: ['氧化锆','牙科'], possible_headings: ['3824']
  }, [{ code: '3824999000' }]);
  assert.equal(context.cases.some(c => c.caseId === 'fired'), true);
  assert.equal(context.cases.some(c => c.caseId === 'unfired'), true);
  assert.equal(context.expansionCodes.includes('6914900000'), true);
  assert.equal(context.expansionCodes.includes('3824999999'), true);
  assert.equal(context.expansionCodes.includes('0902300000'), false);
  assert.ok(context.promptText.length <= 6000);
  assert.ok(context.cases.length <= 6);
  assert.equal(context.cases.find(c => c.caseId === 'unfired').mappingStatus, 'pending');
  db.close();
});

test('two-character terms work and scope-only matches cannot inject candidates', () => {
  assert.equal(typeof api.createRulingRepository, 'function');
  const { db } = fixture();
  const repo = api.createRulingRepository(db);
  const text = repo.query('玻璃制品', {search_terms:['玻璃']}, []);
  assert.equal(text.cases.some(c => c.caseId === 'glass'), true);
  assert.equal(text.cases.some(c => c.caseId === 'steel'), true);
  const scope = repo.query('完全无关的词xyz', {}, [{code:'3824990000'}]);
  assert.ok(scope.cases.length > 0);
  assert.deepEqual(scope.expansionCodes, []);
  assert.doesNotThrow(() => repo.query('" OR * % _', {search_terms:['" OR *','%%']}, []));
  db.close();
});

test('only prompt-included IDs can be cited and raw metadata comes from database', () => {
  assert.equal(typeof api.createRulingRepository, 'function');
  const { db } = fixture();
  const context = api.createRulingRepository(db).query('氧化锆', {search_terms:['氧化锆']}, []);
  const assessments = api.sanitizeCaseAssessments([
    {case_id:'fired',relation:'supports',matched_facts:['氧化锆'],differing_facts:[],explanation:'适用性分析',decision_no:'FAKE'},
    {case_id:'invented',relation:'supports'},
    {case_id:'unfired',relation:'arbitrary'}
  ], context.allowedCaseIds);
  assert.equal(assessments.length, 1);
  const refs = api.publicCaseReferences(context, assessments);
  assert.equal(refs[0].decisionNo, 'fired');
  assert.equal(refs[0].sourceFile, 'source.docx');
  assert.equal(refs[0].sourceUrl, null);
  assert.equal(refs[0].publishDate, null);
  assert.equal(refs[0].analysis.explanation, '适用性分析');
  assert.equal(api.safeSourceUrl('javascript:alert(1)'), null);
  assert.equal(api.safeSourceUrl('https://example.com/notice'), 'https://example.com/notice');
  db.close();
});

test('English descriptions use words, not incidental two-letter fragments', () => {
  const {db,add}=fixture();
  add('english','material','material for industrial use','3824999001');
  const repo=api.createRulingRepository(db);
  assert.deepEqual(repo.query('Qzxvvnevermatch',{},[]).expansionCodes,[]);
  assert.ok(repo.query('material',{},[]).expansionCodes.includes('3824999001'));
  db.close();
});

test('budgeted-out cases cannot be cited; expansion is capped at 20 and skips absent current codes', () => {
  assert.equal(typeof api.createRulingRepository, 'function');
  const { db, add } = fixture();
  for (let i=0;i<10;i++) add('extra'+i,'氧化锆制品','氧化锆牙科材料', '691490'+String(i).padStart(4,'0'));
  for (let i=0;i<40;i++) {
    const code = '382499'+String(i).padStart(4,'0');
    db.prepare('INSERT OR IGNORE INTO hs_code VALUES(?,?)').run(code,'氧化锆制剂');
    db.prepare('INSERT INTO ruling_code_map VALUES(?,?,2026,?,?)').run('unfired',code,'prefix','pending');
  }
  db.prepare('INSERT INTO ruling_code_map VALUES(?,?,2026,?,?)').run('unfired','9999999999','prefix','pending');
  const repo = api.createRulingRepository(db);
  const context = repo.query('氧化锆', {core_product:'未烧制牙科用氧化锆块',search_terms:['氧化锆']}, []);
  assert.ok(context.expansionCodes.length <= 20);
  assert.equal(context.expansionCodes.includes('9999999999'), false);
  assert.equal(context.expansionTruncated, true);
  const small = repo.query('氧化锆', {search_terms:['氧化锆']}, [], {maxChars:80});
  assert.ok(small.promptText.length <= 80);
  assert.deepEqual(small.allowedCaseIds, []);
  assert.deepEqual(api.publicCaseReferences(small, [{caseId:'fired'}]), []);
  assert.equal(context.allowedCaseIds.every(id=>context.promptText.includes(id)), true);
  db.close();
});

// —— 特征匹配模式(ruling_case_feature 存在时,按“商品本质相似度”而非字面召回)——
function fixtureWithFeatures() {
  const { db, add } = fixture();
  db.exec(`CREATE TABLE ruling_case_feature(case_id TEXT PRIMARY KEY,category TEXT,sub_category TEXT,
    core_product TEXT,materials TEXT,function TEXT,structure TEXT,usage TEXT)`);
  const feat = (id, category, sub_category, core_product, materials, fn, structure, usage) =>
    db.prepare('INSERT INTO ruling_case_feature VALUES(?,?,?,?,?,?,?,?)')
      .run(id, category, sub_category, core_product, JSON.stringify(materials), fn, structure, usage);
  feat('fired','玻璃陶瓷制品','医疗检测','氧化锆块',['氧化锆'],'牙科修复材料','预烧块状','制作假牙');
  feat('unfired','化学制品','医疗检测','氧化锆块',['氧化锆'],'牙科修复材料','冷压成型','制作假牙');
  feat('glass','家具家居','金属制品','玻璃淋浴房',['钢化玻璃','不锈钢'],'','玻璃门和不锈钢框架','淋浴空间');
  feat('steel','金属制品','','钢铁淋浴房',['不锈钢'],'','全不锈钢框架','淋浴空间');
  feat('tea','食品加工','','茶',[''],'','发酵叶','饮用');
  feat('scope-only','化学制品','','工业化学混合物',[''],'工业用途','','工业');
  return { db, add, feat };
}

test('特征模式:本质不符的判例被过滤——塑料水壶不召回玻璃淋浴房/钢铁结构,且不补码(017退化根因)', () => {
  const { db } = fixtureWithFeatures();
  const repo = api.createRulingRepository(db);
  // query 含“玻璃”确保字面粗召回能命中 glass/steel,但商品本质是塑料容器、范畴为容器包装
  const ctx = repo.query('玻璃运动水壶', {
    category:'容器包装', core_product:'运动水壶', materials:['塑料'],
    function:'盛装饮用水', usage:'运动户外饮水', structure:'带盖中空容器', search_terms:['玻璃','水壶']
  }, []);
  assert.equal(ctx.cases.some(c => c.caseId === 'glass'), false);
  assert.equal(ctx.cases.some(c => c.caseId === 'steel'), false);
  assert.deepEqual(ctx.expansionCodes, []);   // 无本质相似判例 → 不补码,候选池不被污染
  db.close();
});

test('特征模式:范畴+品名一致则召回相似判例并补充其现行候选码', () => {
  const { db } = fixtureWithFeatures();
  const repo = api.createRulingRepository(db);
  const ctx = repo.query('牙科氧化锆块', {
    category:'玻璃陶瓷制品', core_product:'氧化锆块', materials:['氧化锆'],
    function:'牙科修复', usage:'制作假牙', search_terms:['氧化锆','牙科']
  }, [{ code:'3824999000' }]);
  assert.equal(ctx.cases.some(c => c.caseId === 'fired'), true);
  assert.equal(ctx.status, 'ready');
  assert.equal(ctx.expansionCodes.includes('6914900000'), true); // 相似判例的现行候选被补入
  db.close();
});

test('特征模式:主范畴不同则不召回——医疗检测商品不匹配玻璃陶瓷判例(即使次范畴相同)', () => {
  const { db } = fixtureWithFeatures();
  const repo = api.createRulingRepository(db);
  // 商品主范畴=医疗检测,fired 主范畴=玻璃陶瓷制品(次才是医疗检测)→主范畴不同→不召回、不补码
  const ctx = repo.query('牙科氧化锆块', {
    category:'医疗检测', core_product:'氧化锆块', materials:['氧化锆'],
    function:'牙科修复', usage:'制作假牙', search_terms:['氧化锆']
  }, [{ code:'3824999000' }]);
  assert.equal(ctx.cases.some(c => c.caseId === 'fired'), false);
  assert.deepEqual(ctx.expansionCodes, []);
  db.close();
});

test('特征模式:商品缺少 category 时保守不召回判例', () => {
  const { db } = fixtureWithFeatures();
  const repo = api.createRulingRepository(db);
  // profile 无 category(LLM①降级/兜底):范畴未知则不引入判例,避免无依据干扰
  const ctx = repo.query('氧化锆块', {
    core_product:'氧化锆块', materials:[], function:'', usage:'', structure:'', search_terms:['氧化锆']
  }, []);
  assert.equal(ctx.cases.length, 0);
  db.close();
});
