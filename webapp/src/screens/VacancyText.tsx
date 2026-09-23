import { useEffect, useState } from 'react';
import { Button, Spinner, Textarea } from '@maxhub/max-ui';
import { api, ApiError, rub, type MarketResult } from '../lib/api';

export function VacancyText({ result, salary, onBack }: { result: MarketResult; salary: number; onBack: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api.vacancyText(result.cardId, salary).then((r) => setText(r.text)).catch((e) => setError(e instanceof ApiError ? e.message : 'Ошибка')); }, [result.cardId, salary]);
  const copy = async () => { if (!text) return; try { await navigator.clipboard.writeText(text); setCopied(true); } catch { setCopied(false); } };
  return (
    <div className="sv-page sv-stack">
      <div className="sv-title">Текст вакансии</div>
      <div className="sv-muted sv-small">Собран из самых частых формулировок рынка «{result.profession.title}, {result.region.name}» — ничего не выдумано. Ставка {rub(salary)}, условия — для отрасли «{result.pack.title}». Отредактируйте под себя.</div>
      {error && <div className="sv-banner sv-banner--error">{error}</div>}
      {!text && !error && <div className="sv-center"><Spinner /></div>}
      {text && <Textarea className="sv-textarea" value={text} onChange={(e) => setText(e.target.value)} />}
      <div className="sv-actions">
        <Button stretched onClick={copy} disabled={!text}>{copied ? 'Скопировано' : 'Скопировать'}</Button>
        <Button stretched variant="ghost" onClick={onBack}>Назад к карточке</Button>
      </div>
    </div>
  );
}
