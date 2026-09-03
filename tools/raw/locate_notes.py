import pymupdf, re

doc = pymupdf.open('tools/raw/shuize2026.pdf')
N = len(doc)
print('总页数:', N)

# 1) 看目录页与首次出现页
for pno in (7, 30):
    t = doc[pno - 1].get_text()
    t = re.sub(r'\s+', ' ', t)
    print(f'\n===== 第 {pno} 页 (前 500 字) =====')
    print(t[:500])

# 2) 全本扫描：定位"本国子目注释"作为章节标题的页
print('\n===== 全本扫描：含“本国子目”关键词的页 =====')
pages_with = []
for i in range(N):
    t = doc[i].get_text()
    if '本国子目' in t:
        pages_with.append(i + 1)
print('命中页数:', len(pages_with))
print('页码范围:', pages_with[0] if pages_with else '-', '~', pages_with[-1] if pages_with else '-')
print('前 20 个页码:', pages_with[:20])
print('后 10 个页码:', pages_with[-10:])
