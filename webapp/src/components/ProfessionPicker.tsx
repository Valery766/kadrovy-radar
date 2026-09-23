import { useEffect, useRef, useState } from 'react';
import { Input, Spinner } from '@maxhub/max-ui';
import { api, type ProfessionRef, type ProfessionSuggestion } from '../lib/api';

/** Выбранная должность: ключ каталога или «custom:…» из подсказки; текст — то, что увидит источник. */
export interface ProfessionChoice {
  key: string | null;
  title: string;
}

interface Props {
  /** Быстрый выбор: профессии пакета и каталога. */
  quick: ProfessionRef[];
  value: ProfessionChoice;
  onChange: (v: ProfessionChoice) => void;
  /** Подпись блока. */
  label?: string;
  hint?: string;
}

/** Пауза перед запросом подсказок: пользователь ещё печатает. */
const DEBOUNCE_MS = 300;

/**
 * Должность: быстрый выбор из пакета плюс поиск по любой профессии.
 * Подсказки берутся офлайн (каталог пакетов + справочник ОКПДТР «Работы России»),
 * своё название тоже принимается — сервер посчитает рынок по нему.
 */
export function ProfessionPicker({ quick, value, onChange, label = 'Должность', hint }: Props) {
  const [query, setQuery] = useState(value.title);
  const [suggestions, setSuggestions] = useState<ProfessionSuggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Гонки ответов: показываем подсказки только последнего запроса.
  const seq = useRef(0);

  useEffect(() => { setQuery(value.title); }, [value.title]);

  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) { setSuggestions(null); setBusy(false); return; }
    setBusy(true);
    const id = seq.current + 1;
    seq.current = id;
    const timer = setTimeout(() => {
      api.suggestProfessions(q, 8)
        .then((r) => { if (seq.current === id) { setSuggestions(r.suggestions); setError(null); } })
        .catch(() => { if (seq.current === id) setError('Подсказки сейчас недоступны — можно писать должность своими словами'); })
        .finally(() => { if (seq.current === id) setBusy(false); });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); };
  }, [query, open]);

  const pick = (choice: ProfessionChoice) => {
    onChange(choice);
    setQuery(choice.title);
    setSuggestions(null);
    setOpen(false);
  };

  return (
    <div className="sv-stack" style={{ gap: 6 }}>
      <span className="sv-h2" style={{ margin: 0 }}>{label}</span>
      <Input
        placeholder="например, повар или обвальщик мяса"
        value={query}
        onChange={(e) => { const v = e.target.value; setQuery(v); setOpen(true); onChange({ key: null, title: v }); }}
        onFocus={() => setOpen(true)}
        hint={hint ?? 'Любая профессия: подскажу по каталогу и справочнику ОКПДТР «Работы России» или посчитаю по вашему названию'}
      />
      {busy && <div className="sv-muted sv-small"><Spinner size={20} /> ищу похожие должности…</div>}
      {error && <div className="sv-muted sv-small">{error}</div>}
      {open && suggestions && suggestions.length > 0 && (
        <div className="sv-suggest">
          {suggestions.map((s) => (
            <button key={s.key} type="button" className="sv-suggest__item" onClick={() => pick({ key: s.key, title: s.title })}>
              <span>{s.title}</span>
              <span className="sv-muted sv-small">{s.source === 'catalog' ? 'каталог' : `ОКПДТР ${s.code ?? ''}`}</span>
            </button>
          ))}
        </div>
      )}
      {open && suggestions && suggestions.length === 0 && query.trim().length >= 2 && (
        <div className="sv-muted sv-small">В справочнике такого нет — посчитаю по вашему названию «{query.trim()}».</div>
      )}
      {quick.length > 0 && (
        <>
          <div className="sv-muted sv-small">Быстрый выбор:</div>
          <div className="sv-chips">
            {quick.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`sv-chip ${value.key === p.key ? 'sv-chip--active' : ''}`}
                onClick={() => pick({ key: p.key, title: p.title })}
              >{p.title}</button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
