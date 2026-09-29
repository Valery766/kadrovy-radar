import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Spinner, Textarea } from '@maxhub/max-ui';
import {
  api, ApiError, fmtDate, fmtDuration, responseStatusLabel, rub,
  type Bootstrap, type ResponseView, type VacancyView,
} from '../lib/api';
import { haptic, shareLink } from '../lib/bridge';
import { expectationWords, matchClass, matchWords, nWord } from '../lib/plain';
import { Banner, Muted, Nav, ScreenTitle, Section, Text, Tile } from '../components/ui';

interface Props {
  boot: Bootstrap;
  notInMax: boolean;
  /** Открытая вакансия: null – список. Экран инбокса, диплинк `inbox_<id>`. */
  vacancyId: string | null;
  onSelectVacancy: (id: string) => void;
  /** Назад к списку вакансий (кнопка «Все вакансии»). */
  onVacancies: () => void;
  onBack: () => void;
  onHome: () => void;
}

const STATUS_CLASS: Record<ResponseView['status'], string> = {
  new: 'sv-badge',
  invited: 'sv-badge sv-badge--ok',
  rejected: 'sv-badge sv-badge--muted',
  hired: 'sv-badge sv-badge--ok',
};

/** Ответы кандидата одной фразой: опыт, график, деньги, номер. */
function answersWords(r: ResponseView, vacancySalary: number | null): string {
  const parts = [
    `Опыт: ${r.experienceLabel.toLowerCase()}.`,
    r.answers.schedule ? 'График подходит.' : 'График не подходит.',
    `Ожидания по деньгам: ${expectationWords(r.answers.expectedSalary, vacancySalary)}.`,
    r.phone ? 'Номер оставил.' : 'Номер не оставил.',
  ];
  return parts.join(' ');
}

export function Inbox({ boot, notInMax, vacancyId: selectedId, onSelectVacancy, onVacancies, onBack, onHome }: Props) {
  const [vacancies, setVacancies] = useState<VacancyView[] | null>(null);
  const [vacancy, setVacancy] = useState<VacancyView | null>(null);
  const [responses, setResponses] = useState<ResponseView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteFor, setInviteFor] = useState<string | null>(null);
  const [inviteText, setInviteText] = useState('');
  const demo = boot.user.demo;
  const selectionSeq = useRef(0);

  const loadList = useCallback(async () => {
    setError(null);
    try { const r = await api.vacancies(); setVacancies(r.vacancies); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Не удалось загрузить вакансии'); setVacancies([]); }
  }, []);

  const loadVacancy = useCallback(async (id: string) => {
    const seq = ++selectionSeq.current;
    setError(null); setVacancy(null); setResponses(null);
    try { const r = await api.vacancyResponses(id); if (seq === selectionSeq.current) { setVacancy(r.vacancy); setResponses(r.responses); } }
    catch (e) { if (seq === selectionSeq.current) { setError(e instanceof ApiError ? e.message : 'Не удалось загрузить отклики'); setResponses([]); } }
  }, []);

  useEffect(() => { if (!demo) void loadList(); else setVacancies([]); }, [demo, loadList]);
  useEffect(() => { if (selectedId && !demo) void loadVacancy(selectedId); return () => { selectionSeq.current += 1; }; }, [selectedId, demo, loadVacancy]);

  /** Возвращает true при успехе: вызывающий решает, закрывать ли форму. */
  const act = async (key: string, fn: () => Promise<unknown>, okText: string): Promise<boolean> => {
    setBusy(key); setNote(null);
    try {
      const result = await fn() as { delivery?: string; notificationsFailed?: number; otherNotificationsFailed?: number };
      haptic('success');
      const failed = result.delivery === 'failed' || (result.notificationsFailed ?? 0) > 0 || (result.otherNotificationsFailed ?? 0) > 0;
      setNote({ kind: failed ? 'error' : 'info', text: failed ? 'Решение сохранено, но часть сообщений в MAX не отправлена. Не считайте кандидата уведомлённым: свяжитесь с ним отдельно.' : result.delivery === 'unchanged' ? 'Это решение уже сохранено. Повторное сообщение не отправлялось.' : okText });
      if (selectedId) await loadVacancy(selectedId);
      await loadList();
      return true;
    } catch (e) {
      haptic('error');
      setNote({ kind: 'error', text: e instanceof ApiError ? e.message : 'Действие не выполнилось' });
      return false;
    } finally { setBusy(null); }
  };

  const shareVacancy = async (v: VacancyView) => {
    if (!v.link) return;
    const text = `Вакансия: ${v.title}, ${v.regionName}${v.salary ? `, от ${rub(v.salary)}` : ''}. Откликнуться в MAX:`;
    const r = await shareLink(text, v.link);
    if (r !== 'shared') {
      try { await navigator.clipboard.writeText(`${text} ${v.link}`); setNote({ kind: 'info', text: 'Ссылка на вакансию скопирована.' }); }
      catch { setNote({ kind: 'info', text: v.link }); }
    }
  };

  if (demo) {
    return (
      <div className="sv-page sv-stack">
        <div className="sv-head">
          <ScreenTitle>Вакансии и отклики</ScreenTitle>
          <Text>Здесь собираются опубликованные вакансии и отклики кандидатов. Каждый отклик приходит с оценкой совпадения словами: опыт, график, ожидания по деньгам, номер телефона.</Text>
        </div>
        <Banner>Открыто вне MAX: демо-режим. Публикация вакансии и отклики кандидатов работают только внутри мессенджера: там бот принимает отклики по ссылке и пишет кандидатам о приглашении или отказе.</Banner>
        <Section title="Как это выглядит внутри MAX">
          <ol className="sv-steps">
            <li className="sv-step"><span className="sv-step__num">1</span><div className="sv-step__body"><div className="sv-step__title">Публикуете вакансию из карточки ставки</div><Muted>Бот присылает ссылку и QR-код. Перешлите их в чаты сотрудников и партнёров или распечатайте.</Muted></div></li>
            <li className="sv-step"><span className="sv-step__num">2</span><div className="sv-step__body"><div className="sv-step__title">Кандидат отвечает на три вопроса прямо в MAX</div><Muted>Опыт, готовность к графику, ожидания по ставке. Номер телефона оставляет кнопкой MAX.</Muted></div></li>
            <li className="sv-step"><span className="sv-step__num">3</span><div className="sv-step__body"><div className="sv-step__title">Отклик появляется здесь</div><Muted>С оценкой совпадения и ответами. Кнопки «Пригласить», «Отказать», «Нанят» отправляют кандидату сообщение от бота.</Muted></div></li>
          </ol>
        </Section>
        <Nav onBack={onBack} onHome={onHome} />
      </div>
    );
  }

  /* ---------- список вакансий ---------- */
  if (!selectedId) {
    return (
      <div className="sv-page sv-stack">
        <div className="sv-head">
          <ScreenTitle>Вакансии и отклики</ScreenTitle>
          <Text>Опубликованные вакансии и отклики кандидатов. Нажмите на вакансию, чтобы увидеть, кто откликнулся.</Text>
        </div>
        {notInMax && <Banner>Действия с откликами отправляют сообщения кандидатам: они работают внутри MAX.</Banner>}
        {error && <Banner kind="error">{error}</Banner>}
        <Button stretched variant="secondary" onClick={() => void loadList()}>Обновить вакансии и отклики</Button>
        {!vacancies && <div className="sv-center"><Spinner /></div>}
        {vacancies && vacancies.length === 0 && !error && (
          <Section title="Пока пусто">
            <Text>Опубликованных вакансий нет. Проверьте ставку, выберите вариант и нажмите «Опубликовать»: бот пришлёт ссылку и QR-код для кандидатов, а отклики появятся здесь.</Text>
          </Section>
        )}
        {vacancies && vacancies.length > 0 && (
          <Section>
            <div className="sv-list">
              {vacancies.map((v) => (
                <div key={v.id} className="sv-item" role="button" tabIndex={0}
                  onClick={() => onSelectVacancy(v.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectVacancy(v.id); } }}>
                  <div>
                    <div className="sv-item__title">{v.title} · {v.regionName}</div>
                    <div className="sv-item__sub">{v.status === 'open' ? 'открыта' : 'закрыта'} · {fmtDate(v.createdAt)}{v.salary ? ` · от ${rub(v.salary)}` : ''}</div>
                  </div>
                  <div className="sv-item__value">{nWord(v.responses, 'отклик', 'отклика', 'откликов')}{v.newResponses ? <small>{v.newResponses} новых</small> : null}</div>
                </div>
              ))}
            </div>
          </Section>
        )}
        <Nav onBack={onBack} onHome={onHome} />
      </div>
    );
  }

  /* ---------- отклики по одной вакансии ---------- */
  return (
    <div className="sv-page sv-stack">
      <div className="sv-head">
        <ScreenTitle>{vacancy ? `${vacancy.title} · ${vacancy.regionName}` : 'Вакансии и отклики'}</ScreenTitle>
        {vacancy && (
          <Text>
            {vacancy.responses === 0
              ? 'Откликов пока нет.'
              : `${nWord(vacancy.responses, 'отклик', 'отклика', 'откликов')}${vacancy.newResponses ? `, ${nWord(vacancy.newResponses, 'новый', 'новых', 'новых')}` : ''}.`}
            {vacancy.status === 'open' ? ' Вакансия открыта: кандидаты могут откликаться.' : ' Вакансия закрыта: новые отклики не принимаются.'}
          </Text>
        )}
      </div>
      <Button stretched variant="secondary" disabled={busy !== null} onClick={() => selectedId && void loadVacancy(selectedId)}>Обновить отклики</Button>
      {error && <Banner kind="error">{error}</Banner>}
      {note && <Banner kind={note.kind === 'error' ? 'error' : 'info'}>{note.text}</Banner>}

      {vacancy && (
        <Section>
          <div className="sv-chips">
            <span className={`sv-badge ${vacancy.status === 'open' ? 'sv-badge--ok' : 'sv-badge--muted'}`}>{vacancy.status === 'open' ? 'вакансия открыта' : 'вакансия закрыта'}</span>
            {vacancy.salary && <span className="sv-badge sv-badge--muted">от {rub(vacancy.salary)}</span>}
          </div>
          <div className="sv-tiles">
            <Tile label="Откликов" value={vacancy.responses} note="всего с момента публикации" />
            <Tile label="Новых" value={vacancy.newResponses} note="ещё не смотрели" />
            <Tile label="Первый отклик через" value={fmtDuration(vacancy.metrics.timeToFirstResponseMin)} note="после публикации" />
            <Tile label="Закрыта за" value={fmtDuration(vacancy.metrics.timeToHireMin)} note="от публикации до найма" />
          </div>
          {vacancy.link && <Muted>Ссылка для кандидатов: {vacancy.link}</Muted>}
          <div className="sv-actions">
            {vacancy.status === 'open' && <>
              <Muted>{vacancy.listed ? 'Вакансия видна всем в каталоге «Найти работу».' : 'Вакансия пока доступна только по ссылке и QR. Добавление в каталог сделает текст объявления общедоступным.'}</Muted>
              <Button stretched variant="secondary" loading={busy === 'listing'} disabled={busy !== null} onClick={() => void act('listing', () => api.listing(vacancy.id, !vacancy.listed), vacancy.listed ? 'Вакансия убрана из каталога. Ссылка продолжает работать.' : 'Вакансия добавлена в общий каталог: кандидаты могут найти её без QR.')}>{vacancy.listed ? 'Убрать из каталога' : 'Добавить в общий каталог'}</Button>
            </>}
            <Button stretched variant="secondary" disabled={!vacancy.link} onClick={() => void shareVacancy(vacancy)}>Поделиться в MAX</Button>
            {vacancy.status === 'open' && (
              <Button stretched variant="ghost" loading={busy === 'close'} disabled={busy !== null}
                onClick={() => void act('close', () => api.closeVacancy(vacancy.id), 'Вакансия закрыта, кандидатам отправлено уведомление.')}>Закрыть вакансию</Button>
            )}
          </div>
        </Section>
      )}

      {!responses && <div className="sv-center"><Spinner /></div>}
      {responses && responses.length === 0 && (
        <Section title="Откликов пока нет">
          <Text>Перешлите ссылку или QR-код в чаты сотрудников, партнёров и местные каналы MAX: кандидат откликнется прямо в мессенджере.</Text>
        </Section>
      )}

      {responses?.map((r) => (
        <Section key={r.id}>
          <div className="sv-row">
            <div className="sv-item__title">{r.candidateName ?? 'Кандидат'}</div>
            <div className="sv-item__value">{r.score} из {r.maxScore}<small>совпадение с вакансией</small></div>
          </div>
          <div className="sv-chips">
            <span className={STATUS_CLASS[r.status]}>{responseStatusLabel(r.status)}</span>
            <span className={`sv-badge ${matchClass(r.score, r.maxScore)}`}>{matchWords(r.score, r.maxScore)}</span>
          </div>
          <Text>{answersWords(r, vacancy?.salary ?? null)}</Text>
          <Muted>
            {r.phone
              ? <>Телефон: <a className="sv-link" href={`tel:${r.phone}`}>{r.phone}</a>{r.phoneVerified ? ' · номер подтверждён MAX' : ' · номер не подтверждён'}</>
              : vacancy?.status === 'open' && (r.status === 'new' || r.status === 'invited') ? 'Пригласите кандидата сообщением в MAX.' : 'Сохранены ответы кандидата и история статуса.'}
            {' · '}отклик {fmtDate(r.createdAt)}
          </Muted>

          {inviteFor === r.id && (
            <div className="sv-stack">
              <Textarea className="sv-textarea" style={{ minHeight: 90 }} value={inviteText} onChange={(e) => setInviteText(e.target.value)}
                placeholder="Например: ждём вас завтра в 11:00, Невский 20, спросить Ольгу" />
              <div className="sv-actions">
                <Button stretched loading={busy === `invite:${r.id}`} disabled={busy !== null}
                  onClick={() => void act(`invite:${r.id}`, () => api.invite(r.id, inviteText), 'Приглашение отправлено кандидату в MAX.')
                    .then((ok) => { if (ok) { setInviteFor(null); setInviteText(''); } })}>Отправить приглашение</Button>
                <Button stretched variant="ghost" onClick={() => { setInviteFor(null); setInviteText(''); }}>Отмена</Button>
              </div>
            </div>
          )}

          {inviteFor !== r.id && (
            <div className="sv-actions">
              {vacancy?.status === 'open' && (r.status === 'new' || r.status === 'invited') && <Button stretched onClick={() => { setInviteFor(r.id); setInviteText(''); }} disabled={busy !== null}>Пригласить</Button>}
              {vacancy?.status === 'open' && r.status !== 'hired' && r.status !== 'rejected' && (
                <Button stretched variant="secondary" loading={busy === `hire:${r.id}`} disabled={busy !== null}
                  onClick={() => void act(`hire:${r.id}`, () => api.hire(r.id), 'Кандидат нанят, вакансия закрыта, остальным отправлено уведомление.')}>Нанят</Button>
              )}
              {vacancy?.status === 'open' && r.status !== 'rejected' && r.status !== 'hired' && (
                <Button stretched variant="ghost" loading={busy === `reject:${r.id}`} disabled={busy !== null}
                  onClick={() => void act(`reject:${r.id}`, () => api.reject(r.id), 'Отказ отправлен кандидату.')}>Отказать</Button>
              )}
            </div>
          )}
        </Section>
      ))}

      <Section title="Как считается совпадение" gap="tight">
        <Muted>Складываем четыре признака, правила одинаковые для всех откликов: опыт (чем больше, тем больше баллов, до 6), готов к графику (+3), ожидания по деньгам не выше ставки вакансии (+3, до +30 % к ставке: +1), оставил номер (+1). Максимум {responses?.[0]?.maxScore ?? 13} баллов: от 10 считаем хорошим совпадением, от 7 частичным.</Muted>
      </Section>

      <Nav onBack={() => { setVacancy(null); setResponses(null); setNote(null); onVacancies(); }} backLabel="Все вакансии" onHome={onHome} />
    </div>
  );
}
