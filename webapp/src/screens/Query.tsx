import { useMemo, useState } from 'react';
import { Button, Input } from '@maxhub/max-ui';
import { ProfessionPicker, type ProfessionChoice } from '../components/ProfessionPicker';
import { Banner, Muted, ScreenTitle, Section, SectionTitle, Text } from '../components/ui';
import type { Bootstrap } from '../lib/api';

export interface MarketQuery {
  inn?: string | null;
  regionFnsCode?: string | null;
  professionKey?: string;
  professionText?: string;
  offer?: number | null;
  /** Регион запроса разовый: не перезаписывать домашний регион профиля. */
  keepRegion?: boolean;
}

interface Props {
  boot: Bootstrap;
  prefill?: { professionKey?: string; professionTitle?: string; offer?: number | null; inn?: string | null; regionFnsCode?: string | null };
  onSubmit: (p: MarketQuery) => void;
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

  const professions = useMemo(() => {
    const seen = new Set<string>();
    return [...pack.professions, ...boot.professions].filter((p) => (seen.has(p.key) ? false : (seen.add(p.key), true)));
  }, [pack, boot.professions]);

  // Начальный выбор считаем один раз: дальше должность ведёт пользователь.
  const [profession, setProfession] = useState<ProfessionChoice>(() => {
    const key = prefill?.professionKey ?? null;
    const found = key ? professions.find((p) => p.key === key) ?? null : null;
    if (found) return { key: found.key, title: found.title };
    if (key && prefill?.professionTitle) return { key, title: prefill.professionTitle };
    const first = professions[0];
    return first ? { key: first.key, title: first.title } : { key: null, title: '' };
  });
  const [offer, setOffer] = useState<string>(prefill?.offer ? String(prefill.offer) : '');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    setError(null);
    const o = offer.replace(/\D/g, '');
    const offerNum = o ? Number(o) : null;
    if (offerNum != null && (offerNum < 1000 || offerNum > 5_000_000)) { setError('Ставка должна быть от 1 000 до 5 000 000 ₽ в месяц'); return; }
    const title = profession.title.trim();
    if (!profession.key && !title) { setError('Выберите должность из списка или напишите её название'); return; }
    onSubmit({
      inn,
      regionFnsCode: regionFns,
      professionKey: profession.key ?? undefined,
      professionText: title || undefined,
      offer: offerNum,
    });
  };

  return (
    <div className="sv-page sv-stack">
      <div className="sv-head">
        <ScreenTitle>Проверить ставку</ScreenTitle>
        <Text>Три поля, и через 10–40 секунд покажу, платите ли вы как большинство работодателей региона.</Text>
      </div>
      <Section>
        <label className="sv-field">
          <SectionTitle>Регион</SectionTitle>
          <select className="sv-select" value={regionFns} onChange={(e) => setRegionFns(e.target.value)}>
            {boot.regions.map((r) => <option key={r.fnsCode} value={r.fnsCode}>{r.name}</option>)}
          </select>
          <Muted>Где вы нанимаете. Отрасль: {pack.title}.</Muted>
        </label>
        <ProfessionPicker quick={pack.professions} value={profession} onChange={setProfession} />
        <label className="sv-field">
          <SectionTitle>Ваша ставка, ₽ в месяц</SectionTitle>
          <Input inputMode="numeric" placeholder="например 45000" value={offer} onChange={(e) => setOffer(e.target.value)} hint="Оклад до вычета НДФЛ. Можно оставить пустым: покажу рынок без сравнения с вами." />
        </label>
        {error && <Banner kind="error">{error}</Banner>}
        <Button stretched onClick={submit}>Показать рынок</Button>
        <Button stretched variant="ghost" onClick={onBack}>Назад</Button>
      </Section>
    </div>
  );
}
