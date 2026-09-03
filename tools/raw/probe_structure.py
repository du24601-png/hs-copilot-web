import pymupdf, re

doc = pymupdf.open('tools/raw/shuize2026.pdf')

for pno in (12, 16):
    t = doc[pno - 1].get_text()
    print(f'\n{"="*22} 第 {pno} 页 {"="*22}')
    print(t[:1500])

# 找一页同时含"子目注释"且不是"本国子目注释"的页
print(f'\n{"="*22} 含独立“子目注释”的页 {"="*22}')
found = 0
for i in range(len(doc)):
    t = doc[i].get_text()
    if re.search(r'(?<!本国)子目注释\s*[:：]', t) and found < 2:
        print(f'\n--- 第 {i+1} 页 ---')
        idx = t.find('注释')
        print(t[max(0, idx - 300): idx + 700])
        found += 1
