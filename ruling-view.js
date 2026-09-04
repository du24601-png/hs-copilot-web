(function(root,factory) {
  const api=factory();
  if(typeof module==='object' && module.exports) module.exports=api;
  else root.HSRulings=api;
})(typeof globalThis!=='undefined'?globalThis:this,function() {
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={supports:'支持本次判断',distinguishes:'用于区别排除',uncertain:'适用性尚不确定'};
  function sourceUrl(value) {
    const text=String(value||'').trim();
    if(/\.\.\.|…|%E2%80%A6/i.test(text)) return null;
    try { const url=new URL(text); return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null; }
    catch { return null; }
  }
  function render(result={}) {
    const refs=(Array.isArray(result.caseReferences)?result.caseReferences:[]).slice(0,6);
    const state=result.caseKnowledgeStatus;
    if(!refs.length) {
      const message=!state?'该历史记录未保存判例信息。':
        state.status==='disabled'?'本次查询未启用判例辅助。':
        ['error','unavailable'].includes(state.status)?'本次判例知识层不可用，已使用原有税则查询流程。':
        state.status==='no_match'?'本次未检索到匹配的参考判例。':'已检索判例，但本次结论未引用；不代表不存在适用判例。';
      return '<p class="case-empty">'+message+'</p>';
    }
    return '<p class="case-disclaimer">历史个案仅供比较。现行编码映射与适用性仍需业务复核，不能替代现行税则。</p>'+refs.map(item=>{
      const analysis=item.analysis||{};
      const matches=Array.isArray(analysis.matchedFacts)?analysis.matchedFacts:[];
      const differences=Array.isArray(analysis.differingFacts)?analysis.differingFacts:[];
      const url=sourceUrl(item.sourceUrl);
      const file=String(item.sourceFile||'').split(/[\\/]/).pop();
      const candidateCount=Number.isInteger(item.candidateCount)?item.candidateCount:0;
      return `<article class="case-ref">
        <div class="case-ref-head"><span class="legal-tag">${esc(labels[analysis.relation]||labels.uncertain)}</span><b>${esc(item.decisionNo)} · ${esc(item.productName)}</b></div>
        <p class="case-meta">历史税号 ${esc(item.historicalCode)} · ${candidateCount} 个现行前缀候选 · 待业务确认</p>
        <div class="case-analysis"><b>AI适用性分析</b><p>${esc(analysis.explanation||'未提供适用性解释。')}</p>
          ${matches.length?'<p>相同事实：'+matches.map(esc).join('；')+'</p>':''}
          ${differences.length?'<p>关键差异：'+differences.map(esc).join('；')+'</p>':''}</div>
        <details class="case-original"><summary>查看判例原文与来源</summary>
          <p><b>商品描述：</b>${esc(item.productDescription||'未提供')}</p>
          <p><b>归类决定：</b>${esc(item.classificationDecision||'来源未提供独立归类决定叙述，不补写理由。')}</p>
          <p><b>所列依据：</b>${esc(item.ruleBasis||'未提供')}</p>
          <p class="case-meta">${esc(item.announcementNo||'公告号未提供')} · ${esc(item.publishDate||'发布日期未提供')}</p>
          <p class="case-meta">有效性记录：${esc(item.validityStatus||'未提供')}；不等于已确认当前有效。</p>
          <p class="case-meta">来源：${esc(file||'来源文件名未提供')}${url?' · <a href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">查看来源页面</a>':' · 未提供完整来源链接'}</p>
        </details></article>`;
    }).join('');
  }
  return {render};
});
