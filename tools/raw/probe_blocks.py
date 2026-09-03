import pymupdf, re

doc = pymupdf.open('tools/raw/shuize2026.pdf')
N = len(doc)

# 1) 找独立的“子目注释：”块（排除“本国子目注释：”）
print('=' * 20, '独立“子目注释：”块', '=' * 20)
shown = 0
for i in range(N):
    t = doc[i].get_text()
    m = re.search(r'(?<!本国)子目注释\s*[:：]', t)
    if m and shown < 2:
        start = max(0, m.start() - 400)
        seg = re.sub(r'\n{2,}', '\n', t[start:m.start() + 600])
        print(f'\n--- PDF 第 {i+1} 页 ---')
        print(seg)
        shown += 1

# 2) 找“第 X 类”与类注
print('\n' + '=' * 20, '类注结构', '=' * 20)
for i in range(15, 40):
    t = doc[i].get_text()
    if re.search(r'第\s*一\s*类', t):
        m = re.search(r'第\s*一\s*类', t)
        seg = re.sub(r'\n{2,}', '\n', t[m.start():m.start() + 900])
        print(f'\n--- PDF 第 {i+1} 页 ---')
        print(seg)
        break

# 3) 全本统计各块标记出现次数（按页去重会低估，这里按出现次数）
cnt = {'归类总规则': 0, '注释：': 0, '子目注释：': 0, '本国子目注释：': 0}
for i in range(N):
    t = doc[i].get_text()
    for k in cnt:
        cnt[k] += len(re.findall(re.escape(k), t))
print('\n' + '=' * 20, '全本出现次数', '=' * 20)
for k, v in cnt.items():
    print(f'  {k}: {v}')
