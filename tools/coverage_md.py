"""docs/coverage.json → docs/coverage.md: карта покрытия «регион × профессия» и сводка для слайда о масштабировании."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
src = ROOT / 'docs' / 'coverage.json'
data = json.loads(src.read_text(encoding='utf8'))
profs = data['professions']; regions = data['regions']
MIN = 20  # порог достоверности по вакансиям (thresholds.minVacancies)
rows = []
ok_pairs = 0; total_pairs = 0; regions_ok = 0
for r in regions:
    t = r['totals']; vals = [t.get(p['key']) for p in profs]
    known = [v for v in vals if v is not None]
    ok = sum(1 for v in known if v >= MIN)
    total_pairs += len(known); ok_pairs += ok
    if ok >= 5: regions_ok += 1
    rows.append((r['name'], vals, ok))
rows.sort(key=lambda x: -sum(v or 0 for v in x[1]))
lines = [f"# Карта покрытия «регион × профессия»", '', f"Источник: «Работа России», Open API v1, `meta.total` по запросу профессии в регионе; снимок {data['generatedAt'][:16].replace('T', ' ')} UTC. Порог достоверности пакета — {MIN} вакансий.", '',
         f"**Итог:** {ok_pairs} из {total_pairs} пар «регион × профессия» ({round(100*ok_pairs/max(total_pairs,1))} %) дают ≥ {MIN} вакансий; в {regions_ok} из {len(regions)} регионов не менее 5 профессий с достаточной выборкой.", '',
         '| Регион | ' + ' | '.join(p['title'] for p in profs) + ' | Профессий ≥ порога |', '|---|' + '---:|' * (len(profs) + 1)]
for name, vals, ok in rows:
    lines.append(f"| {name} | " + ' | '.join('—' if v is None else str(v) for v in vals) + f" | {ok}/{len(profs)} |")
(ROOT / 'docs' / 'coverage.md').write_text('\n'.join(lines) + '\n', encoding='utf8')
summary = {'okPairs': ok_pairs, 'totalPairs': total_pairs, 'regionsOk': regions_ok, 'regions': len(regions), 'min': MIN}
(ROOT / 'docs' / 'coverage-summary.json').write_text(json.dumps(summary, ensure_ascii=False), encoding='utf8')
print(summary)
