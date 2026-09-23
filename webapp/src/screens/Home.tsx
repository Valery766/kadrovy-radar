import { useState } from 'react';
import { Button, Input } from '@maxhub/max-ui';
import { api, ApiError, categoryLabel, fmtDate, rub, type Bootstrap, type PackRef, type Profile, type Region } from '../lib/api';
import { Inspections } from '../components/Inspections';

interface Props {
  boot: Bootstrap;
  notInMax: boolean;
  platform: string;
  onProfileSaved: (p: Profile, r: Region | null) => void;
  onStart: (prefill?: { inn?: string | null; regionFnsCode?: string | null }) => void;
  onOpenCard: (id: string) => void;
  onInbox: () => void;
  onStaff: () => void;
  onRegions: () => void;
  onDemo: (pack: PackRef) => void;
}

const innValid = (s: string) => /^\d{10}$|^\d{12}$/.test(s);

/** Короткие названия регионов для узких кнопок: полное имя субъекта обрезается на 375 px. */
const SHORT_REGION: Record<string, string> = { '78': 'СПб', '77': 'Москва', '16': 'Татарстан', '23': 'Краснодар' };

/** Подпись пакета для кнопки: «АПК · сезонные работы (Краснодарский край)» → «АПК · Краснодар». */
const packShortTitle = (p: PackRef): string => {
  const head = (p.title.split('·')[0] ?? p.title).trim();
  const region = p.region ? SHORT_REGION[p.region.fnsCode] ?? p.region.name : null;
  return region ? `${head} · ${region}` : head;
};

export function Home({ boot, notInMax, platform, onProfileSaved, onStart, onOpenCard, onInbox, onStaff, onRegions, onDemo }: Props) {
  const [inn, setInn] = useState(boot.user.inn ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(boot.user.profile);
  const [region, setRegion] = useState<Region | null>(boot.regions.find((r) => r.fnsCode === boot.user.regionFnsCode) ?? null);
  const [packTitle, setPackTitle] = useState(boot.user.pack.title);
  // Все примеры остаются (это показ универсальности), но пример своего региона идёт первым:
  // владельцу кафе в Петербурге «тракторист в Краснодаре» первым пунктом ничего не объясняет.
  const ownFns = region?.fnsCode ?? boot.user.regionFnsCode;
  const demoPacks = boot.packs.filter((p) => p.demo)
    .sort((a, b) => Number(b.region?.fnsCode === ownFns) - Number(a.region?.fnsCode === ownFns));

  const lookup = async () => {
    setError(null);
    const clean = inn.replace(/\D/g, '');
    if (!innValid(clean)) { setError('ИНН — это 10 цифр для организации или 12 для ИП'); return; }
    setBusy(true);
    try {
      const r = await api.profile(clean);
      setProfile(r.profile); setRegion(r.region); setPackTitle(r.pack.title);
      onProfileSaved(r.profile, r.region);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Реестр МСП сейчас недоступен'); }
    finally { setBusy(false); }
  };

  return (
    <div className="sv-page sv-stack">
      <div>
        <div className="sv-title">Кадровый радар</div>
        <div className="sv-muted">Сколько платить сотрудникам: считаю по живым вакансиям вашего региона и сравниваю с работодателями вашего размера.</div>
      </div>
      {notInMax && <div className="sv-banner">Открыто вне MAX ({platform}): демо-режим. Расчёты работают, а отправка отчёта в чат и подписка доступны только внутри мессенджера.</div>}

      <div className="sv-card sv-stack">
        <div className="sv-h2">Сколько платить</div>
        <div className="sv-muted sv-small">Должность → регион → ваша ставка. Считаю по живым вакансиям «Работы России», 10–40 секунд.</div>
        <Button stretched onClick={() => onStart({ inn: profile?.inRegistry ? profile.inn : null, regionFnsCode: region?.fnsCode ?? null })}>Показать рынок</Button>
        {demoPacks.length > 0 && (
          <>
            <div className="sv-muted sv-small">Примеры на реальных микропредприятиях из реестра МСП (чужой бизнес — ваш профиль не меняется):</div>
            {demoPacks.map((p) => <Button key={p.id} stretched variant="secondary" onClick={() => onDemo(p)}>{packShortTitle(p)}</Button>)}
          </>
        )}
      </div>

      <div className="sv-card sv-stack">
        <div className="sv-h2">Ваш бизнес</div>
        {profile && profile.inRegistry ? (
          <div className="sv-stack">
            <div>
              <div className="sv-item__title">{profile.name}</div>
              <div className="sv-item__sub">{categoryLabel(profile.category)} · ОКВЭД {profile.okved ?? '—'} {profile.okvedName ?? ''} · {region?.name ?? profile.fnsRegionCode}</div>
            </div>
            <div className="sv-chips">
              <span className="sv-badge sv-badge--ok">Реестр МСП ФНС · {fmtDate(profile.fetchedAt)}</span>
              <span className="sv-badge sv-badge--muted">Отрасль: {packTitle}</span>
            </div>
            <Button variant="secondary" size="small" onClick={() => setProfile(null)}>Другой ИНН</Button>
          </div>
        ) : (
          <div className="sv-stack">
            <div className="sv-muted sv-small">Необязательно. По ИНН сравню вас с работодателями вашего размера, а не со всем рынком, и покажу плановые проверки на год.</div>
            {profile && !profile.inRegistry && <div className="sv-banner">ИНН {profile.inn} в реестре МСП не найден (бюджет, крупный бизнес или ликвидирован). Можно продолжить без профиля — регион выберете на следующем шаге.</div>}
            <Input inputMode="numeric" placeholder="ИНН, например 7801633015" value={inn} onChange={(e) => setInn(e.target.value)} hint="По ИНН беру из реестра МСП регион, отрасль и размер компании" />
            {error && <div className="sv-banner sv-banner--error">{error}</div>}
            <Button onClick={lookup} loading={busy} disabled={busy}>Найти в реестре МСП</Button>
          </div>
        )}
      </div>

      <Inspections inn={profile?.inRegistry ? profile.inn : boot.user.inn} />

      <div className="sv-card sv-stack">
        <div className="sv-h2">Найм</div>
        <div className="sv-muted sv-small">Опубликованные вакансии, отклики кандидатов с баллом совпадения, приглашения и найм. Публикация — из карточки рынка.</div>
        <Button stretched variant="secondary" onClick={onInbox}>Вакансии и отклики</Button>
      </div>

      <div className="sv-card sv-stack">
        <div className="sv-h2">Штат и регионы</div>
        <div className="sv-muted sv-small">Кто из ваших сотрудников уже ниже рынка и сколько стоит подтянуть до медианы; где в стране эта должность дешевле и где людей больше.</div>
        <Button stretched variant="secondary" onClick={onStaff}>Мой штат</Button>
        <Button stretched variant="secondary" onClick={onRegions}>Сравнить регионы</Button>
      </div>

      {boot.recentCards.length > 0 && (
        <div className="sv-card">
          <div className="sv-h2">Недавние карточки</div>
          <div className="sv-list">
            {boot.recentCards.map((c) => (
              <div key={c.id} className="sv-item" role="button" tabIndex={0}
                onClick={() => onOpenCard(c.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenCard(c.id); } }}>
                <div><div className="sv-item__title">{c.professionTitle} — {c.regionName}</div><div className="sv-item__sub">{fmtDate(c.createdAt)}{c.offer ? ` · ваша ставка ${rub(c.offer)}` : ''}</div></div>
                <div className="sv-item__value">{c.median ? rub(c.median) : '—'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sv-muted sv-small">
        Откуда данные: {boot.sources.map((s) => s.title).join(' · ')}. Ничего не выдумываем — каждое число выводимо из источника. Бот: {boot.bot ? <a className="sv-link" href={boot.bot.link}>@{boot.bot.username}</a> : '—'}.
      </div>
    </div>
  );
}
