import { useState } from 'react';
import { Button, Input } from '@maxhub/max-ui';
import { api, ApiError, categoryLabel, fmtDate, rub, type Bootstrap, type PackRef, type Profile, type Region } from '../lib/api';
import { Inspections } from '../components/Inspections';
import { Banner, ExternalLink, Muted, ScreenTitle, Section, Text } from '../components/ui';

interface Props {
  boot: Bootstrap;
  notInMax: boolean;
  platform: string;
  onProfileSaved: (p: Profile, r: Region | null) => void;
  onStart: (prefill?: { inn?: string | null; regionFnsCode?: string | null }) => void;
  onOpenCard: (id: string) => void;
  onInbox: () => void;
  onJobs: () => void;
  onStaff: () => void;
  onRegions: () => void;
  onDemo: (pack: PackRef) => void;
}

const innValid = (s: string) => /^\d{10}$|^\d{12}$/.test(s);

/** Меры поддержки малого бизнеса: внешняя ссылка на платформу МСП.РФ, без параметров и без интеграции. */
const SUPPORT_URL = 'https://xn--l1agf.xn--p1ai/services/support/filter/';

/** Короткие названия регионов для узких кнопок: полное имя субъекта обрезается на 375 px. */
const SHORT_REGION: Record<string, string> = { '78': 'СПб', '77': 'Москва', '16': 'Татарстан', '23': 'Краснодар' };

/** Подпись пакета для кнопки: «АПК · сезонные работы (Краснодарский край)» → «АПК · Краснодар». */
const packShortTitle = (p: PackRef): string => {
  const head = (p.title.split('·')[0] ?? p.title).trim();
  const region = p.region ? SHORT_REGION[p.region.fnsCode] ?? p.region.name : null;
  return region ? `${head} · ${region}` : head;
};

export function Home({ boot, notInMax, platform, onProfileSaved, onStart, onOpenCard, onInbox, onJobs, onStaff, onRegions, onDemo }: Props) {
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
    if (!innValid(clean)) { setError('ИНН состоит из 10 цифр у организации или из 12 у ИП'); return; }
    setBusy(true);
    try {
      const r = await api.profile(clean);
      setProfile(r.profile); setRegion(r.region); setPackTitle(r.pack.title);
      onProfileSaved(r.profile, r.region);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Реестр МСП сейчас недоступен'); }
    finally { setBusy(false); }
  };

  const start = () => onStart({ inn: profile?.inRegistry ? profile.inn : null, regionFnsCode: region?.fnsCode ?? null });

  return (
    <div className="sv-page sv-stack">
      <div className="sv-head">
        <ScreenTitle>Кадровый радар</ScreenTitle>
        <Text>Сколько платить сотрудникам и где найти людей. Считаю по живым объявлениям вашего региона и сравниваю с компаниями вашего размера.</Text>
      </div>
      {notInMax && <Banner>Открыто {platform === 'browser' ? 'в браузере' : `вне MAX (${platform})`}: демо-режим. Расчёты работают, а отправка отчёта в чат, публикация вакансии и подписка доступны только внутри мессенджера.</Banner>}

      <Section title="Ищу работу">
        <Text>Посмотрите вакансии и откликнитесь прямо в MAX. Для поиска не нужны ИНН, QR-код или ссылка работодателя.</Text>
        <Button stretched onClick={onJobs}>Найти работу</Button>
      </Section>

      <Section title="Как это работает: 3 шага">
        <ol className="sv-steps">
          <li className="sv-step">
            <span className="sv-step__num">1</span>
            <div className="sv-step__body">
              <div className="sv-step__title">Проверьте ставку</div>
              <Muted>Должность, регион и ваша ставка. Через 10–40 секунд узнаете, платите ли вы как большинство работодателей.</Muted>
              <Button stretched onClick={start}>Проверить ставку</Button>
            </div>
          </li>
          <li className="sv-step">
            <span className="sv-step__num">2</span>
            <div className="sv-step__body">
              <div className="sv-step__title">Найдите людей</div>
              <Muted>Из карточки ставки опубликуйте вакансию. Добавьте её в общий каталог: кандидаты найдут её без QR. Ссылка и QR также останутся.</Muted>
              <Button stretched variant="secondary" onClick={onInbox}>Вакансии и отклики</Button>
            </div>
          </li>
          <li className="sv-step">
            <span className="sv-step__num">3</span>
            <div className="sv-step__body">
              <div className="sv-step__title">Ответьте кандидатам</div>
              <Muted>Посмотрите ответы, пригласите на собеседование. После найма закройте вакансию.</Muted>
              <Button stretched variant="secondary" onClick={onInbox}>Посмотреть отклики</Button>
            </div>
          </li>
        </ol>
      </Section>

      <details className="sv-stack"><summary className="sv-h2">Настройки и дополнительные расчёты</summary>
      <Section title="Проверить зарплаты штата"><Muted>Сравните несколько должностей с рынком. Это ориентир по зарплатам, не прогноз увольнений.</Muted><Button stretched variant="secondary" onClick={onStaff}>Мой штат</Button></Section>
      {demoPacks.length > 0 && (
        <Section title="Посмотреть на примере">
          <Muted>Готовая карточка ставки на примере реального микропредприятия из реестра МСП. Это чужой бизнес: ваш профиль не меняется.</Muted>
          <div className="sv-actions">
            {demoPacks.map((p) => <Button key={p.id} stretched variant="secondary" onClick={() => onDemo(p)}>{packShortTitle(p)}</Button>)}
          </div>
        </Section>
      )}

      <Section title="Ваш бизнес">
        {profile && profile.inRegistry ? (
          <div className="sv-stack">
            <div>
              <div className="sv-item__title">{profile.name}</div>
              <div className="sv-item__sub">{categoryLabel(profile.category)} · {profile.okvedName ?? 'вид деятельности не указан'}{profile.okved ? ` (код ${profile.okved})` : ''} · {region?.name ?? profile.fnsRegionCode}</div>
            </div>
            <div className="sv-chips">
              <span className="sv-badge sv-badge--ok">Реестр МСП ФНС · {fmtDate(profile.fetchedAt)}</span>
              <span className="sv-badge sv-badge--muted">Отрасль: {packTitle}</span>
            </div>
            <Muted>Теперь ставки сравниваются с компаниями вашего размера, а не только со всем рынком.</Muted>
            <Button variant="secondary" size="small" onClick={() => setProfile(null)}>Другой ИНН</Button>
          </div>
        ) : (
          <div className="sv-stack">
            <Muted>Необязательно. По ИНН возьму из реестра МСП регион, отрасль и размер компании: сравню вас с работодателями вашего размера и покажу плановые проверки на год.</Muted>
            {profile && !profile.inRegistry && <Banner>ИНН {profile.inn} в реестре МСП не найден: это бюджетное учреждение, крупная компания или закрытый бизнес. Можно продолжить без профиля, регион выберете на следующем шаге.</Banner>}
            <Input inputMode="numeric" placeholder="ИНН, например 7801633015" value={inn} onChange={(e) => setInn(e.target.value)} hint="10 цифр у организации, 12 у ИП" />
            {error && <Banner kind="error">{error}</Banner>}
            <Button onClick={lookup} loading={busy} disabled={busy}>Найти в реестре МСП</Button>
          </div>
        )}
        <div className="sv-divider" />
        <div>
          <div className="sv-item__title">Меры поддержки</div>
          <Muted>Субсидии, льготные кредиты и обучение для малого бизнеса: <ExternalLink href={SUPPORT_URL}>Меры поддержки для вашего региона на МСП.РФ</ExternalLink>. Откроется сайт платформы МСП.РФ. Это ссылка, а не интеграция: регион и отрасль выбираются там.</Muted>
        </div>
      </Section>

      <Inspections inn={profile?.inRegistry ? profile.inn : boot.user.inn} />

      <Section title="Сравнить регионы">
        <Muted>Открываете точку в другом городе или нанимаете вахтой: покажу, где эта должность дешевле и где больше объявлений.</Muted>
        <Button stretched variant="secondary" onClick={onRegions}>Сравнить регионы</Button>
      </Section>
      </details>

      {boot.recentCards.length > 0 && (
        <Section title="Недавние карточки">
          <div className="sv-list">
            {boot.recentCards.map((c) => (
              <div key={c.id} className="sv-item" role="button" tabIndex={0}
                onClick={() => onOpenCard(c.id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenCard(c.id); } }}>
                <div><div className="sv-item__title">{c.professionTitle} · {c.regionName}</div><div className="sv-item__sub">{fmtDate(c.createdAt)}{c.offer ? ` · ваша ставка ${rub(c.offer)}` : ''}</div></div>
                <div className="sv-item__value">{c.median ? rub(c.median) : '–'}<small>обычная ставка</small></div>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Muted>
        Откуда данные: {boot.sources.map((s) => s.title).join(' · ')}. Все цифры взяты из открытых источников, ничего не придумано. Бот: {boot.bot ? <a className="sv-link" href={boot.bot.link}>@{boot.bot.username}</a> : 'не подключён'}.
      </Muted>
    </div>
  );
}
