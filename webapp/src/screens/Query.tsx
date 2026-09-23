import { useMemo, useState } from 'react';
import { Button, Input } from '@maxhub/max-ui';
import type { Bootstrap } from '../lib/api';

interface Props {
  boot: Bootstrap;
  prefill?: { professionKey?: string; offer?: number | null; inn?: string | null; regionFnsCode?: string | null };
  onSubmit: (p: { inn?: string | null; regionFnsCode?: string | null; professionKey: string; offer?: number | null }) => void;
  onBack: () => void;
}

export function Query({ boot, prefill, onSubmit, onBack }: Props) {
  const inn = prefill?.inn ?? boot.user.inn ?? null;
  const [regionFns, setRegionFns] = useState<string>(prefill?.regionFnsCode ?? boot.user.regionFnsCode ?? '78');
  const pack = useMemo(() => {
    const okved = boot.user.profile?.okved ?? null;
    const byRegion = boot.packs.filter((p) => p.region?.fnsCode === regionFns);
    return byRegion.find((p) => p.industry && okved && p.industry.okvedPrefixes.some((x) => okved.startsWith(x))) ?? byRegion[0] ?? boot.packs.find((p) => !p.region)!;
  }, [boot, regionFns]);
  const [professionKey, setProfessionKey] = useState<string>(prefill?.professionKey ?? pack.professions[0]?.key ?? '');
  const [offer, setOffer] = useState<string>(prefill?.offer ? String(prefill.offer) : '');
  const [error, setError] = useState<string | null>(null);

  const professions = useMemo(() => {
    const seen = new Set<string>();
    return [...pack.professions, ...boot.professions].filter((p) => (seen.has(p.key) ? false : (seen.add(p.key), true)));
  }, [pack, boot.professions]);

  const submit = () => {
    setError(null);
    const o = offer.replace(/\D/g, '');
    const offerNum = o ? Number(o) : null;
    if (offerNum != null && (offerNum < 1000 || offerNum > 5_000_000)) { setError('Ставка — от 1 000 до 5 000 000 ₽ в месяц'); return; }
    if (!professionKey) { setError('Выберите должность'); return; }
    onSubmit({ inn, regionFnsCode: regionFns, professionKey, offer: offerNum });
  };

  return (
    <div className="sv-page sv-stack">
      <div className="sv-title">Проверить ставку</div>
      <div className="sv-card sv-stack">
        <label className="sv-stack" style={{ gap: 6 }}>
          <span className="sv-h2">Регион</span>
          <select className="sv-select" value={regionFns} onChange={(e) => setRegionFns(e.target.value)}>
            {boot.regions.map((r) => <option key={r.fnsCode} value={r.fnsCode}>{r.name}</option>)}
          </select>
          <span className="sv-muted sv-small">Пакет контекста: {pack.title}</span>
        </label>
        <label className="sv-stack" style={{ gap: 6 }}>
          <span className="sv-h2">Должность</span>
          <select className="sv-select" value={professionKey} onChange={(e) => setProfessionKey(e.target.value)}>
            {professions.map((p) => <option key={p.key} value={p.key}>{p.title}</option>)}
          </select>
        </label>
        <label className="sv-stack" style={{ gap: 6 }}>
          <span className="sv-h2">Ваша ставка, ₽ в месяц</span>
          <Input inputMode="numeric" placeholder="например 45000" value={offer} onChange={(e) => setOffer(e.target.value)} hint="Оклад до вычета НДФЛ. Можно оставить пустым — покажу рынок без сравнения." />
        </label>
        {error && <div className="sv-banner sv-banner--error">{error}</div>}
        <Button stretched onClick={submit}>Показать рынок</Button>
        <Button stretched variant="ghost" onClick={onBack}>Назад</Button>
      </div>
    </div>
  );
}
