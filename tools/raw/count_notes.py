import pymupdf, re

doc = pymupdf.open('tools/raw/shuize2026.pdf')

pages = []
for i in range(len(doc)):
    if '本国子目' in doc[i].get_text():
        pages.append(i)

full = ''
for i in pages:
    full += doc[i].get_text() + '\n'
flat = re.sub(r'\s+', '', full)

nat = re.findall(r'本国子目\s*([0-9]{4}\.[0-9]{4})', flat)
nat_u = sorted(set(nat))
print('本国子目注释 —— 锚点数:', len(nat), '| 去重子目数:', len(nat_u))

# HS 子目注释（排除"本国子目"）
sub = re.findall(r'(?<!本国)子目\s*([0-9]{4}\.[0-9]{2,4})', flat)
sub_u = sorted(set(sub))
print('子目注释(HS) —— 锚点数:', len(sub), '| 去重:', len(sub_u))

# 章注
ch = re.findall(r'第([一二三四五六七八九十百]+)章[^\n]{0,20}\n?\s*注释：', full)
print('带“注释：”的章数:', len(ch))

print()
print('本国子目注释覆盖的章数:', len(set(c[:2] for c in nat_u)))
from collections import Counter
cnt = Counter(c[:2] for c in nat_u)
print('最多的章:', ', '.join(f'{k}章({v})' for k, v in cnt.most_common(8)))
print()
print('本国子目注释子目号样例(前5):', nat_u[:5])
print('本国子目注释子目号样例(后5):', nat_u[-5:])
