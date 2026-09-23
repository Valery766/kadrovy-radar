import { useState } from 'react';
import { Button, Input } from '@maxhub/max-ui';
import { api, ApiError, categoryLabel, fmtDate, rub, type Bootstrap, type PackRef, type Profile, type Region } from '../lib/api';

interface Props {
  boot: Bootstrap;
  notInMax: boolean;
  platform: string;
  onProfileSaved: (p: Profile, r: Region | null) => void;
  onStart: (prefill?: { inn?: string | null; regionFnsCode?: string | null }) => void;
  onOpenCard: (id: string) => void;
  onInbox: () => void;
  onDemo: (pack: PackRef) => void;
}

const innValid = (s: string) => /^\d{10}$|^\d{12}$/.test(s);

export function Home({ boot, notInMax, platform, onProfileSaved, onStart, onOpenCard, onInbox, onDemo }: Props) {
  const [inn, setInn] = useState(boot.user.inn ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<Profile | null>(boot.user.profile);
  const [region, setRegion] = useState<Region | null>(boot.regions.find((r) => r.fnsCode === boot.user.regionFnsCode) ?? null);
  const [packTitle, setPackTitle] = useState(boot.user.pack.title);
  const demoPacks = boot.packs.filter((p) => p.demo);

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
        <div className="sv-title">Ставка</div>
        <div className="sv-muted">Зарплатный радар для малого бизнеса: сколько платят конкуренты вашего размера и где ваша ставка на шкале рынка.</div>
      </div>
      {notInMax && <div className="sv-banner">Открыто вне MAX ({platform}): демо-режим. Расчёты работают, а отправка отчёта в чат и подписка доступны только внутри мессенджера.</div>}

      <div className="sv-card sv-stack">
        <div className="sv-h2">1. Ваш бизнес</div>
        {profile && profile.inRegistry ? (
          <div className="sv-stack">
            <div>
              <div className="sv-item__title">{profile.name}</div>
              <div className="sv-item__sub">{categoryLabel(profile.category)} · ОКВЭД {profile.okved ?? '—'} {profile.okvedName ?? ''} · {region?.name ?? profile.fnsRegionCode}</div>
            </div>
            <div className="sv-chips">
              <span className="sv-badge sv-badge--ok">Реестр МСП ФНС · {fmtDate(profile.fetchedAt)}</span>
              <span className="sv-badge sv-badge--muted">Пакет: {packTitle}</span>
            </div>
            <Button variant="secondary" size="small" onClick={() => setProfile(null)}>Другой ИНН</Button>
          </div>
        ) : (
          <div className="sv-stack">
            {profile && !profile.inRegistry && <div className="sv-banner">ИНН {profile.inn} в реестре МСП не найден (бюджет, крупный бизнес или ликвидирован). Можно продолжить без профиля — регион выберете на следующем шаге.</div>}
            <Input inputMode="numeric" placeholder="ИНН, например 7801633015" value={inn} onChange={(e) => setInn(e.target.value)} hint="По ИНН беру из реестра МСП регион, отрасль и размер компании" />
            {error && <div className="sv-banner sv-banner--error">{error}</div>}
            <Button onClick={lookup} loading={busy} disabled={busy}>Найти в реестре МСП</Button>
          </div>
        )}
      </div>

      <div className="sv-card sv-stack">
        <div className="sv-h2">2. Проверить ставку</div>
        <div className="sv-muted sv-small">Должность → регион → ваша ставка. Источник вакансий — «Работа России» (Роструд), обновляется при запросе.</div>
        <Button stretched onClick={() => onStart({ inn: profile?.inRegistry ? profile.inn : null, regionFnsCode: region?.fnsCode ?? null })}>Показать рынок</Button>
        {demoPacks.map((p) => <Button key={p.id} stretched variant="secondary" onClick={() => onDemo(p)}>Показать на примере: {p.title}</Button>)}
      </div>

      <div className="sv-card sv-stack">
        <div className="sv-h2">3. Найм</div>
        <div className="sv-muted sv-small">Опубликованные вакансии, отклики кандидатов с баллом совпадения, приглашения и найм. Публикация — из карточки рынка.</div>
        <Button stretched variant="secondary" onClick={onInbox}>Мои вакансии и отклики</Button>
      </div>

      {boot.recentCards.length > 0 && (
        <div className="sv-card">
          <div className="sv-h2">Недавние карточки</div>
          <div className="sv-list">
            {boot.recentCards.map((c) => (
              <div key={c.id} className="sv-item" role="button" onClick={() => onOpenCard(c.id)}>
                <div><div className="sv-item__title">{c.professionTitle} — {c.regionName}</div><div className="sv-item__sub">{fmtDate(c.createdAt)}{c.offer ? ` · ваша ставка ${rub(c.offer)}` : ''}</div></div>
                <div className="sv-item__value">{c.median ? rub(c.median) : '—'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sv-muted sv-small">
        Данные: {boot.sources.map((s) => s.title).join(' · ')}. Расчёт детерминированный — каждое число выводимо из источника. Бот: {boot.bot ? <a className="sv-link" href={boot.bot.link}>@{boot.bot.username}</a> : '—'}.
      </div>
    </div>
  );
}
