import { useState } from 'react';
import { Button } from '@maxhub/max-ui';
import { api, ApiError, categoryLabel, fmtDate, rub, type Bootstrap, type MarketResult, type VacancyView } from '../lib/api';
import { haptic, shareLink, shareMid, webApp } from '../lib/bridge';

interface Props {
  result: MarketResult;
  boot: Bootstrap;
  notInMax: boolean;
  onRecalc: (offer: number | null) => void;
  onAnother: () => void;
  onText: (salary: number) => void;
  onOpenInbox: (vacancyId: string) => void;
  onCompareRegions: () => void;
  onHome: () => void;
}

const MONTH_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Подпись месяца по дате «2026-08-24» → «авг 2026». */
const monthLabel = (day: string): string => `${MONTH_SHORT[Number(day.slice(5, 7)) - 1] ?? ''} ${day.slice(0, 4)}`;

/**
 * Сезонность набора: столбик на неделю публикации вакансий, пик выделен цветом.
 * Ось подписываем тремя месяцами (начало, середина, конец) — на узком экране
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
              title={`${w.from} — ${w.to}: ${w.count}`}
            />
          </div>
        ))}
      </div>
      <div className="sv-axis">
        <span>{weeks[0] ? monthLabel(weeks[0].from) : ''}</span>
        <span>{middle ? monthLabel(middle.from) : ''}</span>
        <span>{weeks.length > 1 ? monthLabel(weeks[weeks.length - 1]!.to) : ''}</span>
      </div>
    </>
  );
}

const BAND: Record<string, { label: string; cls: string }> = {
  low: { label: 'ниже рынка', cls: 'sv-badge--bad' },
  below_median: { label: 'ниже медианы', cls: 'sv-badge--warn' },
  market: { label: 'в рынке', cls: 'sv-badge--ok' },
  above: { label: 'выше рынка', cls: 'sv-badge--ok' },
};

function Scale({ stats, offer }: { stats: NonNullable<MarketResult['card']['stats']>; offer: number | null }) {
  const lo = Math.min(stats.p25 * 0.8, offer ?? Infinity);
  const hi = Math.max(stats.p75 * 1.2, offer ?? 0);
  const pos = (v: number) => `${Math.max(2, Math.min(98, ((v - lo) / (hi - lo)) * 100))}%`;
  return (
    <div className="sv-scale">
      <div className="sv-scale__bar" />
      <div className="sv-scale__tick" style={{ left: pos(stats.p25) }}>P25 {Math.round(stats.p25 / 1000)}т</div>
      <div className="sv-scale__tick" style={{ left: pos(stats.median) }}>медиана {Math.round(stats.median / 1000)}т</div>
      <div className="sv-scale__tick" style={{ left: pos(stats.p75) }}>P75 {Math.round(stats.p75 / 1000)}т</div>
      {offer != null && <div className="sv-scale__marker" style={{ left: pos(offer) }} title={rub(offer)} />}
    </div>
  );
}

export function Card({ result, boot, notInMax, onRecalc, onAnother, onText, onOpenInbox, onCompareRegions, onHome }: Props) {
  const { card, profession, region, profile, sources, fetched, closure } = result;
  const [selected, setSelected] = useState<string>(card.options.find((o) => o.kind === 'median')?.kind ?? 'keep');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [mid, setMid] = useState<string | null>(null);
  const [vacancy, setVacancy] = useState<VacancyView | null>(null);
  const [pubNote, setPubNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const selectedOpt = card.options.find((o) => o.kind === selected) ?? card.options[0] ?? null;

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
    const text = `Вакансия: ${profession.title}, ${region.name}${vacancy.salary ? ` — от ${rub(vacancy.salary)}` : ''}. Откликнуться в MAX:`;
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
    const text = `Ставка: ${profession.title}, ${region.name} — медиана ${card.stats ? rub(card.stats.median) : '—'}. Карточка рынка:`;
    const r = await shareLink(text, link);
    if (r !== 'shared') {
      try { await navigator.clipboard.writeText(`${text} ${link}`); setNote({ kind: 'info', text: 'Ссылка на карточку скопирована.' }); } catch { setNote({ kind: 'info', text: link }); }
    }
  };

  const subscribe = async () => {
    setBusy('sub');
    try { await api.subscribe(result.cardId); setNote({ kind: 'info', text: 'Подписка оформлена: раз в неделю бот пересчитает рынок и напишет, если медиана сдвинется больше чем на 5 %.' }); haptic('success'); }
    catch (e) { setNote({ kind: 'error', text: e instanceof ApiError ? e.message : 'Не удалось оформить подписку' }); }
    finally { setBusy(null); }
  };

  const openUrl = (url: string) => { const w = webApp(); if (w?.openLink) w.openLink(url); else window.open(url, '_blank', 'noopener'); };
  const dropped = Object.entries(card.sample.dropped);
  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);

  return (
    <div className="sv-page sv-stack">
      <div>
        <div className="sv-title">{profession.title} — {region.name}</div>
        <div className="sv-chips" style={{ marginTop: 6 }}>
          {card.offer && <span className={`sv-badge ${BAND[card.offer.band]?.cls ?? ''}`}>{rub(card.offer.value)} · {card.offer.percentile}-й перцентиль · {BAND[card.offer.band]?.label}</span>}
          <span className={`sv-badge ${card.confidence === 'ok' ? 'sv-badge--ok' : card.confidence === 'low' ? 'sv-badge--warn' : 'sv-badge--bad'}`}>{card.confidence === 'ok' ? 'данных достаточно' : card.confidence === 'low' ? 'данных мало' : 'данных нет'}</span>
        </div>
      </div>

      {card.confidence !== 'ok' && <div className="sv-banner">{card.confidenceReason ?? 'Подходящих вакансий не нашлось'}. {card.confidence === 'low' ? 'Цифры ниже — ориентир, а не вывод.' : 'Попробуйте другую должность или регион.'}</div>}

      {card.stats && (
        <div className="sv-card">
          <div className="sv-verdict">{card.verdict}</div>
          <Scale stats={card.stats} offer={card.offer?.value ?? null} />
          <div className="sv-tiles" style={{ marginTop: 10 }}>
            <div className="sv-tile"><div className="sv-tile__label">Медиана</div><div className="sv-tile__value">{rub(card.stats.median)}</div></div>
            <div className="sv-tile"><div className="sv-tile__label">Половина предложений</div><div className="sv-tile__value">{Math.round(card.stats.p25 / 1000)}–{Math.round(card.stats.p75 / 1000)} тыс.</div></div>
            <div className="sv-tile"><div className="sv-tile__label">Вакансий / работодателей</div><div className="sv-tile__value">{card.sample.vacancies} / {card.sample.employers}</div></div>
            <div className="sv-tile"><div className="sv-tile__label">{card.sameSize ? `Такие же, как вы (${card.sameSize.label})` : 'Средняя по региону (Роструд)'}</div><div className="sv-tile__value">{card.sameSize?.median ? rub(card.sameSize.median) : region.avgSalary ? rub(region.avgSalary) : '—'}</div></div>
          </div>
        </div>
      )}

      {card.options.length > 0 && (
        <div className="sv-card">
          <div className="sv-h2">Варианты ставки</div>
          <div className="sv-options">
            {card.options.map((o) => (
              <button key={o.kind} type="button" className={`sv-option ${selected === o.kind ? 'sv-option--active' : ''}`} onClick={() => setSelected(o.kind)}>
                <div className="sv-option__value">{Math.round(o.value / 1000)} т.</div>
                <div className="sv-option__label">{o.label}</div>
                <div className="sv-option__label">{o.percentile}-й перц.</div>
              </button>
            ))}
          </div>
          <div className="sv-actions" style={{ marginTop: 10 }}>
            <Button stretched onClick={() => selectedOpt && onText(selectedOpt.value)}>Собрать текст вакансии{selectedOpt ? ` на ${rub(selectedOpt.value)}` : ''}</Button>
            {selectedOpt && selectedOpt.kind !== 'keep' && <Button stretched variant="secondary" onClick={() => onRecalc(selectedOpt.value)}>Пересчитать с {rub(selectedOpt.value)}</Button>}
          </div>
        </div>
      )}

      <div className="sv-card sv-stack">
        <div className="sv-h2">Опубликовать вакансию</div>
        <div className="sv-muted sv-small">
          Бот пришлёт карточку вакансии со ссылкой и QR-кодом: перешлите её в чаты сотрудников, партнёров и местные каналы MAX или распечатайте QR. Кандидат ответит на три вопроса прямо в мессенджере, отклики придут сюда.
        </div>
        {pubNote && <div className={`sv-banner ${pubNote.kind === 'error' ? 'sv-banner--error' : 'sv-banner--info'}`}>{pubNote.text}</div>}
        {vacancy?.link && <div className="sv-muted sv-small">Ссылка для кандидатов: {vacancy.link}</div>}
        <div className="sv-actions">
          {!vacancy && (
            <Button stretched onClick={publish} loading={busy === 'publish'} disabled={busy !== null || notInMax}>
              Опубликовать вакансию{selectedOpt ? ` на ${rub(selectedOpt.value)}` : ''}
            </Button>
          )}
          {vacancy && <Button stretched onClick={shareVacancy}>Поделиться в MAX</Button>}
          {vacancy && <Button stretched variant="secondary" onClick={() => onOpenInbox(vacancy.id)}>Открыть отклики</Button>}
        </div>
        {notInMax && !vacancy && <div className="sv-muted sv-small">Публикация доступна внутри MAX: откройте приложение из чата с ботом.</div>}
      </div>

      {card.histogram.length > 1 && (
        <div className="sv-card">
          <div className="sv-h2">Распределение заявленных ставок</div>
          <div className="sv-hist">
            {card.histogram.map((b) => {
              const max = Math.max(...card.histogram.map((x) => x.count), 1);
              const isOffer = card.offer && card.offer.value >= b.from && card.offer.value < b.to;
              return <div key={b.from} className="sv-hist__col"><div className={`sv-hist__bar ${isOffer ? 'sv-hist__bar--offer' : ''}`} style={{ height: `${Math.max(4, (b.count / max) * 80)}%` }} title={`${b.count}`} /><div className="sv-hist__label">{Math.round(b.from / 1000)}</div></div>;
            })}
          </div>
          <div className="sv-muted sv-small">Тыс. ₽ в месяц; оранжевым — корзина вашей ставки. {card.fixedShare != null && `Фиксированная ставка (без вилки) у ${card.fixedShare} % вакансий.`}</div>
        </div>
      )}

      {card.seasonality && card.seasonality.weeks.length > 1 && (
        <div className="sv-card">
          <div className="sv-h2">Сезонность набора</div>
          <Seasons seasonality={card.seasonality} />
          <div className="sv-muted sv-small">
            {card.seasonality.peakMonth
              ? `Пик набора — ${card.seasonality.peakMonth.label}: ${card.seasonality.peakMonth.share} % вакансий периода.`
              : 'Пик набора определить не удалось.'}
            {card.seasonality.peak && ` Самая активная неделя — ${card.seasonality.peak.from} — ${card.seasonality.peak.to} (${card.seasonality.peak.count} вакансий${card.seasonality.peakRatio ? `, в ${card.seasonality.peakRatio} раза выше средней недели` : ''}).`}
            {` По датам публикации ${card.seasonality.dated} вакансий${card.seasonality.from && card.seasonality.to ? ` за период ${card.seasonality.from} — ${card.seasonality.to}` : ''}. Начинайте набор до пика: в пик конкуренция за людей выше.`}
          </div>
        </div>
      )}

      {card.byCategory.length > 0 && (
        <div className="sv-card">
          <div className="sv-h2">Кто нанимает: размер работодателя</div>
          <div className="sv-list">
            {card.byCategory.map((c) => (
              <div key={c.label} className="sv-item">
                <div><div className="sv-item__title">{c.label}</div><div className="sv-item__sub">{c.employers} работод. · {c.vacancies} вак.</div></div>
                <div className="sv-item__value">{c.median != null ? rub(c.median) : '—'}</div>
              </div>
            ))}
          </div>
          <div className="sv-muted sv-small">Размер — по реестру МСП ФНС (ИНН работодателя). Не найденные в реестре — бюджет или крупный бизнес.</div>
        </div>
      )}

      {(card.requirements.length > 0 || card.schedules.length > 0) && (
        <div className="sv-card sv-stack">
          {card.requirements.length > 0 && <><div className="sv-h2">Что пишут в требованиях</div><div className="sv-chips">{card.requirements.slice(0, 10).map((r) => <span key={r.key} className="sv-badge sv-badge--muted">{r.label} · {r.share} %</span>)}</div></>}
          {card.schedules.length > 0 && <><div className="sv-h2">График</div><div className="sv-chips">{card.schedules.map((s) => <span key={s.label} className="sv-badge sv-badge--muted">{s.label} · {s.share} %</span>)}</div></>}
        </div>
      )}

      {card.examples.length > 0 && (
        <div className="sv-card">
          <div className="sv-h2">Типичные предложения</div>
          <div className="sv-list">
            {card.examples.map((e) => (
              <div key={e.id} className="sv-item">
                <div>
                  <div className="sv-item__title">{e.title}</div>
                  <div className="sv-item__sub">{e.employerName ?? 'работодатель'}{e.employerCategory !== undefined ? ` · ${categoryLabel(e.employerCategory)}` : ''}{e.schedule ? ` · ${e.schedule.toLowerCase()}` : ''}{e.url && <> · <a className="sv-link" href={e.url} onClick={(ev) => { ev.preventDefault(); openUrl(e.url!); }}>вакансия</a></>}</div>
                </div>
                <div className="sv-item__value">{e.salaryMin && e.salaryMax && e.salaryMin !== e.salaryMax ? `${Math.round(e.salaryMin / 1000)}–${Math.round(e.salaryMax / 1000)} т.` : rub(e.value)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {closure && closure.observedDays >= 3 && closure.total >= 20 && (
        <div className="sv-card">
          <div className="sv-h2">Наблюдение: как закрываются вакансии</div>
          <div className="sv-verdict">За {closure.observedDays} дн. исчезли из выдачи {pct(closure.closedAbove, closure.totalAbove)} % вакансий со ставкой не ниже медианы и {pct(closure.closedBelow, closure.totalBelow)} % — ниже медианы.</div>
          <div className="sv-muted sv-small">Расчёт по ежедневным снимкам выдачи «Работы России» ({closure.total} вакансий под наблюдением). Исчезновение ≈ закрытие или снятие вакансии.</div>
        </div>
      )}

      <div className="sv-card sv-stack">
        <div className="sv-h2">Действия</div>
        {note && <div className={`sv-banner ${note.kind === 'error' ? 'sv-banner--error' : 'sv-banner--info'}`}>{note.text}</div>}
        <div className="sv-actions">
          {!mid && <Button stretched onClick={sendReport} loading={busy === 'report'} disabled={busy !== null || notInMax}>Отправить PDF-отчёт в чат</Button>}
          {mid && <Button stretched onClick={share} loading={busy === 'share'} disabled={busy !== null}>Поделиться отчётом в MAX</Button>}
          <Button stretched variant="secondary" onClick={onCompareRegions}>Сравнить регионы по этой должности</Button>
          <Button stretched variant="secondary" onClick={shareCardLink}>Поделиться ссылкой на карточку</Button>
          <Button stretched variant="secondary" onClick={subscribe} loading={busy === 'sub'} disabled={busy !== null || notInMax}>Следить за рынком (раз в неделю)</Button>
          <Button stretched variant="ghost" onClick={onAnother}>Другая должность</Button>
          <Button stretched variant="ghost" onClick={onHome}>На главную</Button>
        </div>
        {notInMax && <div className="sv-muted sv-small">Отправка в чат и подписка работают внутри MAX: откройте приложение из чата с ботом.</div>}
      </div>

      <div className="sv-card sv-stack" style={{ gap: 6 }}>
        <div className="sv-h2">Источники и метод</div>
        {sources.map((s) => <div key={s.id} className="sv-small"><a className="sv-link" href={s.url} onClick={(ev) => { ev.preventDefault(); openUrl(s.url); }}>{s.title}</a> · получено {fmtDate(s.fetchedAt)}{s.note ? ` · ${s.note}` : ''}</div>)}
        <div className="sv-muted sv-small">
          Факты — заявленные в вакансиях ставки на портале «Работа России» ({fetched.total} по запросу, загружено {fetched.records}). Расчёт — ядро «Ставки»: ставка вакансии = середина вилки; убраны точные дубли и объявления сверх лимита на работодателя ({dropped.map(([k, v]) => `${k}: ${v}`).join(', ') || '0'}); перцентиль = доля вакансий со ставкой ниже вашей; крупнейший работодатель даёт {card.sample.topEmployerShare} % выборки. Рекомендация — варианты ставки по медиане и 75-му перцентилю. Пакет контекста: {result.pack.title} v{result.pack.version}.
          {profile?.inRegistry && ` Профиль бизнеса: реестр МСП ФНС, ${fmtDate(profile.fetchedAt)}.`}
        </div>
      </div>
    </div>
  );
}
