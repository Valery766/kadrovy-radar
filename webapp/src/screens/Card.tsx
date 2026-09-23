import { useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { api, ApiError, categoryLabel, fmtDate, rub, type Bootstrap, type MarketResult, type VacancyView } from '../lib/api';
import { haptic, shareLink, shareMid } from '../lib/bridge';
import {
  ads, adsDat, bandClass, bandWords, categoryGen, categoryShort, categorySize, dayShort, droppedWords, employers,
  inMonth, inPrevMonth, offerVerdict, onDate, pctWord, rubRange, sampleWords, timesWord,
} from '../lib/plain';
import { Banner, ExternalLink, Lead, Meaning, Muted, Nav, Overline, Section, SectionTitle, Sources, Text, Tile } from '../components/ui';

interface Props {
  result: MarketResult;
  boot: Bootstrap;
  notInMax: boolean;
  onRecalc: (offer: number | null) => void;
  onAnother: () => void;
  onText: (salary: number) => void;
  onOpenInbox: (vacancyId: string) => void;
  onCompareRegions: () => void;
  onBack: () => void;
  onHome: () => void;
}

const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Подпись месяца по дате «2026-08-24» → «авг 2026». */
const monthLabel = (day: string): string => `${MONTH_SHORT[Number(day.slice(5, 7)) - 1] ?? ''} ${day.slice(0, 4)}`;
/** «2026-08-24» → «24.08.2026». */
const dayFull = (iso: string): string => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso); return m ? `${m[3]}.${m[2]}.${m[1]}` : iso; };

/**
 * Сезонность набора: столбик на неделю публикации вакансий, пик выделен цветом.
 * Ось подписываем тремя месяцами (начало, середина, конец): на узком экране
 * подписи у каждого столбика налезают друг на друга.
 */
function Seasons({ seasonality }: { seasonality: NonNullable<MarketResult['card']['seasonality']> }) {
  const weeks = seasonality.weeks;
  const max = Math.max(...weeks.map((w) => w.count), 1);
  const middle = weeks[Math.floor(weeks.length / 2)];
  return (
    <>
      <div className="sv-hist sv-hist--weeks">
        {weeks.map((w) => (
          <div key={w.week} className="sv-hist__col">
            <div
              className={`sv-hist__bar ${seasonality.peak?.week === w.week ? 'sv-hist__bar--peak' : ''}`}
              style={{ height: `${Math.max(2, (w.count / max) * 100)}%` }}
              title={`${dayFull(w.from)} – ${dayFull(w.to)}: ${ads(w.count)}`}
            />
          </div>
        ))}
      </div>
      <div className="sv-axis">
        <span>{weeks[0] ? monthLabel(weeks[0].from) : ''}</span>
        <span>{middle ? monthLabel(middle.from) : ''}</span>
        <span>{weeks.length > 1 ? monthLabel(weeks[weeks.length - 1]!.to) : ''}</span>
      </div>
      <div className="sv-legend"><span><i className="sv-legend__dot" />объявлений за неделю</span><span><i className="sv-legend__dot sv-legend__dot--peak" />самая активная неделя</span></div>
    </>
  );
}

/** Подписи вариантов ставки: те же слова, что в боте и в отчёте. */
const OPTION_LABEL: Record<string, string> = { keep: 'оставить как есть', median: 'как большинство', top: 'больше трёх четвертей' };

function Scale({ stats, offer }: { stats: NonNullable<MarketResult['card']['stats']>; offer: MarketResult['card']['offer'] }) {
  const value = offer?.value ?? null;
  const lo = Math.min(stats.p25 * 0.8, value ?? Infinity);
  const hi = Math.max(stats.p75 * 1.2, value ?? 0);
  const pos = (v: number) => `${Math.max(2, Math.min(98, ((v - lo) / (hi - lo)) * 100))}%`;
  // Подписи вынесены под шкалу отдельной строкой: на 375 px три подписи у своих засечек налезают друг на друга.
  return (
    <>
      <div className="sv-scale" aria-hidden="true">
        <div className="sv-scale__bar" />
        <div className="sv-scale__pin" style={{ left: pos(stats.p25) }} />
        <div className="sv-scale__pin" style={{ left: pos(stats.median) }} />
        <div className="sv-scale__pin" style={{ left: pos(stats.p75) }} />
        {value != null && <div className="sv-scale__marker" style={{ left: pos(value) }} />}
      </div>
      <div className="sv-scale__legend">
        <span>четверть платит меньше<b>{rub(stats.p25)}</b></span>
        <span>обычная ставка<b>{rub(stats.median)}</b></span>
        <span>четверть платит больше<b>{rub(stats.p75)}</b></span>
      </div>
      {offer && <div className="sv-scale__you">Ваша ставка {rub(offer.value)}: {bandWords(offer.band)}</div>}
    </>
  );
}

export function Card({ result, boot, notInMax, onRecalc, onAnother, onText, onOpenInbox, onCompareRegions, onBack, onHome }: Props) {
  const { card, profession, region, profile, sources, fetched, closure } = result;
  const [selected, setSelected] = useState<string>(card.options.find((o) => o.kind === 'median')?.kind ?? 'keep');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [mid, setMid] = useState<string | null>(null);
  const [vacancy, setVacancy] = useState<VacancyView | null>(null);
  const [pubNote, setPubNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const selectedOpt = card.options.find((o) => o.kind === selected) ?? card.options[0] ?? null;
  const stats = card.stats;
  const offer = card.offer;

  const publish = async () => {
    setPubNote(null); setBusy('publish');
    try {
      const r = await api.publishVacancy(result.cardId, { salary: selectedOpt?.value ?? null });
      setVacancy(r.vacancy);
      haptic('success');
      setPubNote({ kind: 'info', text: r.qrSent ? 'Вакансия опубликована: карточка с QR-кодом отправлена в ваш чат с ботом.' : 'Вакансия опубликована. Ссылку можно скопировать ниже.' });
    } catch (e) { setPubNote({ kind: 'error', text: e instanceof ApiError ? e.message : 'Не удалось опубликовать вакансию' }); haptic('error'); }
    finally { setBusy(null); }
  };

  const shareVacancy = async () => {
    if (!vacancy?.link) return;
    const text = `Вакансия: ${profession.title}, ${region.name}${vacancy.salary ? `, от ${rub(vacancy.salary)}` : ''}. Откликнуться в MAX:`;
    const r = await shareLink(text, vacancy.link);
    if (r !== 'shared') {
      try { await navigator.clipboard.writeText(`${text} ${vacancy.link}`); setPubNote({ kind: 'info', text: 'Ссылка на вакансию скопирована.' }); }
      catch { setPubNote({ kind: 'info', text: vacancy.link }); }
    }
  };

  const sendReport = async () => {
    setNote(null); setBusy('report');
    try {
      const r = await api.report(result.cardId);
      setMid(r.mid);
      haptic('success');
      setNote({ kind: 'info', text: r.reused ? 'Отчёт уже в вашем чате с ботом. Теперь его можно переслать коллеге.' : 'PDF-отчёт отправлен в ваш чат с ботом. Теперь его можно переслать коллеге.' });
    } catch (e) { setNote({ kind: 'error', text: e instanceof ApiError ? e.message : 'Не удалось отправить отчёт' }); haptic('error'); }
    finally { setBusy(null); }
  };

  const share = async () => {
    if (!mid) return;
    setBusy('share');
    const r = await shareMid(mid, 'DIALOG');
    setBusy(null);
    if (r === 'shared') setNote({ kind: 'info', text: 'Отчёт переслан.' });
    else if (r === 'unsupported') setNote({ kind: 'error', text: 'Пересылка доступна только внутри MAX. Откройте приложение из чата с ботом.' });
    else setNote({ kind: 'error', text: 'Пересылка не удалась. Можно переслать сообщение с отчётом вручную из чата с ботом.' });
  };

  const shareCardLink = async () => {
    const link = boot.bot ? `https://max.ru/${boot.bot.username}?startapp=card_${result.cardId}` : window.location.href;
    const text = `Кадровый радар: ${profession.title}, ${region.name}.${stats ? ` Обычная ставка ${rub(stats.median)}.` : ''} Карточка рынка:`;
    const r = await shareLink(text, link);
    if (r !== 'shared') {
      try { await navigator.clipboard.writeText(`${text} ${link}`); setNote({ kind: 'info', text: 'Ссылка на карточку скопирована.' }); } catch { setNote({ kind: 'info', text: link }); }
    }
  };

  const subscribe = async () => {
    setBusy('sub');
    try { await api.subscribe(result.cardId); setNote({ kind: 'info', text: 'Подписка оформлена: раз в неделю бот пересчитает рынок и напишет, если обычная ставка сдвинется больше чем на 5 %.' }); haptic('success'); }
    catch (e) { setNote({ kind: 'error', text: e instanceof ApiError ? e.message : 'Не удалось оформить подписку' }); }
    finally { setBusy(null); }
  };

  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

  /* ---------- вывод и объяснения (считаются на клиенте из чисел карточки) ---------- */
  /** Сколько из 100 работодателей платят больше: везде считаем от перцентиля, чтобы числа на экране совпадали. */
  const above = offer ? 100 - offer.percentile : 0;
  const verdict = offer
    ? offerVerdict(offer.band, above)
    : stats
      ? `Обычная ставка «${profession.title}»: ${rub(stats.median)}. Половина работодателей платит меньше, половина больше`
      : `По должности «${profession.title}» в регионе ${region.name} объявлений с зарплатой не нашлось`;

  const sameSize = card.sameSize && card.sameSize.median != null && card.sameSize.employers >= 3 ? card.sameSize : null;
  const sameSizeWho = sameSize ? (sameSize.category ? `Такие же ${categoryShort(sameSize.category).toLowerCase()}, как ваше,` : 'Компании вашего размера') : '';
  const sameSizeNote = sameSize && stats
    ? ` ${sameSizeWho} платят ${rub(sameSize.median!)}: ${sameSize.median! > stats.median ? 'больше' : sameSize.median! < stats.median ? 'меньше' : 'столько же'}, чем рынок в целом. Сравнивайте себя с ними.`
    : '';

  const meaning = (): string => {
    if (!stats) return 'Без объявлений сравнивать не с чем. Попробуйте другое название должности или соседний регион.';
    if (!offer) return `Половина объявлений укладывается в ${rubRange(stats.p25, stats.p75)}. Укажите свою ставку, и я покажу, где она на этой шкале.${sameSizeNote}`;
    if (offer.band === 'low' || offer.band === 'below_median') {
      return `Кандидаты сравнивают объявления: ${above} из 100 обещают больше, чем вы. Чтобы платить как большинство, нужно ${rub(stats.median)}, это на ${rub(stats.median - offer.value)} больше вашей ставки.${sameSizeNote}`;
    }
    if (offer.band === 'market') return `Ваша ставка в середине рынка: половина работодателей платит меньше, половина больше. Чтобы обгонять три четверти конкурентов, нужно от ${rub(stats.p75)}.${sameSizeNote}`;
    return `Ставка уже привлекательна: больше платят только ${above} из 100 работодателей. Дальше решают условия и скорость ответа кандидатам.${sameSizeNote}`;
  };

  const confidenceBadge = card.confidence === 'ok'
    ? { cls: 'sv-badge--ok', text: 'объявлений достаточно' }
    : card.confidence === 'low' ? { cls: 'sv-badge--warn', text: 'объявлений мало: цифры как ориентир' } : { cls: 'sv-badge--bad', text: 'объявлений нет' };

  const catTotal = card.byCategory.reduce((s, c) => s + c.vacancies, 0);
  const catTop = card.byCategory.length ? card.byCategory.reduce((a, b) => (b.vacancies > a.vacancies ? b : a)) : null;
  const catBest = card.byCategory.filter((c) => c.median != null).reduce<typeof catTop>((a, b) => (a == null || (b.median ?? 0) > (a.median ?? 0) ? b : a), null);
  const whoHires = catTop
    ? catBest && catBest !== catTop && catBest.median != null
      ? `Больше всего объявлений у ${categoryGen(catTop.category)}: ${catTop.vacancies} из ${catTotal}. Больше всех платят ${categoryGen(catBest.category)}: ${rub(catBest.median)}.`
      : `Больше всего объявлений у ${categoryGen(catTop.category)}: ${catTop.vacancies} из ${catTotal}${catTop.median != null ? `, платят ${rub(catTop.median)}` : ''}.`
    : '';

  const season = card.seasonality;
  const dropped = droppedWords(card.sample.dropped);

  return (
    <div className="sv-page sv-stack">
      <div className="sv-head">
        <Overline>{profession.title} · {region.name}</Overline>
        <Lead>{verdict}</Lead>
        <Muted>{offer ? `Ваша ставка ${rub(offer.value)}. ` : ''}Посчитано по {adsDat(card.sample.vacancies)} {employers(card.sample.employers)}, «Работа России» {onDate(fetched.fetchedAt)}.</Muted>
        <div className="sv-chips">
          {offer && <span className={`sv-badge ${bandClass(offer.band)}`}>{bandWords(offer.band)}</span>}
          <span className={`sv-badge ${confidenceBadge.cls}`}>{confidenceBadge.text}</span>
        </div>
      </div>

      {card.confidence === 'low' && <Banner>Нашлось только {ads(card.sample.vacancies)} от {employers(card.sample.employers)}: этого мало для уверенного вывода. Цифры ниже – ориентир. Посмотрите соседний регион или похожую должность.</Banner>}
      {card.confidence === 'none' && <Banner>Объявлений с зарплатой по этой должности не нашлось. Попробуйте другое название должности или соседний регион.</Banner>}

      {stats && (
        <Section title={offer ? 'Где ваша ставка на рынке' : 'Рынок в цифрах'}>
          <Scale stats={stats} offer={offer} />
          <div className="sv-tiles">
            <Tile label="Обычная ставка" value={rub(stats.median)} note="половина платит меньше, половина больше" />
            <Tile label="Коридор большинства" value={rubRange(stats.p25, stats.p75)} long note="половина объявлений попадает сюда" />
            {card.sameSize?.median != null
              ? <Tile label="Компании вашего размера" value={rub(card.sameSize.median)} note={`${categoryShort(card.sameSize.category).toLowerCase()}, ${categorySize(card.sameSize.category)}: ${employers(card.sameSize.employers)}`} />
              : region.avgSalary
                ? <Tile label="Средняя зарплата в регионе" value={rub(region.avgSalary)} note="по всем профессиям, для сравнения" />
                : <Tile label="Работодателей" value={card.sample.employers.toLocaleString('ru-RU')} note="повторы одного работодателя считаем один раз" />}
            <Tile label="Объявлений в расчёте" value={card.sample.vacancies.toLocaleString('ru-RU')} note={`из ${fetched.total.toLocaleString('ru-RU')} найденных, от ${employers(card.sample.employers)}`} />
          </div>
          <Meaning>{meaning()}</Meaning>
        </Section>
      )}

      {card.options.length > 0 && (
        <Section title="Что дальше: выберите ставку">
          <Muted>Варианты по рынку. Нажмите на вариант: по нему соберу текст вакансии и опубликую её.</Muted>
          <div className="sv-options" role="radiogroup" aria-label="Варианты ставки">
            {card.options.map((o) => (
              <button key={o.kind} type="button" role="radio" aria-checked={selected === o.kind} className={`sv-option ${selected === o.kind ? 'sv-option--active' : ''}`} onClick={() => setSelected(o.kind)}>
                <div className="sv-option__value">{rub(o.value)}</div>
                <div className="sv-option__label">{OPTION_LABEL[o.kind] ?? o.label}</div>
                <div className="sv-option__label">больше платят {100 - o.percentile} из 100</div>
              </button>
            ))}
          </div>
          {selectedOpt && (
            <Text>
              С {rub(selectedOpt.value)} вы будете платить больше, чем {selectedOpt.percentile} из 100 работодателей
              {offer && selectedOpt.kind !== 'keep' ? `: это на ${rub(selectedOpt.value - offer.value)} больше нынешней ставки` : ''}.
            </Text>
          )}
          <div className="sv-actions">
            <Button stretched onClick={() => selectedOpt && onText(selectedOpt.value)}>Текст вакансии</Button>
            {selectedOpt && selectedOpt.kind !== 'keep' && <Button stretched variant="secondary" onClick={() => onRecalc(selectedOpt.value)}>Пересчитать с {rub(selectedOpt.value)}</Button>}
          </div>
        </Section>
      )}

      <Section title="Опубликовать вакансию">
        <Muted>
          Бот пришлёт карточку вакансии со ссылкой и QR-кодом. Перешлите её в чаты сотрудников и партнёров или распечатайте QR. Кандидат ответит на три вопроса прямо в MAX, отклики придут в раздел «Вакансии и отклики».
        </Muted>
        {pubNote && <Banner kind={pubNote.kind === 'error' ? 'error' : 'info'}>{pubNote.text}</Banner>}
        {vacancy?.link && <Muted>Ссылка для кандидатов: {vacancy.link}</Muted>}
        <div className="sv-actions">
          {!vacancy && (
            <Button stretched onClick={publish} loading={busy === 'publish'} disabled={busy !== null || notInMax}>
              Опубликовать{selectedOpt ? ` на ${rub(selectedOpt.value)}` : ' вакансию'}
            </Button>
          )}
          {vacancy && <Button stretched disabled={!vacancy.link} onClick={shareVacancy}>Поделиться в MAX</Button>}
          {vacancy && <Button stretched variant="secondary" onClick={() => onOpenInbox(vacancy.id)}>Вакансии и отклики</Button>}
        </div>
        {notInMax && !vacancy && <Muted>Публикация работает внутри MAX: откройте приложение из чата с ботом.</Muted>}
      </Section>

      {card.histogram.length > 1 && (
        <Section title="Сколько платят другие">
          <div className="sv-hist">
            {card.histogram.map((b) => {
              const max = Math.max(...card.histogram.map((x) => x.count), 1);
              const isOffer = offer && offer.value >= b.from && offer.value < b.to;
              return <div key={b.from} className="sv-hist__col"><div className={`sv-hist__bar ${isOffer ? 'sv-hist__bar--offer' : ''}`} style={{ height: `${Math.max(4, (b.count / max) * 80)}%` }} title={`${rubRange(b.from, b.to)}: ${ads(b.count)}`} /><div className="sv-hist__label">{Math.round(b.from / 1000)}</div></div>;
            })}
          </div>
          <Muted>
            Высота столбика: сколько объявлений с такой ставкой. Подписи: тысяч ₽ в месяц.{offer ? ' Оранжевый столбик: ваша ставка.' : ''}
            {card.fixedShare != null && ` В ${card.fixedShare} % объявлений указан один оклад, в остальных диапазон от и до.`}
          </Muted>
        </Section>
      )}

      {season && season.weeks.length > 1 && (
        <Section title="Когда искать людей">
          <Seasons seasonality={season} />
          <Text>
            {season.peakMonth
              ? `Чаще всего «${profession.title}» ищут ${inMonth(season.peakMonth.month)}: ${pctWord(season.peakMonth.share)} объявлений за год.`
              : 'Явного пика набора нет: объявления выходят ровно весь год.'}
            {season.peak && ` Самая активная неделя: ${dayShort(season.peak.from)}–${dayShort(season.peak.to)}, ${season.peakRatio ? `объявлений ${timesWord(season.peakRatio)} больше обычной недели` : ads(season.peak.count)}.`}
          </Text>
          <Meaning title="Совет">
            {season.peakMonth ? `Начинайте набор ${inPrevMonth(season.peakMonth.month)}, за месяц до пика` : 'Начинайте набор заранее'}: в пик конкуренция за людей выше, а откликов на одно объявление меньше.
          </Meaning>
          <Muted>По датам публикации {ads(season.dated)}{season.from && season.to ? ` с ${dayFull(season.from)} по ${dayFull(season.to)}` : ''}.</Muted>
        </Section>
      )}

      {card.byCategory.length > 0 && (
        <Section title="Кто нанимает">
          {whoHires && <Text>{whoHires}</Text>}
          <div className="sv-list">
            {card.byCategory.map((c) => (
              <div key={c.label} className="sv-item">
                <div><div className="sv-item__title">{categoryShort(c.category)}</div><div className="sv-item__sub">{categorySize(c.category)} · {employers(c.employers)} · {ads(c.vacancies)}</div></div>
                <div className="sv-item__value">{c.median != null ? rub(c.median) : '–'}<small>обычная ставка</small></div>
              </div>
            ))}
          </div>
          <Muted>Размер компании берём из реестра МСП по ИНН работодателя: микро – до 15 сотрудников, малые – до 100, средние – до 250. Кого в реестре нет, это бюджетные учреждения и крупные компании. Сравнение с компаниями вашего размера честнее, чем со всем рынком.</Muted>
        </Section>
      )}

      {(card.requirements.length > 0 || card.schedules.length > 0) && (
        <Section title="Что пишут в объявлениях">
          {card.requirements.length > 0 && (
            <>
              <Muted>Так пишут работодатели в объявлениях. Число рядом: в скольких объявлениях из 100 это требование встречается.</Muted>
              <div className="sv-chips">{card.requirements.slice(0, 10).map((r) => <span key={r.key} className="sv-badge sv-badge--muted">{r.label} · {r.share} %</span>)}</div>
            </>
          )}
          {card.schedules.length > 0 && (
            <>
              <SectionTitle>График работы</SectionTitle>
              <Muted>Какой график указан в объявлениях, доля от всех.</Muted>
              <div className="sv-chips">{card.schedules.map((s) => <span key={s.label} className="sv-badge sv-badge--muted">{s.label} · {s.share} %</span>)}</div>
            </>
          )}
        </Section>
      )}

      {card.examples.length > 0 && (
        <Section title="Примеры объявлений">
          <Muted>Живые объявления по этой должности: посмотрите, как пишут конкуренты и что обещают.</Muted>
          <div className="sv-list">
            {card.examples.map((e) => (
              <div key={e.id} className="sv-item">
                <div>
                  <div className="sv-item__title">{e.title}</div>
                  <div className="sv-item__sub">{e.employerName ?? 'работодатель'}{e.employerCategory !== undefined ? ` · ${categoryLabel(e.employerCategory)}` : ''}{e.schedule ? ` · ${e.schedule.toLowerCase()}` : ''}{e.url && <> · <ExternalLink href={e.url}>открыть объявление</ExternalLink></>}</div>
                </div>
                <div className="sv-item__value">{e.salaryMin && e.salaryMax && e.salaryMin !== e.salaryMax ? `${Math.round(e.salaryMin / 1000)}–${Math.round(e.salaryMax / 1000)} тыс. ₽` : rub(e.value)}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {closure && closure.observedDays >= 3 && closure.total >= 20 && (
        <Section title="Как быстро закрываются вакансии">
          <Text>За {closure.observedDays} дн. исчезли {pct(closure.closedAbove, closure.totalAbove)} % объявлений со ставкой не ниже обычной и {pct(closure.closedBelow, closure.totalBelow)} % объявлений со ставкой ниже обычной.</Text>
          <Meaning>{pct(closure.closedAbove, closure.totalAbove) > pct(closure.closedBelow, closure.totalBelow) ? 'Объявления с хорошей ставкой закрываются быстрее: люди на них находятся.' : 'Разницы в скорости закрытия пока не видно: наблюдение продолжается.'}</Meaning>
          <Muted>По ежедневным снимкам «Работы России», {ads(closure.total)} под наблюдением. Исчезновение объявления считаем закрытием или снятием вакансии.</Muted>
        </Section>
      )}

      <Section title="Что дальше">
        {note && <Banner kind={note.kind === 'error' ? 'error' : 'info'}>{note.text}</Banner>}
        <div className="sv-actions">
          <Button stretched onClick={sendReport} loading={busy === 'report'} disabled={busy !== null || notInMax}>Прислать PDF-отчёт</Button>
          <Button stretched variant="secondary" onClick={subscribe} loading={busy === 'sub'} disabled={busy !== null || notInMax}>Следить за рынком</Button>
          <Button stretched variant="secondary" onClick={shareCardLink}>Поделиться ссылкой</Button>
          {mid && <Button stretched variant="secondary" onClick={share} loading={busy === 'share'} disabled={busy !== null}>Поделиться отчётом</Button>}
          <Button stretched variant="secondary" onClick={onCompareRegions}>Сравнить регионы</Button>
          <Button stretched variant="ghost" onClick={onAnother}>Другая должность</Button>
        </div>
        <Muted>PDF-отчёт: одна страница с этими же цифрами придёт в ваш чат с ботом, её можно переслать бухгалтеру или партнёру. «Следить за рынком»: раз в неделю пересчитаю и напишу, если обычная ставка сдвинется больше чем на 5 %. Ссылка открывает эту карточку у коллеги прямо в MAX.</Muted>
        {notInMax && <Muted>Отчёт, подписка и публикация работают внутри MAX: откройте приложение из чата с ботом.</Muted>}
      </Section>

      <Sources sources={sources}>
        <Muted>
          {sampleWords(card.sample, fetched.total)}{dropped ? ` Не подошли: ${dropped}.` : ''} Если в объявлении указан диапазон, берём его середину. Повторы одного работодателя считаем один раз, не больше трёх объявлений от компании; крупнейший работодатель даёт {card.sample.topEmployerShare} % объявлений. Обычная ставка – середина рынка: половина платит меньше, половина больше. Все цифры взяты из объявлений на «Работе России», ничего не придумано. Отрасль: {result.pack.title}.
          {profile?.inRegistry && ` Профиль бизнеса: реестр МСП ФНС, ${fmtDate(profile.fetchedAt)}.`}
        </Muted>
      </Sources>

      <Nav onBack={onBack} onHome={onHome} />
    </div>
  );
}
