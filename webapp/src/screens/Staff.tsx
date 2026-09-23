import { useEffect, useRef, useState } from 'react';
import { Button, Input, Spinner } from '@maxhub/max-ui';
import {
  api, ApiError, rub, staffRiskClass, staffRiskLabel,
  type Bootstrap, type StaffPositionInput, type StaffResult,
} from '../lib/api';
import { haptic } from '../lib/bridge';
import { nWord, staffLead, staffMeaning, staffPositionWords } from '../lib/plain';
import { Banner, Facts, Lead, Loading, Meaning, Muted, Nav, ScreenTitle, Section, SectionTitle, Sources, Text, Tile } from '../components/ui';

interface Row { id: string; title: string; salary: string }

interface Props {
  boot: Bootstrap;
  onOpenCard: (cardId: string) => void;
  onBack: () => void;
  onHome: () => void;
}

export function Staff({ boot, onOpenCard, onBack, onHome }: Props) {
  // Сквозной счётчик строк: номер по длине списка давал бы дубли после удаления середины.
  const nextId = useRef(0);
  const newRow = (title = '', salary = ''): Row => ({ id: `p${(nextId.current += 1)}`, title, salary });
  /** Строки редактора из сохранённой оценки: порядок отчёта, от самых отстающих. */
  const rowsFromResult = (r: StaffResult): Row[] => r.report.positions.map((p) => newRow(p.title, String(p.salary)));
  const [rows, setRows] = useState<Row[]>(() => [newRow(), newRow(), newRow()]);
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
  const addRow = () => setRows((cur) => (cur.length >= 20 ? cur : [...cur, newRow()]));
  const removeRow = (id: string) => setRows((cur) => (cur.length > 1 ? cur.filter((r) => r.id !== id) : cur));

  const assess = async () => {
    setError(null);
    const positions: StaffPositionInput[] = [];
    for (const r of rows) {
      const title = r.title.trim();
      const salary = Number(r.salary.replace(/\D/g, ''));
      if (!title && !r.salary.trim()) continue;
      if (!title) { setError('В каждой строке нужна должность'); return; }
      if (!Number.isFinite(salary) || salary < 1000 || salary > 5_000_000) { setError(`«${title}»: ставка должна быть от 1 000 до 5 000 000 ₽ в месяц`); return; }
      positions.push({ id: r.id, title, salary });
    }
    if (positions.length === 0) { setError('Добавьте хотя бы одну должность со ставкой'); return; }
    if (!regionFns) { setError('Выберите регион, иначе рынок не с чем сравнивать'); return; }
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

  const summary = result?.report.summary ?? null;

  return (
    <div className="sv-page sv-stack">
      <div className="sv-head">
        <ScreenTitle>Мой штат</ScreenTitle>
        <Text>Впишите должности и ставки сотрудников. Покажу, кто получает меньше рынка{regionName ? ` в регионе ${regionName}` : ''}, кого легко переманить и сколько стоит это исправить.</Text>
      </div>

      {demo && <Banner>Демо-режим: расчёт работает, но список не сохранится. Внутри MAX штат запоминается и открывается по команде /staff.</Banner>}

      <Section>
        <label className="sv-field">
          <SectionTitle>Регион</SectionTitle>
          <select className="sv-select" value={regionFns} onChange={(e) => setRegionFns(e.target.value)}>
            {boot.regions.map((r) => <option key={r.fnsCode} value={r.fnsCode}>{r.name}</option>)}
          </select>
          <Muted>Рынок сравниваем по этому региону{boot.user.inn ? `; профиль бизнеса по ИНН ${boot.user.inn}` : ''}.</Muted>
        </label>
        <SectionTitle>Должности и ставки</SectionTitle>
        {loading && <div className="sv-center"><Spinner /></div>}
        {!loading && rows.map((r, i) => (
          <div key={r.id} className="sv-staff-row">
            <Input placeholder={i === 0 ? 'повар' : 'должность'} value={r.title} onChange={(e) => setRow(r.id, { title: e.target.value })} />
            <Input inputMode="numeric" placeholder={i === 0 ? '60000' : 'ставка, ₽'} value={r.salary} onChange={(e) => setRow(r.id, { salary: e.target.value })} />
            <button type="button" className="sv-iconbtn" title="Удалить строку" aria-label="Удалить строку" onClick={() => removeRow(r.id)}>×</button>
          </div>
        ))}
        {error && <Banner kind="error">{error}</Banner>}
        <div className="sv-actions">
          <Button stretched variant="secondary" onClick={addRow} disabled={rows.length >= 20}>Добавить должность</Button>
          <Button stretched onClick={() => void assess()} loading={busy} disabled={busy}>Сравнить с рынком</Button>
        </div>
        <Muted>Не больше 20 должностей за раз. Ставка: оклад в месяц до вычета НДФЛ.</Muted>
      </Section>

      {busy && <Loading inline title="Считаю по живым объявлениям" text="По каждой должности запрашиваю вакансии «Работы России» и размеры работодателей из реестра МСП. Обычно 10–40 секунд на должность." />}

      {result && summary && !busy && (
        <>
          <Section title="Что получилось">
            <Lead>{staffLead(summary)}</Lead>
            <div className="sv-tiles">
              <Tile tone="bad" label="Легко переманить" value={summary.highRisk} note="получают меньше, чем три четверти рынка" />
              <Tile tone="warn" label="Ниже обычной ставки" value={summary.mediumRisk} note="меньше половины рынка, но не в зоне риска" />
              <Tile tone="ok" label="Как большинство" value={summary.inMarket} note="ставка в рынке или выше" />
              <Tile label="Фонд оплаты" value={rub(summary.payroll)} note={`оклады ${nWord(summary.positions, 'должности', 'должностей', 'должностей')} в месяц`} />
            </div>
            <Meaning>{staffMeaning(summary) || 'Данных по рынку не хватает, чтобы посчитать доплату.'}</Meaning>
            {summary.unknown > 0 && <Muted>По {nWord(summary.unknown, 'должности', 'должностям', 'должностям')} рынок не посчитан: попробуйте написать название иначе, как в объявлениях.</Muted>}
          </Section>

          <Section title="По каждому сотруднику">
            <Muted>Сначала те, кого легче всего переманить.</Muted>
            <div className="sv-list">
              {result.report.positions.map((p) => {
                const cardId = cardIdFor(p.professionKey);
                return (
                  <div key={p.id} className="sv-record">
                    <div className="sv-row">
                      <div className="sv-record__title">{p.title}</div>
                      <span className={`sv-badge ${staffRiskClass(p.risk)}`}>{staffRiskLabel(p.risk)}</span>
                    </div>
                    <Text>{staffPositionWords(p)}</Text>
                    <Facts items={[
                      { label: 'Ставка сейчас', value: rub(p.salary) },
                      { label: 'Обычная ставка', value: p.median != null ? rub(p.median) : '–' },
                      { label: 'Доплатить', value: p.risk === 'unknown' ? '–' : p.gapRub > 0 ? rub(p.gapRub) : 'не нужно' },
                    ]} />
                    {cardId && <button type="button" className="sv-link sv-linkbtn" onClick={() => onOpenCard(cardId)}>Подробный разбор: «{p.professionTitle}»</button>}
                  </div>
                );
              })}
            </div>
          </Section>

          <Sources sources={result.sources}>
            <Muted>
              Обычная ставка – середина рынка по объявлениям «Работы России» в регионе {result.region.name}: половина работодателей платит меньше, половина больше. «Легко переманить» – ставка ниже, чем у трёх четвертей работодателей. «Доплатить» – разница до обычной ставки. Отрасль: {result.pack.title}. Все цифры взяты из объявлений, ничего не придумано.
            </Muted>
          </Sources>
        </>
      )}

      <Nav onBack={onBack} onHome={onHome} />
    </div>
  );
}
