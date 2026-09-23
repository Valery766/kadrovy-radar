import { useMemo, useState } from 'react';
import { Button, Input } from '@maxhub/max-ui';
import { ProfessionPicker, type ProfessionChoice } from '../components/ProfessionPicker';
import { api, ApiError, rub, type Bootstrap, type RegionComparisonRow, type RegionSort, type RegionsResult } from '../lib/api';
import { haptic } from '../lib/bridge';
import { ads, cheaperWords, employers, regionsLead } from '../lib/plain';
import { Banner, Facts, Lead, Loading, Meaning, Muted, Nav, ScreenTitle, Section, SectionTitle, Sources, Text } from '../components/ui';
import type { MarketQuery } from './Query';

/** Столько же, сколько принимает сервер (services/regions.ts: MAX_REGIONS). */
const MAX_REGIONS = 8;

const SORT_LABEL: Record<RegionSort, string> = {
  median: 'где дешевле нанять (сверху)',
  affordability: 'где должность дешевле относительно местных зарплат',
  vacancies: 'где больше объявлений',
};

interface Props {
  boot: Bootstrap;
  prefill?: { professionKey?: string; professionTitle?: string; regionFnsCode?: string | null; offer?: number | null };
  onOpenMarket: (p: MarketQuery) => void;
  onBack: () => void;
  onHome: () => void;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Вывод по одному региону словами: дешевизна относительно местных зарплат, ваша ставка, размер выборки. */
function rowWords(r: RegionComparisonRow, offer: number | null): string {
  const parts: string[] = [];
  if (r.affordability != null) parts.push(`${capitalize(cheaperWords(r.affordability))}.`);
  if (r.offerPercentile != null && offer != null) parts.push(`Ваша ставка ${rub(offer)} выше, чем у ${r.offerPercentile} из 100 работодателей.`);
  parts.push(`Посчитано по ${ads(r.vacancies)} от ${employers(r.employers)}.`);
  return parts.join(' ');
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
   * переупорядочиваем на месте, без повторного запроса (правила как на сервере,
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

  const offerNumber = (): number | null => { const o = offer.replace(/\D/g, ''); return o ? Number(o) : null; };

  const compare = async () => {
    setError(null);
    if (codes.length === 0) { setError('Выберите хотя бы один регион'); return; }
    const title = profession.title.trim();
    if (!profession.key && !title) { setError('Выберите должность или напишите её название'); return; }
    const offerNum = offerNumber();
    if (offerNum != null && (offerNum < 1000 || offerNum > 5_000_000)) { setError('Ставка должна быть от 1 000 до 5 000 000 ₽ в месяц'); return; }
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
    onOpenMarket({
      regionFnsCode: fnsCode,
      professionKey: result?.profession.key ?? profession.key ?? undefined,
      professionText: result?.profession.title ?? profession.title.trim() ?? undefined,
      offer: offerNumber(),
      inn: boot.user.inn ?? null,
      // Смотрим чужой регион из сравнения: домашний регион профиля менять не нужно.
      keepRegion: true,
    });
  };

  const summary = result?.comparison.summary ?? null;
  const cheapest = summary?.cheapest ? rows.find((r) => r.fnsCode === summary.cheapest) ?? null : null;
  const most = summary?.mostVacancies ? rows.find((r) => r.fnsCode === summary.mostVacancies) ?? null : null;

  return (
    <div className="sv-page sv-stack">
      <div className="sv-head">
        <ScreenTitle>Сравнить регионы</ScreenTitle>
        <Text>Открываете точку в другом городе или нанимаете вахтой: покажу, где эта должность дешевле и где больше объявлений. До {MAX_REGIONS} регионов за раз.</Text>
      </div>

      <Section>
        <ProfessionPicker quick={boot.packs.find((p) => p.id === boot.user.pack.id)?.professions ?? boot.professions.slice(0, 8)} value={profession} onChange={setProfession} />

        <div className="sv-field">
          <SectionTitle>Регионы ({codes.length} из {MAX_REGIONS})</SectionTitle>
          <div className="sv-chips">
            {selected.map((r) => (
              <button key={r.fnsCode} type="button" className="sv-chip sv-chip--active" onClick={() => remove(r.fnsCode)}>{r.name} ×</button>
            ))}
            {selected.length === 0 && <Muted>Ни одного региона не выбрано</Muted>}
          </div>
          <select className="sv-select" value="" disabled={codes.length >= MAX_REGIONS} onChange={(e) => add(e.target.value)}>
            <option value="">{codes.length >= MAX_REGIONS ? `Больше ${MAX_REGIONS} регионов за раз нельзя` : 'Добавить регион…'}</option>
            {rest.map((r) => <option key={r.fnsCode} value={r.fnsCode}>{r.name}</option>)}
          </select>
          <Muted>Нажмите на регион в списке выбранных, чтобы убрать его.</Muted>
        </div>

        <label className="sv-field">
          <SectionTitle>Порядок в списке</SectionTitle>
          <select className="sv-select" value={sortBy} onChange={(e) => setSortBy(e.target.value as RegionSort)}>
            {(Object.keys(SORT_LABEL) as RegionSort[]).map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
          </select>
        </label>

        <label className="sv-field">
          <SectionTitle>Ваша ставка, ₽ в месяц</SectionTitle>
          <Input inputMode="numeric" placeholder="например 60000" value={offer} onChange={(e) => setOffer(e.target.value)} hint="Необязательно: покажу, как ваша ставка смотрится в каждом регионе." />
        </label>

        {error && <Banner kind="error">{error}</Banner>}
        <Button stretched onClick={() => void compare()} loading={busy} disabled={busy}>Сравнить регионы</Button>
      </Section>

      {busy && <Loading inline title="Считаю по живым объявлениям" text="В каждом регионе запрашиваю вакансии «Работы России», по три региона за раз. Обычно 10–40 секунд на регион." />}

      {result && summary && !busy && (
        <>
          <Section title={`«${result.profession.title}»: ${summary.withData} из ${summary.regions} регионов с данными`}>
            <Lead>{regionsLead(result.profession.title, rows, summary.spreadPct)}</Lead>
            <div className="sv-list">
              {rows.map((r) => (
                <div key={r.fnsCode} className="sv-record">
                  <div className="sv-row">
                    <div className="sv-record__title">{r.rank ? `${r.rank}. ` : ''}{r.regionName}</div>
                    {r.confidence === 'low' && <span className="sv-badge sv-badge--warn">объявлений мало</span>}
                  </div>
                  {r.error ? <Muted>{r.error}</Muted> : <Text>{rowWords(r, offerNumber())}</Text>}
                  {!r.error && (
                    <Facts items={[
                      { label: 'Обычная ставка', value: r.median != null ? rub(r.median) : '–' },
                      { label: 'Коридор большинства', value: r.p25 != null && r.p75 != null ? `${Math.round(r.p25 / 1000)}–${Math.round(r.p75 / 1000)} тыс. ₽` : '–' },
                      { label: 'Объявлений', value: r.vacancies.toLocaleString('ru-RU') },
                    ]} />
                  )}
                  {!r.error && <button type="button" className="sv-link sv-linkbtn" onClick={() => openCard(r.fnsCode)}>Подробный разбор: {r.regionName}</button>}
                </div>
              ))}
            </div>
            {(cheapest || most) && (
              <Meaning>
                {cheapest && `Самая низкая обычная ставка: ${cheapest.regionName}. `}
                {most && `Больше всего объявлений, а значит и конкуренции за людей: ${most.regionName}. `}
                Для вахты считайте доплату к ставке домашнего региона, для новой точки закладывайте обычную ставку её региона.
              </Meaning>
            )}
            <Muted>«Обычная ставка» – половина работодателей платит меньше, половина больше. «Коридор большинства» – половина объявлений укладывается в эти суммы. «Дешевле средней по региону» – сравниваем ставку должности со средней зарплатой региона по всем профессиям: чем дешевле, тем легче нанять здесь на местные деньги.</Muted>
          </Section>

          <Sources sources={result.sources} />
        </>
      )}

      <Nav onBack={onBack} onHome={onHome} />
    </div>
  );
}
