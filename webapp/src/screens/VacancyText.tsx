import { useEffect, useState } from 'react';
import { Button, Spinner, Textarea } from '@maxhub/max-ui';
import { api, ApiError, rub, type MarketResult } from '../lib/api';
import { Banner, Muted, ScreenTitle, Text } from '../components/ui';

export function VacancyText({ result, salary, onBack }: { result: MarketResult; salary: number; onBack: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.vacancyText(result.cardId, salary).then((r) => setText(r.text)).catch((e) => setError(e instanceof ApiError ? e.message : 'Не удалось собрать текст')); }, [result.cardId, salary]);
  const copy = async () => { if (!text) return; try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } };
  return (
    <div className="sv-page sv-stack">
      <div className="sv-head">
        <ScreenTitle>Текст вакансии</ScreenTitle>
        <Text>Готовое объявление «{result.profession.title}, {result.region.name}» со ставкой {rub(salary)}. Отредактируйте под себя и скопируйте.</Text>
        <Muted>Требования и условия взяты из самых частых формулировок живых объявлений, условия подобраны для отрасли «{result.pack.title}». Ничего не придумано.</Muted>
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {!text && !error && <div className="sv-center"><Spinner /><Muted className="sv-center">Собираю текст из объявлений…</Muted></div>}
      {text && <Textarea className="sv-textarea" value={text} onChange={(e) => setText(e.target.value)} />}
      <div className="sv-actions">
        <Button stretched onClick={copy} disabled={!text}>{copied ? 'Скопировано' : 'Скопировать'}</Button>
        <Button stretched variant="ghost" onClick={onBack}>Назад к карточке</Button>
      </div>
    </div>
  );
}
