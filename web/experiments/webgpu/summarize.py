"""Summarizes bench.mjs output: per view, variant and cell, the median over page loads of each load's median (GPU ms,
CPU ms, frame ms end to end), with the spread across loads (min-max of the per-load medians) and within loads (the
median per-load interquartile range). usage: python3 summarize.py bench.jsonl"""
import json
import statistics as st
import sys
from collections import defaultdict


def med(a):
    a = [x for x in a if x is not None and x == x]
    return st.median(a) if a else float('nan')


def iqr(a):
    a = sorted(x for x in a if x is not None and x == x)
    if len(a) < 4:
        return float('nan')
    return a[(3 * len(a)) // 4] - a[len(a) // 4]


rows = [json.loads(line) for line in open(sys.argv[1] if len(sys.argv) > 1 else 'bench.jsonl')]
cells = defaultdict(lambda: defaultdict(list))  # (view, r, cull, shadow) -> load -> [records]
info = {}
for r in rows:
    if 'error' in r:
        print('error', r['view'], r['r'], r['error'][:200])
        continue
    cells[(r['view'], r['r'], r['cull'], r['shadow'])][r['rep']].append(r)
    info[(r['view'], r['r'])] = r['info']

for k, v in sorted(info.items()):
    print(k, 'meshes', v['meshes'], 'quads', v['quads'], 'vertexMB', v['vertexMB'], 'meshMs', v['meshMs'])
print()
print('view          variant cull  shadow | GPU ms med [load min-max] (in-load IQR) | CPU ms med [min-max] | frame ms med [min-max] | loads')
for (view, r, cull, shadow), loads in sorted(cells.items(), key=lambda kv: (kv[0][0], kv[0][2], kv[0][3], kv[0][1])):
    g = [med([x for rec in recs for x in rec['gpu']]) for recs in loads.values()]
    c = [med([x for rec in recs for x in rec['cpu']]) for recs in loads.values()]
    f = [med([x for rec in recs for x in rec['interval']]) for recs in loads.values()]
    gi = med([iqr([x for rec in recs for x in rec['gpu']]) for recs in loads.values()])
    print(f'{view:13} {r:7} {"cull" if cull else "all ":4}  {shadow:6} | {med(g):6.2f} [{min(g):5.2f}-{max(g):5.2f}] ({gi:4.2f})'
          f' | {med(c):5.2f} [{min(c):5.2f}-{max(c):5.2f}] | {med(f):6.2f} [{min(f):5.2f}-{max(f):5.2f}] | {len(loads)}')
