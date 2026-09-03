"""解析《本国子目注释表》PDF（省级转载版，表格规整）→ JSON。

PDF 文本经 PyMuPDF 提取后保留换行，结构为三段式重复：
    序号(1-3位数字)
    税则号列(8位数字，可多行)
    本国子目注释正文(以"本国子目"开头，可跨行跨页)
"""
import re
import json
import sys
import pymupdf

SKIP_EXACT = {
    '附6', '附5', '本国子目注释表', '本国子目注释调整表',
    '序号', '税则号列', '本国子目注释', '商品名称[注]',
    '调整前', '调整后', '调整说明', '新增注释', '修改注释', '删除注释',
}
RE_PAGE = re.compile(r'^第\s*\d+\s*页$')
RE_SEQ = re.compile(r'^\d{1,3}$')
RE_CODE = re.compile(r'^\d{8}$')


def parse(path, verbose=True):
    doc = pymupdf.open(path)
    lines = []
    for page in doc:
        lines.extend(page.get_text().split('\n'))

    records = []
    cur = None
    for raw in lines:
        s = raw.strip()
        if not s or RE_PAGE.match(s) or s in SKIP_EXACT:
            continue
        if RE_SEQ.match(s):
            if cur:
                records.append(cur)
            cur = {'seq': int(s), 'codes': [], 'text': ''}
        elif RE_CODE.match(s) and cur is not None and not cur['text']:
            cur['codes'].append(s)
        elif cur is not None:
            cur['text'] += s
    if cur:
        records.append(cur)

    # 清洗：正文去掉多余空白；排序；去重校验
    out = []
    for r in records:
        text = re.sub(r'\s+', '', r['text'])
        if not text.startswith('本国子目'):
            continue
        out.append({'seq': r['seq'], 'codes': r['codes'], 'text': text})
    out.sort(key=lambda x: x['seq'])

    if verbose:
        n_code = sum(len(r['codes']) for r in out)
        seqs = [r['seq'] for r in out]
        print(f'文件: {path}')
        print(f'  注释条数 : {len(out)}')
        print(f'  号列总数 : {n_code}')
        print(f'  序号范围 : {min(seqs) if seqs else "-"} ~ {max(seqs) if seqs else "-"}')
        missing = [i for i in range(1, (max(seqs) or 0) + 1) if i not in seqs]
        print(f'  缺号     : {missing if missing else "无"}')
        no_code = [r['seq'] for r in out if not r['codes']]
        print(f'  无号列条 : {no_code if no_code else "无"}')
    return out


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else 'tools/raw/hunan_bgzmzs_2024.pdf'
    dst = sys.argv[2] if len(sys.argv) > 2 else 'tools/raw/national_notes_2025.json'
    recs = parse(src)
    with open(dst, 'w', encoding='utf-8') as f:
        json.dump(recs, f, ensure_ascii=False, indent=2)
    print(f'\n已写出 {dst}')
    print('\n=== 抽样 3 条 ===')
    for r in (recs[0], recs[len(recs) // 2], recs[-1]):
        print(f"[{r['seq']}] 号列={r['codes']}")
        print(f"    {r['text'][:110]}...")
