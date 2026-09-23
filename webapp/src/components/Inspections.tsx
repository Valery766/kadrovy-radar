import { useEffect, useState } from 'react';
import { Spinner } from '@maxhub/max-ui';
import { api, ApiError, fmtDate, type InspectionKind, type InspectionsResult } from '../lib/api';
import { INSPECTION_WORDS, nWord } from '../lib/plain';
import { Banner, Muted, Section, Text } from './ui';

interface Props {
  /** ИНН бизнеса: при смене блок перезапрашивается. null: сервер возьмёт ИНН профиля или демо-пакета. */
  inn: string | null;
}

/** «2026-03-16» → «16.03.2026». Дат из плана не придумываем: пусто – прочерк. */
const planDate = (iso: string | null): string => {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return m ? `${m[3]}.${m[2]}.${m[1]}` : 'дата не указана';
};

const KINDS: InspectionKind[] = ['labor', 'sanitary', 'fire', 'other'];
const checks = (n: number) => nWord(n, 'проверка', 'проверки', 'проверок');

/**
 * Блок «Проверки {год}»: плановые контрольные (надзорные) мероприятия по ИНН пользователя
 * и картина по региону и отрасли. Только факты плана ЕРКНМ, никаких оценок вероятности.
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
  const total = data?.context ? KINDS.reduce((s, k) => s + (data.context.byKind[k] ?? 0), 0) : 0;

  return (
    <Section title={`Проверки ${year}`}>
      <Muted>Кто придёт с плановой проверкой в этом году. Трудовая инспекция смотрит трудовые договоры и охрану труда, Роспотребнадзор – санитарные нормы, пожарный надзор – безопасность помещения.</Muted>
      {busy && <Muted><Spinner size={20} /> смотрю план проверок…</Muted>}
      {!busy && error && <Banner>{error}</Banner>}
      {!busy && !error && data && !data.loaded && (
        <Muted>План проверок ещё загружается: набор Генпрокуратуры подтягивается в фоне после запуска сервера. Загляните чуть позже.</Muted>
      )}
      {!busy && !error && data?.loaded && (
        <>
          {!data.inn && <Text>Укажите ИНН выше, и я проверю, есть ли ваш бизнес в плане проверок на {year} год.</Text>}
          {/* Без своего ИНН сервер показывает пример по демо-компании: говорим об этом прямо, чтобы чужой ИНН не приняли за свой. */}
          {data.inn && !inn && <Muted>Своего ИНН пока нет, поэтому для примера смотрю демо-компанию с ИНН {data.inn}. Укажите свой ИНН выше, чтобы проверить свой бизнес.</Muted>}
          {data.inn && data.own.length === 0 && (
            <Text>По ИНН {data.inn} плановых проверок на {year} год нет. Внеплановые проверки в план не входят.</Text>
          )}
          {data.own.length > 0 && (
            <>
              <Text>По ИНН {data.inn} в плане на {year} год: {checks(data.own.length)}. Подготовьте документы заранее.</Text>
              <div className="sv-list">
                {/* У одного КНМ бизнес может быть указан несколькими объектами: номер в ключе страхует от совпадения erpId. */}
                {data.own.map((x, i) => (
                  <div key={`${x.erpId}-${i}`} className="sv-item">
                    <div>
                      <div className="sv-item__title">{INSPECTION_WORDS[x.kind].who}: {INSPECTION_WORDS[x.kind].what}</div>
                      <div className="sv-item__sub">
                        {x.kindControl ?? x.kindLabel}
                        {x.kindKnm ? ` · ${x.kindKnm}` : ''}
                        {x.organization ? ` · ${x.organization}` : ''}
                        {x.address ? ` · ${x.address}` : ''}
                        {x.status ? ` · ${x.status}` : ''}
                      </div>
                    </div>
                    <div className="sv-item__value">{planDate(x.startDate)}<small>начало</small></div>
                  </div>
                ))}
              </div>
            </>
          )}
          {data.context.scope !== 'none' && data.context.region && (
            <>
              <Muted>
                {data.context.scope === 'region_okved'
                  ? `Для сравнения: в регионе ${data.context.region.name} по вашему виду деятельности (код ${data.context.okved2}) на ${year} год запланировано ${checks(total)}:`
                  : `Для сравнения: в регионе ${data.context.region.name} на ${year} год запланировано ${checks(total)}:`}
              </Muted>
              <div className="sv-chips">
                {KINDS.map((k) => <span key={k} className={`sv-badge ${k === 'other' ? 'sv-badge--muted' : ''}`}>{INSPECTION_WORDS[k].who}: {data.context.byKind[k] ?? 0}</span>)}
              </div>
            </>
          )}
          {data.dataset && (
            <Muted>
              Источник: план проверок Генпрокуратуры (ЕРКНМ) на {year} год, версия набора {planDate(data.dataset.version)}, загружено {fmtDate(data.dataset.loadedAt)}, {nWord(data.dataset.records, 'запись', 'записи', 'записей')}.
            </Muted>
          )}
        </>
      )}
    </Section>
  );
}
