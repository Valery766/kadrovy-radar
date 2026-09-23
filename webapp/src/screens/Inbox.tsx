import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner, Textarea } from '@maxhub/max-ui';
import {
  api, ApiError, fmtDate, fmtDuration, responseStatusLabel, rub,
  type Bootstrap, type ResponseView, type VacancyView,
} from '../lib/api';
import { haptic, shareLink } from '../lib/bridge';

interface Props {
  boot: Bootstrap;
  notInMax: boolean;
  /** Открыть сразу инбокс этой вакансии (диплинк `inbox_<id>`). */
  initialVacancyId?: string | null;
  onHome: () => void;
}

const STATUS_CLASS: Record<ResponseView['status'], string> = {
  new: 'sv-badge',
  invited: 'sv-badge sv-badge--ok',
  rejected: 'sv-badge sv-badge--muted',
  hired: 'sv-badge sv-badge--ok',
};

export function Inbox({ boot, notInMax, initialVacancyId, onHome }: Props) {
  const [vacancies, setVacancies] = useState<VacancyView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialVacancyId ?? null);
  const [vacancy, setVacancy] = useState<VacancyView | null>(null);
  const [responses, setResponses] = useState<ResponseView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [inviteFor, setInviteFor] = useState<string | null>(null);
  const [inviteText, setInviteText] = useState('');
  const demo = boot.user.demo;

  const loadList = useCallback(async () => {
    setError(null);
    try { const r = await api.vacancies(); setVacancies(r.vacancies); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Не удалось загрузить вакансии'); setVacancies([]); }
  }, []);

  const loadVacancy = useCallback(async (id: string) => {
    setError(null); setResponses(null);
    try { const r = await api.vacancyResponses(id); setVacancy(r.vacancy); setResponses(r.responses); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Не удалось загрузить отклики'); setResponses([]); }
  }, []);

  useEffect(() => { if (!demo) void loadList(); else setVacancies([]); }, [demo, loadList]);
  useEffect(() => { if (selectedId && !demo) void loadVacancy(selectedId); }, [selectedId, demo, loadVacancy]);

  const act = async (key: string, fn: () => Promise<unknown>, okText: string) => {
    setBusy(key); setNote(null);
    try {
      await fn();
      haptic('success');
      setNote({ kind: 'info', text: okText });
      if (selectedId) await loadVacancy(selectedId);
      await loadList();
    } catch (e) {
      haptic('error');
      setNote({ kind: 'error', text: e instanceof ApiError ? e.message : 'Действие не выполнилось' });
    } finally { setBusy(null); }
  };

  const shareVacancy = async (v: VacancyView) => {
    if (!v.link) return;
    const text = `Вакансия: ${v.title}, ${v.regionName}${v.salary ? ` — от ${rub(v.salary)}` : ''}. Откликнуться в MAX:`;
    const r = await shareLink(text, v.link);
    if (r !== 'shared') {
      try { await navigator.clipboard.writeText(`${text} ${v.link}`); setNote({ kind: 'info', text: 'Ссылка на вакансию скопирована.' }); }
      catch { setNote({ kind: 'info', text: v.link }); }
    }
  };

  if (demo) {
    return (
      <div className="sv-page sv-stack">
        <div className="sv-title">Отклики</div>
        <div className="sv-banner">Открыто вне MAX: демо-режим. Публикация вакансии и отклики кандидатов работают только внутри мессенджера — там бот принимает отклики по ссылке и пишет кандидатам о приглашении или отказе.</div>
        <div className="sv-card sv-stack">
          <div className="sv-h2">Как это выглядит внутри MAX</div>
          <div className="sv-muted sv-small">Кандидат открывает ссылку вида max.ru/бот?start=vac_… → отвечает на три вопроса (опыт, готовность к графику, ожидания по ставке) → делится номером кнопкой MAX. Отклик попадает сюда с баллом совпадения; кнопки «Пригласить», «Отказать», «Нанят» отправляют кандидату сообщение от бота.</div>
        </div>
        <Button stretched variant="ghost" onClick={onHome}>На главную</Button>
      </div>
    );
  }

  /* ---------- список вакансий ---------- */
  if (!selectedId) {
    return (
      <div className="sv-page sv-stack">
        <div className="sv-title">Мои вакансии</div>
        {notInMax && <div className="sv-banner">Действия с откликами отправляют сообщения кандидатам — они работают внутри MAX.</div>}
        {error && <div className="sv-banner sv-banner--error">{error}</div>}
        {!vacancies && <div className="sv-center"><Spinner /></div>}
        {vacancies && vacancies.length === 0 && !error && (
          <div className="sv-card sv-stack">
            <div className="sv-h2">Пока пусто</div>
            <div className="sv-muted sv-small">Опубликованных вакансий нет. Откройте карточку рынка, выберите ставку и нажмите «Опубликовать вакансию» — бот пришлёт ссылку и QR для кандидатов.</div>
          </div>
        )}
        {vacancies && vacancies.length > 0 && (
          <div className="sv-card">
            <div className="sv-list">
              {vacancies.map((v) => (
                <div key={v.id} className="sv-item" role="button" onClick={() => setSelectedId(v.id)}>
                  <div>
                    <div className="sv-item__title">{v.title} — {v.regionName}</div>
                    <div className="sv-item__sub">{v.status === 'open' ? 'открыта' : 'закрыта'} · {fmtDate(v.createdAt)}{v.salary ? ` · от ${rub(v.salary)}` : ''}</div>
                  </div>
                  <div className="sv-item__value">{v.responses}{v.newResponses ? ` (+${v.newResponses})` : ''}</div>
                </div>
              ))}
            </div>
            <div className="sv-muted sv-small" style={{ marginTop: 8 }}>Справа — число откликов, в скобках новые.</div>
          </div>
        )}
        <Button stretched variant="ghost" onClick={onHome}>На главную</Button>
      </div>
    );
  }

  /* ---------- отклики по одной вакансии ---------- */
  return (
    <div className="sv-page sv-stack">
      <div className="sv-title">{vacancy ? `${vacancy.title} — ${vacancy.regionName}` : 'Отклики'}</div>
      {error && <div className="sv-banner sv-banner--error">{error}</div>}
      {note && <div className={`sv-banner ${note.kind === 'error' ? 'sv-banner--error' : 'sv-banner--info'}`}>{note.text}</div>}

      {vacancy && (
        <div className="sv-card sv-stack">
          <div className="sv-chips">
            <span className={`sv-badge ${vacancy.status === 'open' ? 'sv-badge--ok' : 'sv-badge--muted'}`}>{vacancy.status === 'open' ? 'вакансия открыта' : 'вакансия закрыта'}</span>
            {vacancy.salary && <span className="sv-badge sv-badge--muted">от {rub(vacancy.salary)}</span>}
          </div>
          <div className="sv-tiles">
            <div className="sv-tile"><div className="sv-tile__label">Откликов</div><div className="sv-tile__value">{vacancy.responses}</div></div>
            <div className="sv-tile"><div className="sv-tile__label">Новых</div><div className="sv-tile__value">{vacancy.newResponses}</div></div>
            <div className="sv-tile"><div className="sv-tile__label">Время до первого отклика</div><div className="sv-tile__value">{fmtDuration(vacancy.metrics.timeToFirstResponseMin)}</div></div>
            <div className="sv-tile"><div className="sv-tile__label">Срок закрытия</div><div className="sv-tile__value">{fmtDuration(vacancy.metrics.timeToHireMin)}</div></div>
          </div>
          {vacancy.link && <div className="sv-muted sv-small">Ссылка для кандидатов: {vacancy.link}</div>}
          <div className="sv-actions">
            <Button stretched variant="secondary" onClick={() => void shareVacancy(vacancy)}>Поделиться в MAX</Button>
            {vacancy.status === 'open' && (
              <Button stretched variant="ghost" loading={busy === 'close'} disabled={busy !== null}
                onClick={() => void act('close', () => api.closeVacancy(vacancy.id), 'Вакансия закрыта, кандидатам отправлено уведомление.')}>Закрыть вакансию</Button>
            )}
          </div>
        </div>
      )}

      {!responses && <div className="sv-center"><Spinner /></div>}
      {responses && responses.length === 0 && (
        <div className="sv-card sv-stack">
          <div className="sv-h2">Откликов пока нет</div>
          <div className="sv-muted sv-small">Перешлите ссылку или QR в чаты сотрудников, партнёров и местные каналы MAX — кандидат откликнется прямо в мессенджере.</div>
        </div>
      )}

      {responses?.map((r) => (
        <div key={r.id} className="sv-card sv-stack">
          <div className="sv-row">
            <div className="sv-item__title">{r.candidateName ?? 'Кандидат'}</div>
            <div className="sv-item__value">{r.score} / {r.maxScore}</div>
          </div>
          <div className="sv-chips">
            <span className={STATUS_CLASS[r.status]}>{responseStatusLabel(r.status)}</span>
            <span className="sv-badge sv-badge--muted">опыт: {r.experienceLabel}</span>
            <span className="sv-badge sv-badge--muted">график: {r.answers.schedule ? 'готов' : 'не готов'}</span>
            <span className="sv-badge sv-badge--muted">ожидания: {r.answers.expectedSalary == null ? 'как в вакансии' : rub(r.answers.expectedSalary)}</span>
          </div>
          <div className="sv-muted sv-small">
            {r.phone
              ? <>Телефон: <a className="sv-link" href={`tel:${r.phone}`}>{r.phone}</a>{r.phoneVerified ? ' · подпись MAX проверена' : ' · подпись не подтверждена'}</>
              : 'Номер не оставлен — свяжитесь через приглашение, бот напишет кандидату в MAX.'}
            {' · '}отклик {fmtDate(r.createdAt)}
          </div>

          {inviteFor === r.id && (
            <div className="sv-stack">
              <Textarea className="sv-textarea" style={{ minHeight: 90 }} value={inviteText} onChange={(e) => setInviteText(e.target.value)}
                placeholder="Например: ждём вас завтра в 11:00, Невский 20, спросить Ольгу" />
              <div className="sv-actions">
                <Button stretched loading={busy === `invite:${r.id}`} disabled={busy !== null}
                  onClick={() => void act(`invite:${r.id}`, () => api.invite(r.id, inviteText), 'Приглашение отправлено кандидату в MAX.').then(() => { setInviteFor(null); setInviteText(''); })}>Отправить приглашение</Button>
                <Button stretched variant="ghost" onClick={() => { setInviteFor(null); setInviteText(''); }}>Отмена</Button>
              </div>
            </div>
          )}

          {inviteFor !== r.id && (
            <div className="sv-actions">
              {r.status !== 'hired' && <Button stretched onClick={() => { setInviteFor(r.id); setInviteText(''); }} disabled={busy !== null}>Пригласить</Button>}
              {r.status !== 'hired' && r.status !== 'rejected' && (
                <Button stretched variant="secondary" loading={busy === `hire:${r.id}`} disabled={busy !== null}
                  onClick={() => void act(`hire:${r.id}`, () => api.hire(r.id), 'Кандидат нанят, вакансия закрыта, остальным отправлено уведомление.')}>Нанят</Button>
              )}
              {r.status !== 'rejected' && r.status !== 'hired' && (
                <Button stretched variant="ghost" loading={busy === `reject:${r.id}`} disabled={busy !== null}
                  onClick={() => void act(`reject:${r.id}`, () => api.reject(r.id), 'Отказ отправлен кандидату.')}>Отказать</Button>
              )}
            </div>
          )}
        </div>
      ))}

      <div className="sv-card sv-stack" style={{ gap: 6 }}>
        <div className="sv-h2">Как считается совпадение</div>
        <div className="sv-muted sv-small">Детерминированные правила, без нейросети: опыт (нет / до года / 1–3 / 3+) × 2 балла, готовность к графику +3, ожидания в пределах ставки вакансии +3 (до +30 % — +1), оставленный номер +1. Максимум — {responses?.[0]?.maxScore ?? 13} баллов.</div>
      </div>

      <div className="sv-actions">
        <Button stretched variant="ghost" onClick={() => { setSelectedId(null); setVacancy(null); setResponses(null); setNote(null); }}>Все вакансии</Button>
        <Button stretched variant="ghost" onClick={onHome}>На главную</Button>
      </div>
    </div>
  );
}
