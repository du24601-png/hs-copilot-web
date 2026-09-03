"""初始化 legal_note 表与 FTS 索引（先做数据库备份）。

level 取值：
  rule        归类总规则
  section     类注
  chapter     章注
  subheading  子目注释（HS 国际）
  national    本国子目注释
ref 取值：类号 / 章号 / 子目号(如 1602.10) / 税则号列(如 02089010)
"""
import sqlite3
import os
import shutil
from datetime import datetime

DB = 'hs_copilot.db'
BACKUP_DIR = 'tools/backup'

DDL = [
    """CREATE TABLE IF NOT EXISTS legal_note (
         id      INTEGER PRIMARY KEY,
         level   TEXT NOT NULL,
         ref     TEXT,
         seq     INTEGER,
         title   TEXT,
         content TEXT NOT NULL,
         version TEXT,
         source  TEXT
       )""",
    "CREATE INDEX IF NOT EXISTS idx_legal_level_ref ON legal_note(level, ref)",
    "CREATE INDEX IF NOT EXISTS idx_legal_ref ON legal_note(ref)",
    """CREATE VIRTUAL TABLE IF NOT EXISTS legal_note_fts
         USING fts5(level UNINDEXED, ref UNINDEXED, title, content,
                    tokenize='trigram')""",
]


def backup():
    os.makedirs(BACKUP_DIR, exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    dst = os.path.join(BACKUP_DIR, f'hs_copilot_{stamp}.db')
    src = sqlite3.connect(DB)
    out = sqlite3.connect(dst)
    src.backup(out)          # 用 backup API，WAL 模式下也能拿到一致快照
    out.close()
    src.close()
    return dst


def main():
    dst = backup()
    print(f'已备份 → {dst}  ({os.path.getsize(dst)/1024/1024:.1f} MB)')

    con = sqlite3.connect(DB)
    cur = con.cursor()
    for sql in DDL:
        cur.execute(sql)
    con.commit()

    print('\n=== legal_note 表结构 ===')
    for r in cur.execute("SELECT sql FROM sqlite_master WHERE name LIKE 'legal_note%'"):
        print(r[0][:150])
        print('  ---')
    print('现有行数:', cur.execute('SELECT COUNT(*) FROM legal_note').fetchone()[0])
    con.close()


if __name__ == '__main__':
    main()
