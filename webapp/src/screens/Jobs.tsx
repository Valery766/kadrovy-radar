import { useEffect, useState } from 'react';
import { Button, Input, Spinner } from '@maxhub/max-ui';
import { api, ApiError, fmtDate, responseStatusLabel, rub, type Bootstrap, type CandidateAnswers, type JobDetail, type JobView } from '../lib/api';
import { Banner, Muted, Nav, ScreenTitle, Section, Text } from '../components/ui';

interface Props { boot: Bootstrap; jobId: string | null; onSelect: (id: string) => void; onBack: () => void; onHome: () => void; onEmployer: (id: string) => void }
const message = (error: unknown) => error instanceof ApiError ? error.message : 'Не удалось получить данные. Попробуйте ещё раз.';
const emptyFilters = { q: '', region: '', minSalary: '', offset: 0 };

/** Общедоступные объявления, но отклик отправляется только выбранному работодателю и только с подтверждением кандидата. */
export function Jobs({ boot, jobId, onSelect, onBack, onHome, onEmployer }: Props) {
  const [draft, setDraft] = useState(emptyFilters);
  const [filters, setFilters] = useState(emptyFilters);
  const [items, setItems] = useState<JobView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [job, setJob] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [experience, setExperience] = useState<CandidateAnswers['experience'] | ''>('');
  const [schedule, setSchedule] = useState('');
  const [salary, setSalary] = useState('');
  const [consent, setConsent] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setError(null); setNote(null); setJob(null); setItems(null);
    setExperience(''); setSchedule(''); setSalary(''); setConsent(false);
    const load = async () => {
      try {
        if (jobId) { const result = await api.job(jobId); if (active) setJob(result.job); }
        else { const result = await api.jobs(filters); if (active) { setItems(result.jobs); setTotal(result.total); } }
      } catch (e) { if (active) setError(message(e)); }
    };
    void load();
    return () => { active = false; };
  }, [jobId, filters, retry]);

  const apply = async () => {
    if (!job || !experience || !schedule || !consent) return;
    const expectedSalary = salary.trim() ? Number(salary) : null;
    if (expectedSalary !== null && (!Number.isInteger(expectedSalary) || expectedSalary < 1000 || expectedSalary > 5_000_000)) { setError('Укажите зарплату от 1 000 до 5 000 000 ₽ или оставьте поле пустым'); return; }
    setBusy(true); setError(null);
    try {
      const result = await api.apply(job.id, { experience, schedule: schedule === 'yes', expectedSalary, consent: true });
      setJob((current) => current && { ...current, myResponse: result.response.status });
      setNote(result.created ? (result.employerNotified ? 'Отклик сохранён. Работодателю отправлено сообщение в MAX. Ответ придёт в чат с ботом.' : 'Отклик сохранён в кабинете работодателя. Уведомление в MAX сейчас не отправлено. Ответ придёт в чат с ботом.') : 'Вы уже откликнулись: второй отклик не создан.');
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  };

  return <div className="sv-page sv-stack">
    <div className="sv-head"><ScreenTitle>{jobId ? 'Вакансия' : 'Найти работу'}</ScreenTitle>
      <Text>{jobId ? 'Прочитайте условия и откликнитесь прямо в MAX.' : 'Открытые вакансии работодателей «Кадрового радара». QR-код и специальная ссылка не нужны.'}</Text></div>
    {error && <Banner kind="error">{error}<Button variant="ghost" onClick={() => setRetry((r) => r + 1)}>Повторить</Button></Banner>}
    {note && <Banner>{note}</Banner>}
    {!jobId && <>
      <Section title="Поиск вакансий">
        <form className="sv-stack" onSubmit={(e) => { e.preventDefault(); setFilters({ ...draft, offset: 0 }); }}>
          <label htmlFor="job-query">Должность или работодатель<Input id="job-query" placeholder="Например, повар или название компании" value={draft.q} maxLength={120} onChange={(e) => setDraft({ ...draft, q: e.target.value })} /></label>
          <label htmlFor="job-region">Регион<select className="sv-select" id="job-region" value={draft.region} onChange={(e) => setDraft({ ...draft, region: e.target.value })}>
            <option value="">Все регионы</option>{boot.regions.map((r) => <option key={r.fnsCode} value={r.fnsCode}>{r.name}</option>)}
          </select></label>
          <label htmlFor="job-min-salary">Зарплата от, ₽ в месяц<Input id="job-min-salary" inputMode="numeric" placeholder="Неважно" value={draft.minSalary} onChange={(e) => setDraft({ ...draft, minSalary: e.target.value.replace(/\D/g, '').slice(0, 7) })} /></label>
          <div className="sv-actions"><Button type="submit">Найти вакансии</Button><Button type="button" variant="ghost" onClick={() => { setDraft(emptyFilters); setFilters({ ...emptyFilters }); }}>Сбросить</Button></div>
        </form>
      </Section>
      {!items && !error && <div className="sv-center"><Spinner /></div>}
      {items && <Section title={`Найдено вакансий: ${total}`}>
        {items.length === 0 && <Text>{total ? 'На этой странице вакансий больше нет. Вернитесь к первой странице.' : 'Подходящих вакансий пока нет. Попробуйте другой регион или сбросьте фильтры.'}</Text>}
        <div className="sv-list">{items.map((v) => <div className="sv-item" key={v.id}>
          <div><div className="sv-item__title">{v.title}</div><div className="sv-item__sub">{v.regionName}{v.employerName ? ` · ${v.employerName}` : ''}</div><Text>{v.salary ? `От ${rub(v.salary)} в месяц` : 'Зарплата не указана'}</Text><Muted>{fmtDate(v.createdAt)}{v.own ? ' · ваша вакансия' : ''}</Muted><Button variant="secondary" onClick={() => onSelect(v.id)}>Посмотреть</Button></div>
        </div>)}</div>
        <div className="sv-actions">{filters.offset > 0 && <Button variant="secondary" onClick={() => setFilters({ ...filters, offset: Math.max(0, filters.offset - 12) })}>Назад</Button>}{filters.offset + 12 < total && <Button onClick={() => setFilters({ ...filters, offset: filters.offset + 12 })}>Следующая страница</Button>}</div>
      </Section>}
      <Muted>Здесь только объявления работодателей «Кадрового радара». Внешние данные «Работы России» используются для расчёта ставки и в каталог не попадают.</Muted>
    </>}
    {jobId && !job && !error && <div className="sv-center"><Spinner /></div>}
    {job && <>
      <Section title={`${job.title} · ${job.regionName}`}>
        <Text>{job.employerName ?? 'Название работодателя не указано'}</Text><Text>{job.salary ? `От ${rub(job.salary)} в месяц` : 'Зарплата обсуждается'}</Text>
        <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{job.text}</div><Muted>Размещено {fmtDate(job.createdAt)}. Условия указал работодатель.</Muted>
      </Section>
      {job.own ? <Section><Text>Это ваша вакансия.</Text><Button onClick={() => onEmployer(job.id)}>Открыть отклики</Button></Section>
        : job.myResponse ? <Banner>Ваш отклик: {responseStatusLabel(job.myResponse)}. Ответ работодателя придёт в чат с ботом.</Banner>
          : job.status === 'closed' ? <Banner>Вакансия уже закрыта: новые отклики не принимаются.</Banner>
            : boot.user.demo ? <Banner>Чтобы откликнуться, откройте вакансию в MAX.{job.link && <p><a className="sv-link" href={job.link}>Открыть вакансию в боте MAX</a></p>}</Banner>
              : <Section title="Откликнуться · три вопроса">
                <form className="sv-stack" onSubmit={(e) => { e.preventDefault(); void apply(); }}>
                  <label htmlFor="job-experience">1. Опыт по этой должности<select id="job-experience" className="sv-select" value={experience} onChange={(e) => setExperience(e.target.value as CandidateAnswers['experience'] | '')}><option value="">Выберите ответ</option><option value="none">Без опыта</option><option value="lt1">До года</option><option value="mid">1–3 года</option><option value="senior">3 года и больше</option></select></label>
                  <label htmlFor="job-schedule">2. Подходит ли график из объявления?<select id="job-schedule" className="sv-select" value={schedule} onChange={(e) => setSchedule(e.target.value)}><option value="">Выберите ответ</option><option value="yes">Подходит</option><option value="no">Не подходит / хочу обсудить</option></select></label>
                  <label htmlFor="job-salary">3. Ожидаемая зарплата, ₽ в месяц<Input id="job-salary" inputMode="numeric" placeholder="Как в вакансии" value={salary} onChange={(e) => setSalary(e.target.value.replace(/\D/g, '').slice(0, 7))} /></label>
                  <Muted>Пустое поле зарплаты означает «как в вакансии». Телефон не требуется: работодатель ответит через бота MAX.</Muted>
                  <label className="sv-consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Передать моё имя из MAX и эти ответы только работодателю этой вакансии для рассмотрения отклика.</label>
                  <Button type="submit" loading={busy} disabled={busy || !experience || !schedule || !consent}>Отправить отклик</Button>
                </form>
              </Section>}
    </>}
    <Nav onBack={onBack} onHome={onHome} />
  </div>;
}
