import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner } from '@maxhub/max-ui';
import { api, ApiError, openSession, type Bootstrap, type MarketResult, type Profile, type ProfessionRef, type Region } from './lib/api';
import { insideMax, platform, startParam } from './lib/bridge';
import { useBackButton } from './lib/state';
import { Banner, Loading, Muted, ScreenTitle } from './components/ui';
import { Home } from './screens/Home';
import { Query, type MarketQuery } from './screens/Query';
import { Card } from './screens/Card';
import { VacancyText } from './screens/VacancyText';
import { Inbox } from './screens/Inbox';
import { Staff } from './screens/Staff';
import { Regions } from './screens/Regions';

type Screen =
  | { name: 'boot' }
  | { name: 'home' }
  | { name: 'query'; prefill?: { professionKey?: string; professionTitle?: string; offer?: number | null; inn?: string | null; regionFnsCode?: string | null } }
  | { name: 'loading'; label: string }
  | { name: 'card'; result: MarketResult }
  | { name: 'text'; result: MarketResult; salary: number }
  | { name: 'inbox'; vacancyId: string | null }
  | { name: 'staff' }
  | { name: 'regions'; prefill?: { professionKey?: string; professionTitle?: string; regionFnsCode?: string | null; offer?: number | null } }
  | { name: 'error'; message: string; retry?: () => void };

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'boot' });
  const [history, setHistory] = useState<Screen[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);

  /** Новый экран начинается сверху: иначе длинная карточка открывается на середине. */
  const scrollTop = () => window.scrollTo(0, 0);

  const go = useCallback((next: Screen) => {
    scrollTop();
    setScreen((cur) => { setHistory((h) => (cur.name === 'boot' || cur.name === 'loading' ? h : [...h, cur])); return next; });
  }, []);
  const back = useCallback(() => {
    scrollTop();
    setHistory((h) => {
      const prev = h[h.length - 1];
      setScreen(prev ?? { name: 'home' });
      return h.slice(0, -1);
    });
  }, []);
  /** «Все вакансии» в инбоксе: возвращаемся к списку, не наращивая историю. */
  const backToVacancies = useCallback(() => {
    scrollTop();
    setHistory((h) => {
      const prev = h[h.length - 1];
      if (prev && prev.name === 'inbox' && prev.vacancyId === null) { setScreen(prev); return h.slice(0, -1); }
      setScreen({ name: 'inbox', vacancyId: null });
      return h;
    });
  }, []);
  const home = useCallback(() => { scrollTop(); setHistory([]); setScreen({ name: 'home' }); }, []);
  useBackButton(screen.name !== 'home' && screen.name !== 'boot', back);

  const reloadBoot = useCallback(async () => { const b = await api.bootstrap(); setBoot(b); return b; }, []);

  useEffect(() => {
    (async () => {
      try {
        const s = await openSession();
        const b = await reloadBoot();
        const sp = s.startParam ?? startParam();
        if (sp && sp.startsWith('card_')) {
          try { const r = await api.card(sp.slice(5)); setScreen({ name: 'card', result: r }); return; }
          catch { setScreen({ name: 'error', message: 'Карточка не найдена или устарела. Проверьте ставку заново: это займёт 10–40 секунд.' }); return; }
        }
        if (sp && sp.startsWith('inbox_')) { setScreen({ name: 'inbox', vacancyId: sp.slice(6) }); return; }
        if (sp === 'inbox') { setScreen({ name: 'inbox', vacancyId: null }); return; }
        if (sp === 'staff') { setScreen({ name: 'staff' }); return; }
        if (sp === 'regions') { setScreen({ name: 'regions' }); return; }
        void b;
        setScreen({ name: 'home' });
      } catch (err) {
        setFatal(err instanceof ApiError ? err.message : 'Не удалось подключиться к серверу. Проверьте соединение и откройте приложение заново.');
      }
    })();
  }, [reloadBoot]);

  const runMarket = useCallback(async (p: MarketQuery & { forceRefresh?: boolean }) => {
    go({ name: 'loading', label: 'Запрашиваю вакансии на «Работе России» и сверяю работодателей с реестром МСП. Обычно 10–40 секунд.' });
    try {
      const r = await api.market(p);
      window.scrollTo(0, 0);
      setScreen({ name: 'card', result: r });
      void reloadBoot();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Не удалось получить данные';
      window.scrollTo(0, 0);
      setScreen({ name: 'error', message, retry: () => void runMarket(p) });
    }
  }, [go, reloadBoot]);

  if (fatal) {
    return <div className="sv-page sv-stack"><Banner kind="error">{fatal}</Banner><Button onClick={() => window.location.reload()}>Обновить</Button></div>;
  }
  if (!boot || screen.name === 'boot') {
    return <div className="sv-page sv-center" style={{ paddingTop: 80 }}><Spinner /><Muted className="sv-center">Загружаю…</Muted></div>;
  }

  const notInMax = !insideMax();

  switch (screen.name) {
    case 'home':
      return <Home boot={boot} notInMax={notInMax} platform={platform()}
        onProfileSaved={(_p: Profile, _r: Region | null) => void reloadBoot()}
        onStart={(prefill) => go({ name: 'query', prefill })}
        onOpenCard={async (id) => { try { const r = await api.card(id); go({ name: 'card', result: r }); } catch (e) { setScreen({ name: 'error', message: e instanceof ApiError ? e.message : 'Карточка не найдена' }); } }}
        onInbox={() => go({ name: 'inbox', vacancyId: null })}
        onStaff={() => go({ name: 'staff' })}
        onRegions={() => go({ name: 'regions' })}
        onDemo={(pack) => { if (pack.demo) void runMarket({ inn: pack.demo.inn, regionFnsCode: pack.region?.fnsCode ?? null, professionKey: pack.demo.profession, offer: pack.demo.salary }); }} />;
    case 'query':
      return <Query boot={boot} prefill={screen.prefill} onSubmit={(p) => void runMarket(p)} onBack={back} />;
    case 'loading':
      return <Loading title="Считаю по живым объявлениям" text={screen.label} />;
    case 'card':
      return <Card result={screen.result} boot={boot} notInMax={notInMax} onBack={back}
        onRecalc={(offer) => void runMarket({ inn: screen.result.profile?.inn ?? null, regionFnsCode: screen.result.region.fnsCode, professionKey: screen.result.profession.key, professionText: screen.result.profession.query, offer })}
        onAnother={() => go({ name: 'query', prefill: { inn: screen.result.profile?.inn ?? null, regionFnsCode: screen.result.region.fnsCode } })}
        onText={(salary) => go({ name: 'text', result: screen.result, salary })}
        onOpenInbox={(vacancyId) => go({ name: 'inbox', vacancyId })}
        onCompareRegions={() => go({ name: 'regions', prefill: { professionKey: screen.result.profession.key, professionTitle: screen.result.profession.title, regionFnsCode: screen.result.region.fnsCode, offer: screen.result.card.offer?.value ?? null } })}
        onHome={home} />;
    case 'text':
      return <VacancyText result={screen.result} salary={screen.salary} onBack={back} />;
    case 'inbox':
      return <Inbox boot={boot} notInMax={notInMax} vacancyId={screen.vacancyId}
        onSelectVacancy={(id) => go({ name: 'inbox', vacancyId: id })}
        onVacancies={backToVacancies}
        onBack={back}
        onHome={home} />;
    case 'staff':
      return <Staff boot={boot} onBack={back}
        onOpenCard={async (id) => { try { const r = await api.card(id); go({ name: 'card', result: r }); } catch (e) { setScreen({ name: 'error', message: e instanceof ApiError ? e.message : 'Карточка не найдена' }); } }}
        onHome={home} />;
    case 'regions':
      return <Regions boot={boot} prefill={screen.prefill} onBack={back}
        onOpenMarket={(p) => void runMarket(p)}
        onHome={home} />;
    case 'error':
      return <div className="sv-page sv-stack" style={{ paddingTop: 40 }}>
        <ScreenTitle>Не получилось</ScreenTitle>
        <Banner kind="error">{screen.message}</Banner>
        <div className="sv-actions">
          {screen.retry && <Button onClick={screen.retry}>Повторить</Button>}
          <Button variant="secondary" onClick={home}>На главную</Button>
        </div>
      </div>;
  }
}

export type { ProfessionRef };
