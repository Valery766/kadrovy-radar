import { useEffect, useState } from 'react';
import { Spinner } from '@maxhub/max-ui';
import { api, ApiError, fmtDate, type InspectionsResult } from '../lib/api';

interface Props {
  /** ИНН бизнеса: при смене блок перезапрашивается. null — сервер возьмёт ИНН профиля или демо-пакета. */
  inn: string | null;
}

/** «2026-03-16» → «16.03.2026». Дат из плана не придумываем: пусто — прочерк. */
const planDate = (iso: string | null): string => {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '—';
};

/**
 * Блок «Проверки {год}»: плановые контрольные (надзорные) мероприятия по ИНН пользователя
 * и контекст по региону и отрасли. Только факты плана ЕРКНМ — никаких оценок вероятности.
 */
export function Inspections({ inn }: Props) {
  const [data, setData] = useState<InspectionsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError(null);
    api.inspections(inn)
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) setError(e instanceof ApiError ? e.message : 'План проверок сейчас недоступен'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [inn]);

  const year = data?.dataset?.year ?? new Date().getFullYear();

  return (
    <div className="sv-card sv-stack">
      <div className="sv-h2">Проверки {year}</div>
      {busy && <div className="sv-muted sv-small"><Spinner size={20} /> смотрю план проверок…</div>}
      {!busy && error && <div className="sv-banner">{error}</div>}
      {!busy && !error && data && !data.loaded && (
        <div className="sv-muted sv-small">План проверок ещё не загружен: набор Генпрокуратуры подтягивается в фоне после запуска сервера. Загляните чуть позже.</div>
      )}
      {!busy && !error && data?.loaded && (
        <>
          {!data.inn && <div className="sv-muted sv-small">Укажите ИНН выше — покажу, есть ли ваш бизнес в плане проверок на {year} год.</div>}
          {data.inn && data.own.length === 0 && (
            <div className="sv-muted sv-small">По ИНН {data.inn} плановых проверок в плане {year} года нет.</div>
          )}
          {data.own.length > 0 && (
            <div className="sv-list">
              {/* У одного КНМ бизнес может быть указан несколькими объектами: номер в ключе страхует от совпадения erpId. */}
              {data.own.map((x, i) => (
                <div key={`${x.erpId}-${i}`} className="sv-item">
                  <div>
                    <div className="sv-item__title">{x.kindControl ?? x.kindLabel}</div>
                    <div className="sv-item__sub">
                      {x.kindKnm ?? '—'}
                      {x.organization ? ` · ${x.organization}` : ''}
                      {x.address ? ` · ${x.address}` : ''}
                      {x.status ? ` · ${x.status}` : ''}
                    </div>
                  </div>
                  <div className="sv-item__value">{planDate(x.startDate)}</div>
                </div>
              ))}
            </div>
          )}
          {data.context.scope !== 'none' && data.context.region && (
            <>
              <div className="sv-muted sv-small">
                {data.context.scope === 'region_okved'
                  ? `В регионе «${data.context.region.name}» по ОКВЭД ${data.context.okved2} запланировано на ${year} год:`
                  : `В регионе «${data.context.region.name}» запланировано на ${year} год:`}
              </div>
              <div className="sv-chips">
                <span className="sv-badge">ГИТ {data.context.byKind.labor}</span>
                <span className="sv-badge">Роспотребнадзор {data.context.byKind.sanitary}</span>
                <span className="sv-badge">пожарный надзор {data.context.byKind.fire}</span>
                <span className="sv-badge sv-badge--muted">прочий надзор {data.context.byKind.other}</span>
              </div>
            </>
          )}
          {data.dataset && (
            <div className="sv-muted sv-small">
              Источник: ЕРКНМ (Генпрокуратура), план на {year} год, версия набора {planDate(data.dataset.version)} · загружено {fmtDate(data.dataset.loadedAt)}, {data.dataset.records} записей.
            </div>
          )}
        </>
      )}
    </div>
  );
}
