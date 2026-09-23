import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner } from '@maxhub/max-ui';
import { api, ApiError, openSession, type Bootstrap, type MarketResult, type Profile, type ProfessionRef, type Region } from './lib/api';
import { insideMax, platform, startParam } from './lib/bridge';
import { useBackButton } from './lib/state';
import { Home } from './screens/Home';
import { Query } from './screens/Query';
import { Card } from './screens/Card';
import { VacancyText } from './screens/VacancyText';

type Screen =
  | { name: 'boot' }
  | { name: 'home' }
  | { name: 'query'; prefill?: { professionKey?: string; offer?: number | null; inn?: string | null; regionFnsCode?: string | null } }
  | { name: 'loading'; label: string }
  | { name: 'card'; result: MarketResult }
  | { name: 'text'; result: MarketResult; salary: number }
  | { name: 'error'; message: string; retry?: () => void };

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'boot' });
  const [history, setHistory] = useState<Screen[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);

  const go = useCallback((next: Screen) => {
    setScreen((cur) => { setHistory((h) => (cur.name === 'boot' || cur.name === 'loading' ? h : [...h, cur])); return next; });
  }, []);
  const back = useCallback(() => {
    setHistory((h) => {
      const prev = h[h.length - 1];
      setScreen(prev ?? { name: 'home' });
      return h.slice(0, -1);
    });
  }, []);
  useBackButton(screen.name !== 'home' && screen.name !== 'boot', back);

  const reloadBoot = useCallback(async () => { const b = await api.bootstrap(); setBoot(b); return b; }, []);

  useEffect(() => {
    (async () => {
      try {
        const s = await openSession();
        const b = await reloadBoot();
        const sp = s.startParam ?? startParam();
        if (sp && sp.startsWith('card_')) {
          try { const r = await api.card(sp.slice(5)); setScreen({ name: 'card', result: r }); return; } catch { /* карточка не найдена — на главную */ }
        }
        void b;
        setScreen({ name: 'home' });
      } catch (err) {
        setFatal(err instanceof ApiError ? err.message : 'Не удалось подключиться к серверу. Проверьте соединение и откройте приложение заново.');
      }
    })();
  }, [reloadBoot]);

  const runMarket = useCallback(async (p: { inn?: string | null; regionFnsCode?: string | null; professionKey: string; offer?: number | null; forceRefresh?: boolean }) => {
    go({ name: 'loading', label: 'Запрашиваю вакансии на «Работе России» и сверяю работодателей с реестром МСП. Обычно 10–40 секунд.' });
    try {
      const r = await api.market(p);
      setScreen({ name: 'card', result: r });
      void reloadBoot();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Не удалось получить данные';
      setScreen({ name: 'error', message, retry: () => void runMarket(p) });
    }
  }, [go, reloadBoot]);

  if (fatal) {
    return <div className="sv-page sv-stack"><div className="sv-banner sv-banner--error">{fatal}</div><Button onClick={() => window.location.reload()}>Обновить</Button></div>;
  }
  if (!boot || screen.name === 'boot') {
    return <div className="sv-page sv-center" style={{ paddingTop: 80 }}><Spinner /><div className="sv-muted" style={{ marginTop: 12 }}>Загружаю…</div></div>;
  }

  const notInMax = !insideMax();

  switch (screen.name) {
    case 'home':
      return <Home boot={boot} notInMax={notInMax} platform={platform()}
        onProfileSaved={(_p: Profile, _r: Region | null) => void reloadBoot()}
        onStart={(prefill) => go({ name: 'query', prefill })}
        onOpenCard={async (id) => { try { const r = await api.card(id); go({ name: 'card', result: r }); } catch (e) { setScreen({ name: 'error', message: e instanceof ApiError ? e.message : 'Карточка не найдена' }); } }}
        onDemo={(pack) => { if (pack.demo) void runMarket({ inn: pack.demo.inn, regionFnsCode: pack.region?.fnsCode ?? null, professionKey: pack.demo.profession, offer: pack.demo.salary }); }} />;
    case 'query':
      return <Query boot={boot} prefill={screen.prefill} onSubmit={(p) => void runMarket(p)} onBack={back} />;
    case 'loading':
      return <div className="sv-page sv-stack" style={{ paddingTop: 60 }}>
        <div className="sv-center"><Spinner /></div>
        <div className="sv-center sv-title">Считаю рынок</div>
        <div className="sv-progress"><div className="sv-progress__bar" /></div>
        <div className="sv-center sv-muted">{screen.label}</div>
      </div>;
    case 'card':
      return <Card result={screen.result} boot={boot} notInMax={notInMax}
        onRecalc={(offer) => void runMarket({ inn: screen.result.profile?.inn ?? null, regionFnsCode: screen.result.region.fnsCode, professionKey: screen.result.profession.key, offer })}
        onAnother={() => go({ name: 'query', prefill: { inn: screen.result.profile?.inn ?? null, regionFnsCode: screen.result.region.fnsCode } })}
        onText={(salary) => go({ name: 'text', result: screen.result, salary })}
        onHome={() => { setHistory([]); setScreen({ name: 'home' }); }} />;
    case 'text':
      return <VacancyText result={screen.result} salary={screen.salary} onBack={back} />;
    case 'error':
      return <div className="sv-page sv-stack" style={{ paddingTop: 40 }}>
        <div className="sv-title">Не получилось</div>
        <div className="sv-banner sv-banner--error">{screen.message}</div>
        <div className="sv-actions">
          {screen.retry && <Button onClick={screen.retry}>Повторить</Button>}
          <Button variant="secondary" onClick={() => { setHistory([]); setScreen({ name: 'home' }); }}>На главную</Button>
        </div>
      </div>;
  }
}

export type { ProfessionRef };
