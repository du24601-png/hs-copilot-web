import pymupdf, re
from collections import Counter

doc = pymupdf.open('tools/raw/shuize2026.pdf')
N = len(doc)

chapter_hdr = re.compile(r'第([一二三四五六七八九十百]+)章\s*\n?\s*([^\n]{2,30})\n?\s*注释：')
note_blocks = Counter()
nat_pages, sub_pages, ch_pages = [], [], []
chapter_titles = []

for i in range(N):
    t = doc[i].get_text()
    if '本国子目注释' in t:
        nat_pages.append(i + 1)
    if re.search(r'(?<!本国)子目注释', t):
        sub_pages.append(i + 1)
    for m in chapter_hdr.finditer(t):
        ch_pages.append(i + 1)
        chapter_titles.append(m.group(2).strip()[:20])

print('总页数:', N)
print()
print('含“本国子目注释”的页数:', len(nat_pages))
print('含“子目注释”的页数   :', len(sub_pages))
print('检出“第X章 … 注释：”块:', len(ch_pages))
print('章标题样例:', chapter_titles[:6])
print('章标题末例:', chapter_titles[-4:] if chapter_titles else '-')
