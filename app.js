/* HS Copilot 前端逻辑 — 视图路由 + 历史记录(localStorage) + 数据层(/api 读取 SQLite) + LLM 动态归类 */
(function () {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const confirmLogic = window.HSConfirm;
  const decisionLogic = window.HSDecision;

  /* ================= 数据层 ================= */
  // 所有编码/税率/申报要素数值只来自 /api（SQLite 只读），界面层不编造数值。
  async function apiHs(code) {
    const r = await fetch('/api/hs/' + encodeURIComponent(code));
    const d = await r.json();
    if (!r.ok) throw d;
    return d;
  }
  async function apiSearch(q) {
    const r = await fetch('/api/search?q=' + encodeURIComponent(q));
    const d = await r.json();
    if (!r.ok) throw d;
    return d.results || [];
  }
  const pct = v => (v == null ? '—' : Math.round(v * 100) + '%');
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtCode = d => String(d).replace(/(\d{4})(\d{2})(\d{2})(\d{2})/, '$1.$2.$3.$4');
  async function apiClassify(query) {
    const r = await fetch('/api/classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
    const d = await r.json();
    if (!r.ok) throw d;
    return d;
  }
  async function apiDecide(payload) {
    const r = await fetch('/api/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const d = await r.json();
    if (!r.ok) throw d;
    return d;
  }

  /* ================= Toast ================= */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  /* ================= 视图路由 ================= */
  const VIEWS = ['home', 'confirm', 'decision', 'declare', 'history'];
  let twToken = 0; // 打字机会话号：切页时作废旧任务
  function go(name) {
    // 离开页面时才作废打字机；进入 decision 页时不能动，否则会杀掉刚启动的打字任务
    if (name !== 'decision') twToken++;
    VIEWS.forEach(v => $('#view-' + v).classList.toggle('hidden', v !== name));
    window.scrollTo(0, 0);
  }
  $('#logoHome').addEventListener('click', () => go('home'));
  $('#navHistory').addEventListener('click', () => {
    renderFullHistory();
    go('history');
  });
  $('#navHelp').addEventListener('click', () => openFaq());

  /* ================= 历史记录（localStorage） ================= */
  const HKEY = 'hs_copilot_history_v1';
  const SEED_FLAG = 'hs_copilot_seeded_v1';

  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HKEY)) || []; } catch { return []; }
  }
  function saveHistory(list) { localStorage.setItem(HKEY, JSON.stringify(list)); }
  function upsertRecord(rec) {
    if (!decisionLogic.shouldPersistRecord(rec)) return;
    const list = loadHistory();
    const i = list.findIndex(r => r.id === rec.id);
    if (i >= 0) list[i] = rec; else list.unshift(rec);
    saveHistory(list.slice(0, 50));
    renderRecent();
  }
  function relTime(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 172800) return '昨天';
    return Math.floor(s / 86400) + ' 天前';
  }

  // 首次进入：写入 3 条演示记录（与效果图一致），其中两条走真实数据库核验
  if (!localStorage.getItem(SEED_FLAG)) {
    const now = Date.now();
    saveHistory([
      { id: 'seed-stylus', mode: 'classify', input: '铝合金 iPad 触控笔', name: '铝合金触控笔', code: '9608992000', codeDisplay: '9608.99.20.00', status: '已完成', ts: now - 12 * 60e3 },
      { id: 'seed-lamp', mode: 'verify', input: '9405210090', name: 'LED 台灯', code: '9405210090', codeDisplay: '9405.21.00.90', status: '待确认', ts: now - 86400e3 },
      { id: 'seed-bottle', mode: 'verify', input: '9617001900', name: '不锈钢真空保温杯', code: '9617001900', codeDisplay: '9617.00.19.00', status: '已完成', ts: now - 2 * 86400e3 }
    ]);
    localStorage.setItem(SEED_FLAG, '1');
  }

  // 历史行模板：首页“最近查询”与“全部历史记录页”共用同一渲染
  function historyRowHtml(r) {
    return `<a class="tr" data-id="${r.id}">
        <span class="t-name">${esc(r.name)}</span>
        <span class="t-code">${esc(r.codeDisplay)}</span>
        <span><i class="dot ${r.status === '已完成' ? 'ok' : 'wait'}"></i>${r.status}</span>
        <span class="t-time">${relTime(r.ts)}</span>
        <span class="t-arrow">›</span>
      </a>`;
  }
  function renderRecent() {
    const list = loadHistory();
    const box = $('#recentBody');
    if (!list.length) {
      box.innerHTML = '<div class="recent-empty">还没有查询记录，从上方输入商品开始</div>';
      return;
    }
    box.innerHTML = list.slice(0, 6).map(historyRowHtml).join('');
  }
  // 全部历史记录页：展示所有已保存记录（不止首页最近 6 条）
  function renderFullHistory() {
    const box = $('#historyBody');
    if (!box) return;
    const list = loadHistory();
    box.innerHTML = list.length
      ? list.map(historyRowHtml).join('')
      : '<div class="recent-empty">还没有查询记录，从首页输入商品或编码开始</div>';
  }
  // 首页最近区与全部历史页共用同一套点击重放逻辑
  function bindHistoryOpen(sel) {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('click', e => {
      const row = e.target.closest('.tr[data-id]');
      if (!row) return;
      const rec = loadHistory().find(r => r.id === row.dataset.id);
      if (rec) openRecord(rec);
    });
  }
  bindHistoryOpen('#recentBody');
  bindHistoryOpen('#historyBody');
  $('#clearHistory').addEventListener('click', () => {
    if (!loadHistory().length) { toast('历史记录已经是空的'); return; }
    saveHistory([]);
    renderFullHistory();
    renderRecent();
    toast('已清空全部历史记录');
  });

  async function openRecord(rec) {
    if (rec.mode === 'classify') {
      session = rec;
      const storedResult = decisionLogic.getStoredClassificationResult(rec);
      if (storedResult) {
        hsData = storedResult.p2.hs;
        showDecisionLLM(storedResult, true);
      } else {
        hsData = rec.code ? await apiHs(rec.code).catch(() => null) : null;
        if (!hsData) {
          toast('这条历史记录未保存完整结果，请重新查询');
          $('#homeInput').value = rec.input || rec.name || '';
          go('home');
          return;
        }
        const legacyResult = decisionLogic.buildLegacyClassificationResult(rec, hsData);
        showDecisionLLM(legacyResult, true);
        toast('这条旧记录未保存完整理由，当前仅展示真实编码核验信息');
      }
      go('decision');
    } else {
      const d = await apiHs(rec.code).catch(() => null);
      if (!d) { toast('该编码在当前数据版本中查询失败'); return; }
      session = rec;
      hsData = d;
      showDecisionVerify(d);
      go('decision');
    }
  }

  /* ================= Page 1 · 首页 ================= */
  let session = null;  // 当前会话记录
  let hsData = null;   // 当前编码的数据库记录
  let dyn = null;      // 动态归类会话 {p1, qi, answers[]}

  async function submitHome() {
    const v = $('#homeInput').value.trim();
    if (!v) { toast('请先描述商品或输入 HS 编码'); $('#homeInput').focus(); return; }
    $('#homeInput').value = '';
    // 识别意图：包含 10 位数字 → 编码核验；否则 → 商品归类
    const digits = (v.match(/\d[\d\s.]{7,}\d/) || [''])[0].replace(/\D/g, '');
    if (digits.length === 10) return verifyFlow(v, digits);
    return classifyFlow(v);
  }
  $('#homeSend').addEventListener('click', submitHome);
  $('#homeInput').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitHome(); }
  });
  $$('.chip').forEach(c => c.addEventListener('click', () => {
    $('#homeInput').value = c.dataset.q;
    submitHome();
  }));
  $('#attachBtn').addEventListener('click', () => toast('支持上传图片 / 文件（演示环境未开启）'));

  /* ---------- 流程 A：编码核验（纯数据库，不经 LLM） ---------- */
  async function verifyFlow(input, code) {
    session = {
      id: 'r' + Date.now(), mode: 'verify', input,
      name: input, code, codeDisplay: code,
      status: '待确认', ts: Date.now()
    };
    const d = await apiHs(code).catch(err => err);
    if (d.error) {
      // 编码不存在：拒答 + 给相近编码建议（不硬给答案）
      const near = await apiSearch(code.slice(0, 6)).catch(() => []);
      toast(d.error + '（2026 版税则）' + (near.length ? '，相近编码：' + near.slice(0, 2).map(n => n.codeDisplay).join('、') : ''));
      return;
    }
    hsData = d;
    session.name = d.name;
    session.codeDisplay = d.codeDisplay;
    session.status = '已完成';
    upsertRecord(session);
    showDecisionVerify(d);
    go('decision');
  }

  /* ---------- 流程 B：商品归类（数据库检索候选 → LLM 提问 → 用户确认 → LLM 定论） ---------- */
  // 大模型不可用时的静态兜底（仅触控笔演示场景）
  const STYLUS_P1 = {
    productName: '铝合金触控笔',
    knownAttrs: [
      { key: '用途', value: '平板触控' },
      { key: '材质', value: '铝合金' }
    ],
    questions: [{
      attr: '无线通信',
      question: '该触控笔是否包含无线通信功能？',
      hint: '例如蓝牙、Wi-Fi、NFC',
      options: ['不包含，仅用于电容触控', '包含无线通信模块', '不确定'],
      why: '无线通信功能可能改变所属品目',
      whyDetail: '无线通信能力可能改变所属品目，当前主要用于区分 9608（笔及类似品）与 8517（通信设备），两者税率与监管条件不同。'
    }],
    provisionalCode: '9608992000',
    provisional: null,
    candidates: [],
    confidence: 'medium'
  };

  async function classifyFlow(input) {
    session = {
      id: 'r' + Date.now(), mode: 'classify', input,
      name: input.slice(0, 20), code: '', codeDisplay: '分析中…',
      status: '待确认', ts: Date.now()
    };
    dyn = null;
    renderConfirmLoading(input);
    go('confirm');
    try {
      const p1 = await apiClassify(input);
      if (p1.refuse) {
        hideProgress();
        toast(p1.refuseReason || '暂时无法归类，请补充更具体的商品描述');
        go('home');
        return;
      }
      dyn = { p1, qi: 0, answers: [], remainingCandidates: (p1.candidates || []).slice(), candidateHistory: [], freeTextDrafts: [] };
      if (p1.degraded) toast('AI 规划失败，已降级为字面检索：候选可能偏差较大，建议缩短描述后重试');
      session.name = p1.productName || input.slice(0, 20);
      if (p1.provisional) {
        session.code = p1.provisionalCode;
        session.codeDisplay = p1.provisional.codeDisplay;
      }
      renderConfirmDynamic();
    } catch (e) {
      classifyFallback(input, e);
    }
  }

  function classifyFallback(input, e) {
    if (!/触控笔|stylus/i.test(input)) {
      hideProgress();
      toast('大模型服务暂时不可用：' + ((e && (e.error || e.message)) || '请稍后再试'));
      go('home');
      return;
    }
    toast('大模型暂不可用，已切换为演示数据');
    dyn = { p1: STYLUS_P1, qi: 0, answers: [], remainingCandidates: [], candidateHistory: [], freeTextDrafts: [] };
    session.name = STYLUS_P1.productName;
    session.code = STYLUS_P1.provisionalCode;
    session.codeDisplay = '9608.99.20.00';
    upsertRecord(session);
    renderConfirmDynamic();
  }

  /* ================= Page 2 · 关键确认（动态渲染） ================= */
  const nextBtn = $('#confirmNext');
  let autoTimer = null;

  /* ---------- AI 思考进度（等待大模型时可见） ---------- */
  const P1_STEPS = ['检索税则数据库，匹配候选编码', '分析商品属性，识别归类关键要素', '生成需要你确认的问题'];
  const P2_STEPS = ['综合确认信息，比对候选编码', '生成归类理由与官方依据', '校验税率与申报要素'];
  let progressTimers = [];

  function toggleConfirmContent(show) {
    ['.q-kicker', '#qTitle', '#qSub', '#qOptions', '#whyBox', '#whyDetail', '.q-foot']
      .forEach(sel => { const el = $(sel); if (el) el.classList.toggle('hidden', !show); });
  }

  function showProgress(steps, title) {
    progressTimers.forEach(clearTimeout); progressTimers = [];
    const box = $('#aiProgress');
    box.innerHTML = `
      <div class="ai-prog-head"><span class="ai-pulse"></span>${esc(title || 'HS Copilot 正在分析')}</div>
      ${steps.map(s => `
        <div class="ai-step">
          <span class="ai-ico"></span>
          <span class="ai-label">${esc(s)}</span>
        </div>`).join('')}`;
    box.classList.remove('hidden');
    toggleConfirmContent(false);
    const els = $$('#aiProgress .ai-step');
    const activate = i => els.forEach((el, j) => {
      el.classList.toggle('done', j < i);
      el.classList.toggle('active', j === i);
    });
    activate(0);
    // 前面几步按节奏推进，最后一步保持转圈，等接口真实返回
    for (let i = 1; i < els.length; i++) {
      progressTimers.push(setTimeout(() => activate(i), i * 1500));
    }
  }

  function hideProgress() {
    progressTimers.forEach(clearTimeout); progressTimers = [];
    $('#aiProgress').classList.add('hidden');
    toggleConfirmContent(true);
  }

  function renderConfirmLoading(input) {
    $('#cfProdName').textContent = input.slice(0, 30);
    $('#cfProdCode').textContent = '分析中…';
    // 左栏骨架屏
    $('#attrList').innerHTML = '<li><span class="sk-bar" style="width:56px"></span><b class="sk-bar" style="width:110px"></b></li>'.repeat(4);
    nextBtn.disabled = true;
    nextBtn.textContent = '继续';
    showProgress(P1_STEPS);
  }

  function renderConfirmDynamic() {
    const p1 = dyn.p1;
    $('#cfProdName').textContent = p1.productName || session.input;
    $('#cfProdCode').textContent = p1.provisional ? p1.provisional.codeDisplay : '待确认';
    const rows = p1.knownAttrs.map(a =>
      `<li><span>${esc(a.key)}</span><b>${esc(a.value)}</b></li>`);
    p1.questions.forEach((q, i) => {
      rows.push(`<li><span>${esc(q.attr)}</span><b class="pending" id="dynAttr${i}">待确认</b></li>`);
    });
    $('#attrList').innerHTML = rows.join('');
    // 没有问题要问：直接进入定论阶段（进度条换文案继续转）
    if (!p1.questions.length) { showProgress(P2_STEPS, '信息已足够，正在生成归类建议'); finishConfirm(); return; }
    hideProgress();
    renderQuestion(0);
  }

  function renderQuestion(i) {
    dyn.qi = i;
    const p1 = dyn.p1;
    const q = p1.questions[i];
    dyn.candidateHistory[i] = dyn.remainingCandidates.slice();
    if (dyn.freeTextDrafts[i] === undefined) dyn.freeTextDrafts[i] = '';
    $('#qCount').textContent = p1.questions.length - i;
    $('#qTitle').textContent = q.question;
    $('#qSub').textContent = q.hint || '请选择最符合实际情况的一项';
    $('#qOptions').innerHTML = q.options.map((rawOption, j) => {
      const option = confirmLogic.normalizeOption(rawOption);
      return `<label class="q-opt"><input type="radio" name="dynq" value="${j}"><span class="q-radio"></span>${esc(option.label)}</label>`;
    }).join('') + '<div class="q-free-text hidden" id="qFreeTextWrap"><textarea id="qFreeText" maxlength="200" aria-label="补充说明"></textarea></div>';
    $('#qFreeText').placeholder = q.hintPlaceholder || q.hint || '例如：请描述实际材质、结构或用途';
    $('#whyText').innerHTML = '<b>为什么要问？</b>' + esc(q.why || '该属性可能影响归类结果');
    $('#whyDetail').textContent = q.whyDetail || q.why || '';
    $('#whyDetail').classList.add('hidden');
    $('#whyBox').classList.remove('hidden', 'open');
    $('.q-foot-note').textContent = '选择后可自动进入下一步';
    nextBtn.disabled = true;
    nextBtn.textContent = i === p1.questions.length - 1 ? '查看归类建议' : '继续';
  }

  // 选项点击（事件委托：选项是动态生成的）
  $('#qOptions').addEventListener('click', e => {
    const opt = e.target.closest('.q-opt');
    if (!opt || !dyn) return;
    clearTimeout(autoTimer);
    const freeTextField = $('#qFreeText');
    if (freeTextField) dyn.freeTextDrafts[dyn.qi] = freeTextField.value.slice(0, 200);
    $$('#qOptions .q-opt').forEach(o => o.classList.remove('sel'));
    opt.classList.add('sel');
    const q = dyn.p1.questions[dyn.qi];
    const option = confirmLogic.normalizeOption(q.options[Number(opt.querySelector('input').value)]);
    const answer = option.label;
    const freeText = confirmLogic.freeTextForOption(option, dyn.freeTextDrafts[dyn.qi]);
    dyn.answers[dyn.qi] = { attr: q.attr, answer, freeText };
    dyn.remainingCandidates = confirmLogic.applyAnswer(dyn.candidateHistory[dyn.qi] || [], option);
    const w = $('#dynAttr' + dyn.qi);
    if (w) {
      w.textContent = answer;
      w.classList.toggle('pending', confirmLogic.isUnknownAnswer(answer));
    }
    const needsFreeText = confirmLogic.isFreeTextAnswer(answer);
    $('#qFreeTextWrap').classList.toggle('hidden', !needsFreeText);
    $('.q-foot-note').textContent = needsFreeText ? '可补充说明，也可直接继续' : '选择后可自动进入下一步';
    nextBtn.disabled = false;
    if (needsFreeText) {
      $('#qFreeText').value = freeText;
      $('#qFreeText').focus();
    }
    else autoTimer = setTimeout(stepConfirm, 600);
  });

  $('#qOptions').addEventListener('input', e => {
    if (!dyn || e.target.id !== 'qFreeText') return;
    dyn.freeTextDrafts[dyn.qi] = e.target.value.slice(0, 200);
    const answer = dyn.answers[dyn.qi];
    if (answer) answer.freeText = confirmLogic.freeTextForOption(answer, dyn.freeTextDrafts[dyn.qi]);
  });

  function stepConfirm() {
    clearTimeout(autoTimer);
    if (!dyn) return;
    const answers = dyn.answers.filter(Boolean);
    const stop = confirmLogic.shouldStopConfirm({
      remaining: dyn.remainingCandidates,
      answers,
      answeredCount: answers.length
    });
    if (!stop && dyn.qi < dyn.p1.questions.length - 1) {
      renderQuestion(dyn.qi + 1);
    } else {
      // 最后一题答完：切换为「生成归类建议」进度
      showProgress(P2_STEPS, '信息已确认，正在生成归类建议');
      finishConfirm();
    }
  }
  nextBtn.addEventListener('click', stepConfirm);

  // 申报要素预填：不清楚的答案跳过；“以上都不是”仅使用用户实际补充的文本。
  function buildPrefill(elements, knownAttrs, answers) {
    const map = {};
    const src = [];
    (knownAttrs || []).forEach(a => src.push(a));
    (answers || []).forEach(a => {
      if (!a || confirmLogic.isUnknownAnswer(a)) return;
      const value = confirmLogic.isFreeTextAnswer(a) ? String(a.freeText || '').trim() : a.answer;
      if (value) src.push({ key: a.attr, value });
    });
    (elements || []).forEach(el => {
      const core = el.replace(/（.*?）/g, '');
      for (const s of src) {
        if (el === s.key || core === s.key) { map[el] = s.value; return; }
      }
      for (const s of src) {
        if (s.key.length >= 3 && (el.includes(s.key) || core.includes(s.key))) { map[el] = s.value; return; }
      }
    });
    return map;
  }

  async function finishConfirm() {
    if (!dyn) return;
    const p1 = dyn.p1;
    const answers = dyn.answers.filter(Boolean);
    // 静态兜底（演示数据）：走旧展示逻辑
    if (p1 === STYLUS_P1) {
      hsData = await apiHs('9608992000').catch(() => null);
      if (session) {
        session.status = '已完成';
        session.prefill = PREFILL;
        session.result = {
          p1,
          p2: {
            selectedCode: '9608992000',
            hs: hsData,
            reasons: [
              '主要功能：用于平板触控输入',
              '通信功能：不包含蓝牙、Wi-Fi 等无线通信模块',
              '商品形态：为完整笔状商品，而不是替换零件'
            ],
            counterfactuals: [
              { condition: '如果包含无线通信模块', advice: '建议重新检查 8517' },
              { condition: '如果只是替换笔尖', advice: '需要重新判断零件编码' }
            ],
            alternatives: [
              { code: '9608100000', codeDisplay: '9608.10.00.00', whyNot: '该品目要求书写装置' }
            ],
            unconfirmed: [],
            legalReferences: [],
            complianceNotices: []
          },
          answers
        };
        upsertRecord(session);
      }
      hideProgress();
      showDecisionLLM(session.result);
      go('decision');
      return;
    }
    try {
      const p2 = await apiDecide({ query: session.input, knownAttrs: p1.knownAttrs, answers });
      if (p2.refuse) {
        hideProgress();
        toast(p2.refuseReason || '候选编码均不匹配，建议人工归类');
        go('home');
        return;
      }
      hsData = p2.hs;
      session.code = p2.selectedCode;
      session.codeDisplay = hsData ? hsData.codeDisplay : fmtCode(p2.selectedCode);
      session.name = p1.productName || session.name;
      session.status = '已完成';
      session.result = { p1, p2, answers };
      session.prefill = buildPrefill(hsData ? hsData.declareElements : [], p1.knownAttrs, answers);
      upsertRecord(session);
      hideProgress();
      showDecisionLLM(session.result);
      go('decision');
    } catch (e) {
      hideProgress();
      toast('大模型调用失败：' + ((e && (e.error || e.message)) || '请稍后再试'));
      go('home');
    }
  }

  $('#whyBox').addEventListener('click', () => {
    $('#whyBox').classList.toggle('open');
    $('#whyDetail').classList.toggle('hidden');
  });
  $('#editProduct').addEventListener('click', () => go('home'));

  /* ================= Page 3 · 归类建议 / 编码核验 ================= */
  const CF_ICONS = [
    '<svg viewBox="0 0 24 24"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><circle cx="12" cy="19.5" r="1"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M4 20l1.2-3.2L16.5 5.5a2.1 2.1 0 0 1 3 3L8.2 19.8 4 20z"/></svg>'
  ];

  function clearUnconfirmed() {
    $('#unconfirmedText').textContent = '';
    $('#unconfirmedBox').classList.add('hidden');
  }

  function setDecisionMode(mode) {
    const isClassify = mode === 'classify';
    ['secCf', 'cfList', 'altBox'].forEach(id => $('#' + id).classList.toggle('hidden', !isClassify));
    $('#evClassify').classList.toggle('hidden', !isClassify);
    $('#evVerify').classList.toggle('hidden', isClassify);
    $('#viewPath').style.display = isClassify ? '' : 'none';
    if (!isClassify) {
      clearUnconfirmed();
      // Direct code verification has no product session or historical-case claim.
      ['secCases', 'caseRefs', 'secAttrs', 'attrRecap', 'secLegal', 'legalRefs', 'evCompliance']
        .forEach(id => $('#' + id).classList.add('hidden'));
    }
  }

  function applyRates(d) {
    if (!d) return;
    $('#rateMfn').textContent = pct(d.rates.mfn);
    $('#rateVat').textContent = pct(d.rates.vat);
    $('#regCond').textContent = d.regConditions.length ? d.regConditions.map(r => r.code).join('') : '无';
    $('#taxDate').textContent = d.dataVersion;
    $('#dataVersion').textContent = d.dataVersion;
    // P0：结果页完整税费（5 种）+ 监管证件名（此前结果页不展示税费/监管）
    const rateList = $('#rateList');
    if (rateList) {
      const rows = [['普通税率', d.rates.general], ['最惠国税率', d.rates.mfn], ['出口税率', d.rates.export], ['消费税', d.rates.excise], ['增值税', d.rates.vat]];
      rateList.innerHTML = rows.map(([k, v]) => `<li><span>${k}</span><b>${pct(v)}</b></li>`).join('');
    }
    const regDetail = $('#regDetail');
    if (regDetail) regDetail.textContent = (d.regConditions && d.regConditions.length)
      ? '监管条件：' + d.regConditions.map(r => r.code + '（' + r.name + '）').join('、')
      : '监管条件：无';
  }

  // P0：结果页背景信息增强——商品属性回溯 + 归类依据原文 + 合规提示（数据 decide 已返回，此前未渲染）
  const RULE_TYPE_LABELS = { gri: '归类总规则', section_note: '类注', chapter_note: '章注', national_subheading_note: '本国子目注释', compliance_notice: '合规提示' };
  function renderDecisionExtras(result) {
    const p1 = (result && result.p1) || {};
    const p2 = (result && result.p2) || {};
    const caseBox = $('#caseRefs'), secCases = $('#secCases');
    if (caseBox && secCases && window.HSRulings) {
      caseBox.innerHTML = window.HSRulings.render(p2);
      caseBox.classList.remove('hidden'); secCases.classList.remove('hidden');
    }
    const attrs = Array.isArray(p1.knownAttrs) ? p1.knownAttrs : [];
    const attrBox = $('#attrRecap'), secAttrs = $('#secAttrs');
    if (attrBox && secAttrs) {
      if (attrs.length) {
        attrBox.innerHTML = attrs.map(a => `<li><span>${esc(a.key)}</span><b>${esc(a.value)}</b></li>`).join('');
        attrBox.classList.remove('hidden'); secAttrs.classList.remove('hidden');
      } else { attrBox.classList.add('hidden'); secAttrs.classList.add('hidden'); }
    }
    // B：归类依据优先展示 codeBasis（本国子目注释 + 章注点名该品目的条款，具体可核验）；
    // 无针对性依据时依次回退 LLM 引用的非 GRI 规则、GRI（通用方法）；都无则诚实提示。
    const basis = Array.isArray(p2.codeBasis) ? p2.codeBasis : [];
    const refs = Array.isArray(p2.legalReferences) ? p2.legalReferences : [];
    let items = basis.map(b => ({ label: b.label, title: b.title, text: b.text, page: b.printPage || b.pdfPage }));
    if (!items.length) items = refs.filter(r => r.ruleType !== 'gri').map(r => ({ label: RULE_TYPE_LABELS[r.ruleType] || r.ruleType, title: r.title, text: r.excerpt, page: r.printPage || r.pdfPage }));
    if (!items.length) items = refs.filter(r => r.ruleType === 'gri').map(r => ({ label: '归类总规则（通用方法）', title: r.title, text: r.excerpt, page: r.printPage || r.pdfPage }));
    const legalBox = $('#legalRefs'), secLegal = $('#secLegal');
    if (legalBox && secLegal) {
      legalBox.innerHTML = items.length
        ? items.map(r => `
          <div class="legal-ref">
            <div class="legal-ref-head"><span class="legal-tag">${esc(r.label || '依据')}</span>${r.title ? `<b>${esc(r.title)}</b>` : ''}</div>
            ${r.text ? `<p class="legal-ref-text">${esc(r.text)}</p>` : ''}
            <div class="legal-ref-src">《中华人民共和国进出口税则（2026）》${r.page ? ' · 第 ' + esc(String(r.page)) + ' 页' : ''}</div>
          </div>`).join('')
        : `<div class="legal-ref"><p class="legal-ref-text">该编码暂无针对性的本国子目注释或章注条款；归类依据为其税目条文与商品名称。</p></div>`;
      legalBox.classList.remove('hidden'); secLegal.classList.remove('hidden');
    }
    const notices = Array.isArray(p2.complianceNotices) ? p2.complianceNotices : [];
    const compBox = $('#evCompliance'), compText = $('#complianceText');
    if (compBox && compText) {
      if (notices.length) {
        compText.innerHTML = notices.map(n => esc(n.text || n.title || '')).join('<br>');
        compBox.classList.remove('hidden');
      } else { compBox.classList.add('hidden'); }
    }
  }

  /* ---------- 打字机流式输出：理由一条条"写"出来 ---------- */
  function typeText(el, text, token, done) {
    // 按墙上时钟计算应显示的字数：后台标签页定时器被节流到 1 秒/次也能按时打完
    const t0 = Date.now();
    const speed = 16; // ms/字
    el.classList.add('typing');
    (function tick() {
      if (token !== twToken) return; // 已切页，作废旧任务
      // 页面不可见（切后台）时定时器会被冻结：直接一次性打完，用户回来时已是完整内容
      const n = document.hidden ? text.length : Math.min(text.length, Math.floor((Date.now() - t0) / speed));
      el.textContent = text.slice(0, n);
      if (n < text.length) setTimeout(tick, 30);
      else { el.classList.remove('typing'); if (done) done(); }
    })();
  }

  // 理由逐条打字，全部打完后执行 onDone（浮现后续板块）
  // instant=true：跳过打字机动画，直接完整呈现（历史记录回放场景）
  function renderReasons(reasons, onDone, instant) {
    const token = ++twToken;
    const box = $('#reasonList');
    box.innerHTML = '';
    const items = reasons.map(r => {
      const m = String(r).match(/^([^：:]{2,12})[：:]([\s\S]+)$/);
      return { dim: m ? m[1] : '', body: m ? m[2].trim() : String(r) };
    });
    if (instant) {
      items.forEach((it, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<i>0${i + 1}</i><div>${it.dim ? `<b>${esc(it.dim)}：</b>` : ''}<span class="tw">${esc(it.body)}</span></div>`;
        box.appendChild(li);
      });
      if (onDone) onDone();
      return;
    }
    let i = 0;
    (function next() {
      if (token !== twToken) return;
      if (i >= items.length) { if (onDone) onDone(); return; }
      const it = items[i];
      const li = document.createElement('li');
      li.className = 'tw-in';
      li.innerHTML = `<i>0${i + 1}</i><div>${it.dim ? `<b>${esc(it.dim)}：</b>` : ''}<span class="tw"></span></div>`;
      box.appendChild(li);
      typeText(li.querySelector('.tw'), it.body, token, () => { i++; next(); });
    })();
  }

  // 归类页后续板块：先压住，理由打完后浮现
  const REVEAL_SELS = ['#unconfirmedBox', '#secCf', '#cfList', '#altBox', '.action-row', '.evidence-rail'];
  let currentDecisionResult = null;
  function holdReveal() {
    REVEAL_SELS.forEach(sel => { const el = $(sel); if (el) { el.classList.remove('reveal-in'); el.classList.add('reveal-wait'); } });
  }
  function doReveal(instant) {
    REVEAL_SELS.forEach((sel, i) => {
      const el = $(sel);
      if (!el) return;
      if (instant) { el.classList.remove('reveal-wait'); el.classList.add('reveal-in'); }
      else setTimeout(() => { el.classList.remove('reveal-wait'); el.classList.add('reveal-in'); }, i * 120);
    });
  }

  // LLM 动态结论
  function showDecisionLLM(result, instant) {
    const p2 = result.p2;
    const d = p2.hs;
    const reasons = Array.isArray(p2.reasons) ? p2.reasons : [];
    const counterfactuals = Array.isArray(p2.counterfactuals) ? p2.counterfactuals : [];
    const alternatives = Array.isArray(p2.alternatives) ? p2.alternatives : [];
    currentDecisionResult = result;
    setDecisionMode('classify');
    $('#decisionTitle').textContent = '归类建议';
    $('#decisionCode').textContent = d ? d.codeDisplay : fmtCode(p2.selectedCode);
    $('#decisionName').textContent = d ? d.name : '';
    // 徽章固定文案：20 例难例实测证明 AI 自评置信度会「自信地错」（候选缺正确答案仍报 high），不再分级展示
    $('#decisionBadge').lastChild.textContent = result.legacy
      ? ' 历史记录 · 仅保留编码'
      : ' 预归类建议 · 需人工复核';
    if (p2.degraded) toast('AI 规划失败，本次为降级检索：结论偏差风险较高，请务必人工复核');
    $('#secWhy').textContent = '为什么推荐这个编码？';
    const unconfirmed = Array.isArray(p2.unconfirmed) ? p2.unconfirmed : [];
    $('#unconfirmedText').textContent = unconfirmed.join('、');
    $('#unconfirmedBox').classList.toggle('hidden', !unconfirmed.length);
    if (instant) {
      // 历史记录回放：不压住、不打字，一次性完整呈现
      REVEAL_SELS.forEach(sel => { const el = $(sel); if (el) el.classList.remove('reveal-wait', 'reveal-in'); });
      renderReasons(reasons.length ? reasons : ['综合商品属性与税则条文比对得出'], null, true);
    } else {
      holdReveal();
      renderReasons(reasons.length ? reasons : ['综合商品属性与税则条文比对得出'], () => doReveal(false));
    }

    // 反事实：什么情况下结果会改变
    if (counterfactuals.length) {
      $('#cfList').innerHTML = counterfactuals.map((c, i) => `
        <li>
          ${CF_ICONS[i % CF_ICONS.length]}
          <span>${esc(c.condition)}</span>
          <a class="link-blue cf-advice" data-advice="${esc(c.advice)}">${esc(c.advice)}</a>
        </li>`).join('');
    } else {
      $('#secCf').classList.add('hidden');
      $('#cfList').classList.add('hidden');
    }

    // 备选编码
    const alt = alternatives[0];
    if (alt) {
      $('#altBox').classList.remove('hidden');
      $('#altCode').textContent = alt.codeDisplay || fmtCode(alt.code);
      $('#altWhy').textContent = '未选择原因：' + (alt.whyNot || '与本商品特征不符');
    } else {
      $('#altBox').classList.add('hidden');
    }

    // 依据栏（数值全部来自数据库行）
    if (d) {
      $('#ev1t').textContent = '海关税则 · ' + d.code.slice(0, 2) + '.' + d.code.slice(2, 4);
      $('#ev1p').textContent = d.note || d.name;
      $('#ev2t').textContent = '所属章节 · 第 ' + d.code.slice(0, 2) + ' 章';
      $('#ev2p').textContent = (d.chapter || '—') + '；申报要素共 ' + d.declareElements.length + ' 项';
      if (result.legacy) {
        $('#ev3t').textContent = '历史记录说明';
        $('#ev3p').textContent = '旧记录未保存当时的归类理由和排除候选，因此不再用演示模板补齐。';
      } else if (alt) {
        $('#ev3t').textContent = '排除候选 · ' + (alt.codeDisplay || fmtCode(alt.code));
        $('#ev3p').textContent = alt.whyNot || '该候选编码与本商品已确认的属性不符。';
      } else {
        $('#ev3t').textContent = '排除其他候选';
        $('#ev3p').textContent = '其余候选编码与已确认的商品属性不符。';
      }
      applyRates(d);
    }
    renderDecisionExtras(result);
  }

  function showDecisionVerify(d) {
    currentDecisionResult = null;
    setDecisionMode('verify');
    // 核验是纯数据库查询，应即时呈现：清除打字机阶段的压住状态
    REVEAL_SELS.forEach(sel => { const el = $(sel); if (el) el.classList.remove('reveal-wait', 'reveal-in'); });
    $('#decisionTitle').textContent = '编码核验';
    $('#decisionCode').textContent = d.codeDisplay;
    $('#decisionName').textContent = d.name;
    $('#decisionBadge').lastChild.textContent = ' 编码有效 · 2026 版税则';
    $('#secWhy').textContent = '核验结果';
    const reg = d.regConditions.length
      ? d.regConditions.map(r => r.code + '（' + r.name + '）').join('、')
      : '无';
    $('#reasonList').innerHTML = `
      <li><i>01</i><div><b>编码有效：</b>存在于 2026 年版进出口税则</div></li>
      <li><i>02</i><div><b>所属章节：</b>第 ${d.code.slice(0, 2)} 章 · ${d.chapter || '—'}</div></li>
      <li><i>03</i><div><b>监管条件：</b>${reg}；申报要素共 ${d.declareElements.length} 项</div></li>`;
    $('#evVerifyChapter').textContent = '第 ' + d.code.slice(0, 2) + ' 章 · ' + (d.chapter || '—') + '；品目 ' + d.code.slice(0, 4);
    applyRates(d);
  }

  function copyText(text, msg) {
    (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
      .then(() => toast(msg))
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); ta.remove(); toast(msg);
      });
  }
  $('#copyCodeBtn').addEventListener('click', () => copyText($('#decisionCode').textContent, 'HS 编码已复制'));
  $('#toDeclare').addEventListener('click', () => { renderDeclare(); go('declare'); });
  // 反事实建议（事件委托：列表会被动态重渲染）
  $('#cfList').addEventListener('click', e => {
    const a = e.target.closest('.cf-advice');
    if (a) toast(a.dataset.advice);
  });
  // 海关官网核验：href 直达海关总署「进出口商品税率查询」（新标签）；
  // 点击时顺手把当前编码复制到剪贴板，粘贴即可查询
  $('#verifyLink').addEventListener('click', () => {
    const digits = $('#decisionCode').textContent.replace(/\D/g, '');
    if (digits.length === 10) copyText(digits, '已打开海关官网核验页，编码 ' + digits + ' 已复制，可直接粘贴查询');
    else toast('已打开海关官网核验页');
  });

  /* ---------- 归类路径浮层 ---------- */
  const pathModal = $('#pathModal');
  const closePath = () => pathModal.classList.add('hidden');
  function renderClassificationPath(result) {
    const path = decisionLogic.buildClassificationPath(result);
    if (!path.nodes.length) return false;
    $('#pathChain').innerHTML = path.nodes.map(node => `
      <div class="path-row${node.final ? ' final' : ''}">
        <div class="path-code">${esc(node.code)}</div>
        <div class="path-info">
          <b>${esc(node.title)}</b>
          <p>${esc(node.description)}</p>
          ${node.excluded ? `<div class="path-excluded">${esc(node.excluded)}</div>` : ''}
        </div>
      </div>`).join('');
    $('#pathNote').textContent = path.sourceNote;
    return true;
  }
  $('#viewPath').addEventListener('click', () => {
    if (!renderClassificationPath(currentDecisionResult)) {
      toast('当前结果没有可展示的完整归类路径');
      return;
    }
    pathModal.classList.remove('hidden');
  });
  $('#pathClose').addEventListener('click', closePath);
  $('#pathOk').addEventListener('click', closePath);
  pathModal.addEventListener('click', e => { if (e.target === pathModal) closePath(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closePath(); });

  /* ---------- 常见问题浮层（右上角“帮助”）---------- */
  const FAQ_ITEMS = [
    { q: 'HS 编码是什么？', a: ['HS 编码（Harmonized System Code，商品名称及编码协调制度）是由世界海关组织（WCO）制定的国际通用商品分类编码，用于进出口货物的统一识别、征税和统计。全球 200 多个国家和地区采用 HS 编码，前 6 位全球统一，后几位由各国自行扩展。'] },
    { q: '如何查询 HS 编码？', a: ['在 HS归类通 的搜索框输入商品名称（中文或英文）、关键词、或编码数字，即可快速查询。支持模糊匹配和全文搜索。本站收录 12,087 个 10 位商品编号，覆盖 97 个章、1,231 个品目，查询结果展示完整编码、商品名称、税率、申报要素、监管条件等信息。'] },
    { q: '10 位商品编号和 HS 编码有什么区别？', a: ['中国海关的商品编号是 10 位：前 6 位是国际 HS 编码（全球统一），前 8 位是税则号列（用于确定税率），10 位用于报关申报。部分商品还有 13 位 CIQ 编码，用于检验检疫细分。'] },
    { q: '申报要素是什么？', a: ['申报要素是海关总署规定的、报关时必须填写的商品特征信息（如品牌、型号、规格、用途等），用于海关估价和归类。不同 HS 编码要求的申报要素不同，通常为 5-15 项。HS归类通 每个编码详情页展示完整申报要素清单。'] },
    { q: '监管条件代码 A、B、P、Q 分别代表什么？', a: ['监管条件代码是海关规定的证件要求。常见代码 — A：入境货物通关单（进口检验检疫）；B：出境货物通关单（出口检验检疫）；P：进境动植物、动植物产品检疫；Q：出境动植物、动植物产品检疫。其他常见代码包括 4（两用物项许可证）、5（药品通关单）、O（自动进口许可证）等。具体每个商品编码的监管要求在详情页可查。'] },
    { q: '最惠国税率、普通税率、协定税率有什么区别？', a: ['最惠国税率：适用于 WTO 成员国，是绝大多数进口商品的通用税率（较低）。', '普通税率：适用于未与中国签订最惠国待遇的国家（税率最高）。', '协定税率：适用于与中国签订自由贸易协定的特定国家/地区（如 RCEP、东盟、中日韩等），通常比最惠国税率更低，但需提供原产地证。'] },
    { q: '出口退税率怎么查？', a: ['可在每个 HS 编码详情页的“税率信息”卡片里展示“出口退税率”字段。输入商品编号或关键词即可查询具体退税率。'] }
  ];
  const faqModal = $('#faqModal');
  function renderFaq() {
    $('#faqList').innerHTML = FAQ_ITEMS.map((it, i) => `
      <div class="faq-item open" data-idx="${i}">
        <button class="faq-q" type="button">
          <span>${esc(it.q)}</span>
          <svg class="faq-chevron" viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>
        </button>
        <div class="faq-a"><div>${it.a.map(p => `<p>${esc(p)}</p>`).join('')}</div></div>
      </div>`).join('');
  }
  function openFaq() {
    if (!$('#faqList').childElementCount) renderFaq();
    faqModal.classList.remove('hidden');
  }
  const closeFaq = () => faqModal.classList.add('hidden');
  // 事件委托：点击问题标题切换展开/收起
  $('#faqList').addEventListener('click', e => {
    const q = e.target.closest('.faq-q');
    if (!q) return;
    q.closest('.faq-item').classList.toggle('open');
  });
  $('#faqClose').addEventListener('click', closeFaq);
  $('#faqFeedback').addEventListener('click', () => toast('建议反馈渠道（演示环境未开启）'));
  faqModal.addEventListener('click', e => { if (e.target === faqModal) closeFaq(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeFaq(); });

  /* ================= Page 5 · 申报信息 ================= */
  // 申报要素清单来自数据库（hsData.declareElements），值允许用户行内编辑
  const PREFILL = { '品牌类型': '境内自主品牌', '品牌（中文或外文名称）': 'PILOT（百乐）', '型号': 'G-2 0.5mm' };
  const FALLBACK_ELEMENTS = ['品牌类型', '品牌（中文或外文名称）', '型号', 'GTIN', 'CAS', '其他'];

  function renderDeclare() {
    const d = hsData;
    $('#declareCode').textContent = d ? d.codeDisplay : '9608.99.20.00';
    const elements = (d && d.declareElements.length) ? d.declareElements : FALLBACK_ELEMENTS;
    const isClassify = !session || session.mode === 'classify';
    const prefillMap = (session && session.prefill)
      || (isClassify && d && d.code === '9608992000' ? PREFILL : {});
    const list = $('#declareList');
    list.innerHTML = elements.map(el => {
      const pre = isClassify ? (prefillMap[el] || '') : '';
      if (el === 'GTIN') {
        return `<li data-key="GTIN" class="todo"><span class="d-label">GTIN</span>
          <span class="d-value"><input id="gtinInput" placeholder="输入 GTIN"></span>
          <span class="todo-tag">待补充</span><span class="d-arrow">›</span></li>`;
      }
      return pre
        ? `<li data-key="${esc(el)}"><span class="d-label">${esc(el)}</span><span class="d-value">${esc(pre)}</span><i class="check ok"></i><span class="d-arrow">›</span></li>`
        : `<li data-key="${esc(el)}" class="todo"><span class="d-label">${esc(el)}</span><span class="d-value placeholder">待补充</span><span class="todo-tag">待补充</span><span class="d-arrow">›</span></li>`;
    }).join('');
    const gtin = $('#gtinInput');
    if (gtin) gtin.addEventListener('input', onGtinInput);
    updateCounts();
  }

  const list = $('#declareList');

  // Inline 编辑：点击行 → 值变输入框
  list.addEventListener('click', e => {
    const li = e.target.closest('li');
    if (!li || e.target.tagName === 'INPUT') return;
    const valueEl = li.querySelector('.d-value');
    if (li.dataset.key === 'GTIN') { li.querySelector('input').focus(); return; }
    if (valueEl.querySelector('input')) return;
    const old = li.classList.contains('todo') ? '' : valueEl.textContent;
    const input = document.createElement('input');
    input.value = old;
    input.placeholder = '请输入' + li.dataset.key;
    valueEl.textContent = '';
    valueEl.appendChild(input);
    input.focus();
    const commit = () => {
      const v = input.value.trim();
      if (v) {
        valueEl.textContent = v;
        li.classList.remove('todo');
        ensureCheck(li);
      } else {
        valueEl.innerHTML = '<span class="placeholder">待补充</span>';
      }
      updateCounts();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') input.blur(); });
  });

  function ensureCheck(li) {
    if (!li.querySelector('.check')) {
      const tag = li.querySelector('.todo-tag');
      if (tag) { const c = document.createElement('i'); c.className = 'check ok'; tag.replaceWith(c); }
    }
  }

  function onGtinInput(e) {
    const li = e.target.closest('li');
    const has = e.target.value.trim().length > 0;
    li.classList.toggle('todo', !has);
    if (has) ensureCheck(li);
    else {
      const c = li.querySelector('.check');
      if (c) { const t = document.createElement('span'); t.className = 'todo-tag'; t.textContent = '待补充'; c.replaceWith(t); }
    }
    updateCounts();
  }

  function updateCounts() {
    const rows = $$('#declareList li');
    const todo = $$('#declareList li.todo').length;
    $('#filledCount').textContent = rows.length - todo;
    $('#todoCount').textContent = todo + ' 项';
    const note = $('#todoNote');
    note.classList.toggle('done', todo === 0);
    note.innerHTML = todo === 0
      ? '<svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:1.7"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/></svg>全部要素已确认，可复制用于申报'
      : '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><circle cx="12" cy="16.5" r=".5"/></svg>还有 <b>' + todo + '</b> 项待补充';
    // 副标题分母跟随真实要素数
    $('#declareTotal').textContent = ' / ' + rows.length + ' 项，';
  }

  // 复制申报要素（格式菜单）
  const copyMenu = $('#copyMenu');
  $('#copyDeclareBtn').addEventListener('click', e => {
    e.stopPropagation();
    copyMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => copyMenu.classList.add('hidden'));
  copyMenu.addEventListener('click', e => e.stopPropagation());

  function declareRows() {
    return $$('#declareList li').map(li => {
      const inp = li.querySelector('.d-value input');
      const raw = inp ? inp.value.trim() : li.querySelector('.d-value').textContent;
      return { k: li.dataset.key, v: raw && raw !== '待补充' ? raw : '（未填）' };
    });
  }
  $$('#copyMenu button[data-fmt]').forEach(btn => {
    btn.addEventListener('click', () => {
      const rows = declareRows();
      const code = $('#declareCode').textContent;
      const text = btn.dataset.fmt === 'table'
        ? '| 申报要素 | 内容 |\n|---|---|\n' + rows.map(r => '| ' + r.k + ' | ' + r.v + ' |').join('\n')
        : 'HS编码：' + code + '\n' + rows.map(r => r.k + '：' + r.v).join('\n');
      copyText(text, '申报要素已复制到剪贴板');
      copyMenu.classList.add('hidden');
    });
  });

  /* ================= 启动 ================= */
  renderRecent();
})();
