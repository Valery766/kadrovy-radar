import { useEffect, useState } from 'react';
import { Button, Input, Spinner } from '@maxhub/max-ui';
import {
  api, ApiError, fmtDate, rub, staffRiskClass, staffRiskLabel,
  type Bootstrap, type StaffPositionInput, type StaffResult,
} from '../lib/api';
import { haptic } from '../lib/bridge';

interface Row { id: string; title: string; salary: string }

interface Props {
  boot: Bootstrap;
  onOpenCard: (cardId: string) => void;
  onHome: () => void;
}

const emptyRow = (i: number): Row => ({ id: `p${i}`, title: '', salary: '' });

/** Строки редактора из сохранённой оценки: порядок отчёта — от самых отстающих. */
const rowsFromResult = (r: StaffResult): Row[] =>
  r.report.positions.map((p, i) => ({ id: p.id || `p${i + 1}`, title: p.title, salary: String(p.salary) }));

export function Staff({ boot, onOpenCard, onHome }: Props) {
  const [rows, setRows] = useState<Row[]>([emptyRow(1), emptyRow(2), emptyRow(3)]);
  const [regionFns, setRegionFns] = useState<string>(boot.user.regionFnsCode ?? '78');
  const [result, setResult] = useState<StaffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const demo = boot.user.demo;
  const regionName = boot.regions.find((r) => r.fnsCode === regionFns)?.name ?? null;

  useEffect(() => {
    let alive = true;
    api.staffLast()
      .then((r) => { if (!alive || !r.report) return; setResult(r.report); setRows(rowsFromResult(r.report)); })
      .catch(() => undefined)
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  const setRow = (id: string, patch: Partial<Row>) => setRows((cur) => cur.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const addRow = () => setRows((cur) => (cur.length >= 20 ? cur : [...cur, emptyRow(cur.length + 1)]));
  const removeRow = (id: string) => setRows((cur) => (cur.length > 1 ? cur.filter((r) => r.id !== id) : cur));

  const assess = async () => {
    setError(null);
    const positions: StaffPositionInput[] = [];
    for (const r of rows) {
      const title = r.title.trim();
      const salary = Number(r.salary.replace(/\D/g, ''));
      if (!title && !r.salary.trim()) continue;
      if (!title) { setError('В каждой строке нужна должность'); return; }
      if (!Number.isFinite(salary) || salary < 1000 || salary > 5_000_000) { setError(`«${title}»: ставка от 1 000 до 5 000 000 ₽ в месяц`); return; }
      positions.push({ id: r.id, title, salary });
    }
    if (positions.length === 0) { setError('Добавьте хотя бы одну должность со ставкой'); return; }
    if (!regionFns) { setError('Выберите регион — иначе рынок не с чем сравнивать'); return; }
    setBusy(true);
    try {
      const r = await api.staff({ positions, inn: boot.user.inn, regionFnsCode: regionFns });
      setResult(r);
      haptic('success');
    } catch (e) {
      haptic('error');
      setError(e instanceof ApiError ? e.message : 'Не удалось оценить штат');
    } finally { setBusy(false); }
  };

  const cardIdFor = (professionKey: string | null): string | null =>
    (professionKey ? result?.markets.find((m) => m.professionKey === professionKey)?.cardId ?? null : null);

  return (
    <div className="sv-page sv-stack">
      <div>
        <div className="sv-title">Мой штат</div>
        <div className="sv-muted sv-small">Внесите должности и ставки сотрудников — покажу, кто уже ниже рынка{regionName ? ` в регионе «${regionName}»` : ''}, на сколько и сколько стоит подтянуть до медианы.</div>
      </div>

      {demo && <div className="sv-banner">Демо-режим: расчёт работает, но список не сохранится. Внутри MAX штат запоминается и открывается по команде /staff.</div>}

      <div className="sv-card sv-stack">
        <label className="sv-stack" style={{ gap: 6 }}>
          <span className="sv-h2" style={{ margin: 0 }}>Регион</span>
          <select className="sv-select" value={regionFns} onChange={(e) => setRegionFns(e.target.value)}>
            {boot.regions.map((r) => <option key={r.fnsCode} value={r.fnsCode}>{r.name}</option>)}
          </select>
          <span className="sv-muted sv-small">Рынок сравниваем по этому региону{boot.user.inn ? `; профиль бизнеса — по ИНН ${boot.user.inn}` : ''}.</span>
        </label>
        <div className="sv-h2" style={{ marginTop: 6 }}>Должности и ставки</div>
        {loading && <div className="sv-center"><Spinner /></div>}
        {!loading && rows.map((r, i) => (
          <div key={r.id} className="sv-staff-row">
            <Input placeholder={i === 0 ? 'повар' : 'должность'} value={r.title} onChange={(e) => setRow(r.id, { title: e.target.value })} />
            <Input inputMode="numeric" placeholder="60000" value={r.salary} onChange={(e) => setRow(r.id, { salary: e.target.value })} />
            <button type="button" className="sv-iconbtn" title="Удалить строку" onClick={() => removeRow(r.id)}>×</button>
          </div>
        ))}
        {error && <div className="sv-banner sv-banner--error">{error}</div>}
        <div className="sv-actions">
          <Button stretched variant="secondary" onClick={addRow} disabled={rows.length >= 20}>Добавить должность</Button>
          <Button stretched onClick={() => void assess()} loading={busy} disabled={busy}>Оценить</Button>
        </div>
        <div className="sv-muted sv-small">Не больше 20 строк за раз. Ставка — оклад в месяц до вычета НДФЛ.</div>
      </div>

      {busy && !result && (
        <div className="sv-card sv-stack">
          <div className="sv-center"><Spinner /></div>
          <div className="sv-center sv-muted sv-small">Считаю рынок по каждой должности: вакансии «Работы России» и размеры работодателей из реестра МСП.</div>
        </div>
      )}

      {result && (
        <>
          <div className="sv-card sv-stack">
            <div className="sv-h2">Что получилось</div>
            <div className="sv-tiles">
              <div className="sv-tile"><div className="sv-tile__label">Ниже 25-го перцентиля</div><div className="sv-tile__value">{result.report.summary.highRisk}</div></div>
              <div className="sv-tile"><div className="sv-tile__label">Ниже медианы</div><div className="sv-tile__value">{result.report.summary.mediumRisk}</div></div>
              <div className="sv-tile"><div className="sv-tile__label">В рынке</div><div className="sv-tile__value">{result.report.summary.inMarket}</div></div>
              <div className="sv-tile"><div className="sv-tile__label">Фонд оплаты труда</div><div className="sv-tile__value">{rub(result.report.summary.payroll)}</div></div>
            </div>
            <div className="sv-banner sv-banner--info">
              Подтянуть всех до медианы рынка: {rub(result.report.summary.costToMedian)} в месяц (+{result.report.summary.costShare} % к фонду).
              {result.report.summary.medianPercentile != null && ` Медианный перцентиль штата — ${result.report.summary.medianPercentile}-й.`}
            </div>
          </div>

          <div className="sv-card">
            <div className="sv-h2">Должности от самых отстающих</div>
            <div className="sv-table">
              <div className="sv-table__head sv-table__row sv-table__row--staff">
                <div>Должность</div><div>Ставка</div><div>Медиана</div><div>Разрыв</div>
              </div>
              {result.report.positions.map((p) => {
                const cardId = cardIdFor(p.professionKey);
                return (
                  <div key={p.id} className="sv-table__row sv-table__row--staff">
                    <div>
                      <div className="sv-item__title">{p.title}</div>
                      <div className="sv-chips" style={{ marginTop: 4 }}>
                        <span className={`sv-badge ${staffRiskClass(p.risk)}`}>{staffRiskLabel(p.risk)}</span>
                        {p.percentile != null && <span className="sv-badge sv-badge--muted">{p.percentile}-й перцентиль</span>}
                      </div>
                      {p.note && <div className="sv-muted sv-small">{p.note}</div>}
                      {cardId && <button type="button" className="sv-link sv-linkbtn" onClick={() => onOpenCard(cardId)}>карточка рынка «{p.professionTitle}»</button>}
                    </div>
                    <div className="sv-item__value" data-label="Ставка">{rub(p.salary)}</div>
                    <div className="sv-item__value" data-label="Медиана">{p.median != null ? rub(p.median) : '—'}</div>
                    <div className="sv-item__value" data-label="Разрыв">{p.gapRub > 0 ? `${rub(p.gapRub)} (${p.gapPct} %)` : '—'}</div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="sv-card sv-stack" style={{ gap: 6 }}>
            <div className="sv-h2">Источники и метод</div>
            {result.sources.map((s) => <div key={s.id} className="sv-small">{s.title} · получено {fmtDate(s.fetchedAt)}{s.note ? ` · ${s.note}` : ''}</div>)}
            <div className="sv-muted sv-small">
              Риск определяется положением ставки на рынке региона: ниже 25-го перцентиля — высокий, ниже медианы — умеренный. Перцентиль считается по гистограмме карточки рынка, разрыв — расстояние до медианы. Регион: {result.region.name}, пакет «{result.pack.title}» v{result.pack.version}.
            </div>
          </div>
        </>
      )}

      <Button stretched variant="ghost" onClick={onHome}>На главную</Button>
    </div>
  );
}
