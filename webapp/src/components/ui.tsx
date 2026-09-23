/**
 * Общие элементы экранов: типографика MAX UI (Typography), карточки-разделы,
 * плитки чисел с подписью-объяснением, блок «Что это значит для вас»,
 * состояние загрузки и навигация «Назад / На главную».
 */
import type { ReactNode } from 'react';
import { Button, Spinner, Typography } from '@maxhub/max-ui';
import { fmtDate, type SourceBadge } from '../lib/api';
import { webApp } from '../lib/bridge';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

/** Заголовок экрана. */
export function ScreenTitle({ children }: { children: ReactNode }) {
  return <Typography.Headline variant="large-strong" asChild><h1 className="sv-title">{children}</h1></Typography.Headline>;
}

/** Главный вывод экрана одной фразой: крупно, единственный акцент. */
export function Lead({ children, className }: { children: ReactNode; className?: string }) {
  return <Typography.Headline variant="medium" asChild><p className={cx('sv-lead', className)}>{children}</p></Typography.Headline>;
}

/** Заголовок раздела внутри карточки. */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <Typography.Headline variant="small" asChild><h2 className="sv-h2">{children}</h2></Typography.Headline>;
}

/** Основной текст. */
export function Text({ children, className }: { children: ReactNode; className?: string }) {
  return <Typography.Body variant="medium" asChild><p className={cx('sv-text', className)}>{children}</p></Typography.Body>;
}

/** Пояснение серым: подписи, источники, ограничения. */
export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <Typography.Body variant="small" asChild><p className={cx('sv-muted', className)}>{children}</p></Typography.Body>;
}

/** Надзаголовок мелким серым: «Повар · Санкт-Петербург». */
export function Overline({ children }: { children: ReactNode }) {
  return <Typography.Label variant="large" asChild><p className="sv-overline">{children}</p></Typography.Label>;
}

/** Карточка-раздел с заголовком. */
export function Section({ title, children, className, gap }: { title?: ReactNode; children: ReactNode; className?: string; gap?: 'tight' | 'normal' }) {
  return (
    <section className={cx('sv-card sv-stack', gap === 'tight' && 'sv-stack--tight', className)}>
      {title && <SectionTitle>{title}</SectionTitle>}
      {children}
    </section>
  );
}

/** Плитка числа: подпись сверху, число, объяснение под числом. */
export function Tile({ label, value, note, long, tone }: { label: ReactNode; value: ReactNode; note?: ReactNode; long?: boolean; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={cx('sv-tile', tone && `sv-tile--${tone}`)}>
      <div className="sv-tile__label">{label}</div>
      <div className={cx('sv-tile__value', long && 'sv-tile__value--long')}>{value}</div>
      {note && <div className="sv-tile__note">{note}</div>}
    </div>
  );
}

/** Блок «Что это значит для вас» (или «Что дальше»): единственный цветной акцент раздела. */
export function Meaning({ title = 'Что это значит для вас', children }: { title?: string; children: ReactNode }) {
  return (
    <div className="sv-meaning">
      <div className="sv-meaning__title">{title}</div>
      <div className="sv-meaning__text">{children}</div>
    </div>
  );
}

/** Три-четыре факта в строку: подпись сверху, значение снизу (строка сотрудника или региона). */
export function Facts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <div className="sv-facts">
      {items.map((f) => <div key={f.label} className="sv-fact"><div className="sv-fact__label">{f.label}</div><div className="sv-fact__value">{f.value}</div></div>)}
    </div>
  );
}

/** Состояние загрузки с объяснением, что происходит и сколько ждать. */
export function Loading({ title = 'Считаю по живым объявлениям', text = 'Запрашиваю вакансии на «Работе России» и сверяю работодателей с реестром МСП. Обычно 10–40 секунд.', inline }: { title?: string; text?: string; inline?: boolean }) {
  return (
    <div className={cx('sv-loading', inline ? 'sv-card' : 'sv-page')}>
      <div className="sv-center"><Spinner /></div>
      <Typography.Headline variant="small" asChild><p className="sv-loading__title">{title}</p></Typography.Headline>
      <div className="sv-progress"><div className="sv-progress__bar" /></div>
      <Muted className="sv-center">{text}</Muted>
    </div>
  );
}

/** Навигация внизу каждого экрана: «Назад» и «На главную» (кроме главной). */
export function Nav({ onBack, onHome, backLabel = 'Назад', children }: { onBack?: () => void; onHome: () => void; backLabel?: string; children?: ReactNode }) {
  return (
    <div className="sv-actions">
      {children}
      {onBack && <Button stretched variant="ghost" onClick={onBack}>{backLabel}</Button>}
      <Button stretched variant="ghost" onClick={onHome}>На главную</Button>
    </div>
  );
}

/** Открыть внешнюю ссылку: внутри MAX через мост, в браузере новой вкладкой. */
export const openUrl = (url: string): void => {
  const w = webApp();
  if (w?.openLink) w.openLink(url);
  else window.open(url, '_blank', 'noopener');
};

/** Ссылка на внешний сайт с подписью. */
export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className="sv-link" href={href} target="_blank" rel="noopener" onClick={(e) => { e.preventDefault(); openUrl(href); }}>{children}</a>;
}

/** Раздел «Откуда эти цифры»: источники с датами и объяснение простыми словами. */
export function Sources({ sources, children, title = 'Откуда эти цифры' }: { sources: SourceBadge[]; children?: ReactNode; title?: string }) {
  return (
    <Section title={title} gap="tight">
      <ul className="sv-sources">
        {sources.map((s) => (
          <li key={s.id} className="sv-sources__item">
            <ExternalLink href={s.url}>{s.title}</ExternalLink>
            <span className="sv-muted"> · получено {fmtDate(s.fetchedAt)}{s.note ? ` · ${s.note}` : ''}</span>
          </li>
        ))}
      </ul>
      {children}
    </Section>
  );
}

/** Плашка-уведомление: результат действия или предупреждение. */
export function Banner({ kind = 'warn', children }: { kind?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  return <div className={cx('sv-banner', kind === 'info' && 'sv-banner--info', kind === 'error' && 'sv-banner--error')} role={kind === 'error' ? 'alert' : undefined}>{children}</div>;
}
