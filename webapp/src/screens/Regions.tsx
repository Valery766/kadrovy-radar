import { useMemo, useState } from 'react';
import { Button, Input, Spinner } from '@maxhub/max-ui';
import { ProfessionPicker, type ProfessionChoice } from '../components/ProfessionPicker';
import { api, ApiError, fmtDate, rub, type Bootstrap, type RegionComparisonRow, type RegionSort, type RegionsResult } from '../lib/api';
import { haptic } from '../lib/bridge';
import type { MarketQuery } from './Query';

/** Столько же, сколько принимает сервер (services/regions.ts: MAX_REGIONS). */
const MAX_REGIONS = 8;

const SORT_LABEL: Record<RegionSort, string> = {
  median: 'по медиане (дешевле сверху)',
  affordability: 'по индексу доступности',
  vacancies: 'по числу вакансий',
};

interface Props {
  boot: Bootstrap;
  prefill?: { professionKey?: string; professionTitle?: string; regionFnsCode?: string | null; offer?: number | null };
  onOpenMarket: (p: MarketQuery) => void;
  onBack: () => void;
  onHome: () => void;
}

export function Regions({ boot, prefill, onOpenMarket, onBack, onHome }: Props) {
  const [profession, setProfession] = useState<ProfessionChoice>(() => {
    const key = prefill?.professionKey ?? null;
    const found = key ? boot.professions.find((p) => p.key === key) ?? null : null;
    if (found) return { key: found.key, title: found.title };
    if (key && prefill?.professionTitle) return { key, title: prefill.professionTitle };
    const first = boot.professions[0];
    return first ? { key: first.key, title: first.title } : { key: null, title: '' };
  });
  const [codes, setCodes] = useState<string[]>(() => {
    const own = prefill?.regionFnsCode ?? boot.user.regionFnsCode ?? null;
    return own ? [own] : [];
  });
  const [sortBy, setSortBy] = useState<RegionSort>('median');
  const [offer, setOffer] = useState<string>(prefill?.offer ? String(prefill.offer) : '');
  const [result, setResult] = useState<RegionsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(() => codes.map((c) => boot.regions.find((r) => r.fnsCode === c)).filter((r): r is NonNullable<typeof r> => Boolean(r)), [codes, boot.regions]);
  const rest = useMemo(() => boot.regions.filter((r) => !codes.includes(r.fnsCode)), [codes, boot.regions]);

  /**
   * Порядок строк задаёт выбранная сортировка: уже посчитанную таблицу
   * переупорядочиваем на месте, без повторного запроса (правила — как на сервере,
   * core/regions.ts: регионы без данных уходят в конец).
   */
  const rows = useMemo(() => {
    const all = result?.comparison.rows;
    if (!all) return [];
    const withData = all.filter((r) => r.median != null && !r.error);
    const withoutData = all.filter((r) => !(r.median != null && !r.error));
    const key = (r: RegionComparisonRow): number => {
      if (sortBy === 'affordability') return r.affordability ?? Number.POSITIVE_INFINITY;
      if (sortBy === 'vacancies') return -r.vacancies;
      return r.median ?? Number.POSITIVE_INFINITY;
    };
    withData.sort((a, b) => key(a) - key(b) || a.regionName.localeCompare(b.regionName, 'ru'));
    return [...withData.map((r, i) => ({ ...r, rank: i + 1 })), ...withoutData];
  }, [result, sortBy]);

  const add = (fnsCode: string) => { if (fnsCode && codes.length < MAX_REGIONS && !codes.includes(fnsCode)) setCodes([...codes, fnsCode]); };
  const remove = (fnsCode: string) => setCodes(codes.filter((c) => c !== fnsCode));

  const compare = async () => {
    setError(null);
    if (codes.length === 0) { setError('Выберите хотя бы один регион'); return; }
    const title = profession.title.trim();
    if (!profession.key && !title) { setError('Выберите должность или напишите её название'); return; }
    const o = offer.replace(/\D/g, '');
    const offerNum = o ? Number(o) : null;
    if (offerNum != null && (offerNum < 1000 || offerNum > 5_000_000)) { setError('Ставка — от 1 000 до 5 000 000 ₽ в месяц'); return; }
    setBusy(true);
    try {
      const r = await api.compareRegions({
        professionKey: profession.key ?? undefined,
        professionText: title || undefined,
        regionFnsCodes: codes,
        offer: offerNum,
        sortBy,
      });
      setResult(r);
      haptic('success');
    } catch (e) {
      haptic('error');
      setError(e instanceof ApiError ? e.message : 'Не удалось сравнить регионы');
    } finally { setBusy(false); }
  };

  const openCard = (fnsCode: string) => {
    const o = offer.replace(/\D/g, '');
    onOpenMarket({
      regionFnsCode: fnsCode,
      professionKey: result?.profession.key ?? profession.key ?? undefined,
      professionText: result?.profession.title ?? profession.title.trim() ?? undefined,
      offer: o ? Number(o) : null,
      inn: boot.user.inn ?? null,
      // Смотрим чужой регион из сравнения — домашний регион профиля менять не нужно.
      keepRegion: true,
    });
  };

  return (
    <div className="sv-page sv-stack">
      <div>
        <div className="sv-title">Сравнить регионы</div>
        <div className="sv-muted sv-small">Открываете точку в другом городе или нанимаете вахтой — посмотрите, где люди дешевле и где их больше. До {MAX_REGIONS} регионов за раз.</div>
      </div>

      <div className="sv-card sv-stack">
        <ProfessionPicker quick={boot.packs.find((p) => p.id === boot.user.pack.id)?.professions ?? boot.professions.slice(0, 8)} value={profession} onChange={setProfession} />

        <div className="sv-stack" style={{ gap: 6 }}>
          <span className="sv-h2" style={{ margin: 0 }}>Регионы ({codes.length} из {MAX_REGIONS})</span>
          <div className="sv-chips">
            {selected.map((r) => (
              <button key={r.fnsCode} type="button" className="sv-chip sv-chip--active" onClick={() => remove(r.fnsCode)}>{r.name} ×</button>
            ))}
            {selected.length === 0 && <span className="sv-muted sv-small">Ни одного региона не выбрано</span>}
          </div>
          <select className="sv-select" value="" disabled={codes.length >= MAX_REGIONS} onChange={(e) => add(e.target.value)}>
            <option value="">{codes.length >= MAX_REGIONS ? 'Достигнут предел в 8 регионов' : 'Добавить регион…'}</option>
            {rest.map((r) => <option key={r.fnsCode} value={r.fnsCode}>{r.name}</option>)}
          </select>
        </div>

        <label className="sv-stack" style={{ gap: 6 }}>
          <span className="sv-h2" style={{ margin: 0 }}>Сортировка</span>
          <select className="sv-select" value={sortBy} onChange={(e) => setSortBy(e.target.value as RegionSort)}>
            {(Object.keys(SORT_LABEL) as RegionSort[]).map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
          </select>
        </label>

        <label className="sv-stack" style={{ gap: 6 }}>
          <span className="sv-h2" style={{ margin: 0 }}>Ваша ставка, ₽ в месяц</span>
          <Input inputMode="numeric" placeholder="например 60000" value={offer} onChange={(e) => setOffer(e.target.value)} hint="Необязательно: покажу её перцентиль в каждом регионе" />
        </label>

        {error && <div className="sv-banner sv-banner--error">{error}</div>}
        <Button stretched onClick={() => void compare()} loading={busy} disabled={busy}>Сравнить</Button>
      </div>

      {busy && (
        <div className="sv-card sv-stack">
          <div className="sv-center"><Spinner /></div>
          <div className="sv-center sv-muted sv-small">Считаю рынок в каждом регионе: запросы идут пачками по три, это может занять до минуты.</div>
        </div>
      )}

      {result && !busy && (
        <>
          <div className="sv-card">
            <div className="sv-h2">«{result.profession.title}» — {result.comparison.summary.withData} из {result.comparison.summary.regions} регионов с данными</div>
            <div className="sv-table">
              <div className="sv-table__head sv-table__row sv-table__row--regions">
                <div>Регион</div><div>Медиана</div><div>Половина предложений</div><div>Вакансий</div>
              </div>
              {rows.map((r) => (
                <div key={r.fnsCode} className="sv-table__row sv-table__row--regions">
                  <div>
                    <div className="sv-item__title">{r.rank ? `${r.rank}. ` : ''}{r.regionName}</div>
                    <div className="sv-chips" style={{ marginTop: 4 }}>
                      {r.affordability != null && <span className="sv-badge sv-badge--muted">доступность {r.affordability.toFixed(2)}</span>}
                      {r.offerPercentile != null && <span className="sv-badge">ваша ставка — {r.offerPercentile}-й перц.</span>}
                      {r.confidence === 'low' && <span className="sv-badge sv-badge--warn">данных мало</span>}
                    </div>
                    {r.error && <div className="sv-muted sv-small">{r.error}</div>}
                    {!r.error && <button type="button" className="sv-link sv-linkbtn" onClick={() => openCard(r.fnsCode)}>открыть карточку</button>}
                  </div>
                  <div className="sv-item__value" data-label="Медиана">{r.median != null ? rub(r.median) : '—'}</div>
                  <div className="sv-item__value" data-label="Половина предл.">{r.p25 != null && r.p75 != null ? `${Math.round(r.p25 / 1000)}–${Math.round(r.p75 / 1000)} тыс.` : '—'}</div>
                  <div className="sv-item__value" data-label="Вак. / работ.">{r.vacancies} / {r.employers}</div>
                </div>
              ))}
            </div>
            {result.comparison.summary.spreadPct != null && (
              <div className="sv-muted sv-small" style={{ marginTop: 8 }}>
                Разрыв между крайними регионами — {result.comparison.summary.spreadPct} %. Индекс доступности — медиана профессии, делённая на среднюю зарплату региона: чем меньше, тем дешевле профессия относительно местного рынка труда. «Вак. / работ.» — размер выборки по региону.
              </div>
            )}
          </div>

          <div className="sv-card sv-stack" style={{ gap: 6 }}>
            <div className="sv-h2">Источники</div>
            {result.sources.map((s) => <div key={s.id} className="sv-small">{s.title} · получено {fmtDate(s.fetchedAt)}{s.note ? ` · ${s.note}` : ''}</div>)}
          </div>
        </>
      )}

      <div className="sv-actions">
        <Button stretched variant="ghost" onClick={onBack}>Назад</Button>
        <Button stretched variant="ghost" onClick={onHome}>На главную</Button>
      </div>
    </div>
  );
}
