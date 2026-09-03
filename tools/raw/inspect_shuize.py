import pymupdf, re, sys

doc = pymupdf.open('tools/raw/shuize2026.pdf')
print('总页数:', len(doc))

keys = ['归类总规则', '本国子目注释', '子目注释', '章注', '类注', '规则与说明']

# 只扫描前 60 页定位目录与结构，避免全本扫描过慢
hits = {k: [] for k in keys}
for i in range(min(60, len(doc))):
    t = doc[i].get_text()
    for k in keys:
        if k in t:
            hits[k].append(i + 1)

print()
print('=== 前 60 页关键词命中的页码 ===')
for k in keys:
    pg = hits[k][:6]
    print(f'  {k}: {pg}')

print()
print('=== 第 1 页前 600 字 ===')
print(doc[0].get_text()[:600])
