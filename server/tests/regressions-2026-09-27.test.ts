import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { beginInspectionsLoad, getUser, getVacancy, openDb, putVacancy, recordVacancySeen, updateUser, upsertUser, type InspectionRow } from '../src/db/index.js';
import { submitCandidateResponse, verifyContactSignature } from '../src/services/hiring.js';
import { responseSentText } from '../src/bot/texts.js';

const row: InspectionRow = {
  id: 'test', datasetYear: 2026, erpId: 'test', inn: null, ogrn: null, subjectName: null, subjectType: null, mspCode: null,
  okved: null, okved2: null, kind: 'labor', kindControl: null, kindKnm: null, typeName: null, status: null,
  startDate: null, stopDate: null, organization: null, prosecutorOffice: null, address: null, regionCode: null, regionFnsCode: null,
};
describe('регрессии аудита 27 сентября', () => {
  it('бот не обещает отправку уведомления при ошибке MAX', () => {
    expect(responseSentText(false, false)).toContain('уведомление в MAX сейчас не отправилось');
    expect(responseSentText(false, true)).toContain('работодателю отправлено сообщение');
  });
  it('ошибка записи метрики первого отклика откатывает сам отклик; повтор сохраняется ровно один раз', () => {
    const db = openDb(':memory:');
    putVacancy(db, { id: 'atomic-v', maxUserId: 1, cardId: null, professionKey: 'povar', regionCode: '78', title: 'Тест', salary: 50000, text: 'Тест', employerName: null });
    db.exec("CREATE TRIGGER metric_failure BEFORE UPDATE OF first_response_at ON vacancies BEGIN SELECT RAISE(ABORT, 'metric failed'); END");
    const answers = { experience: 'mid' as const, schedule: true, expectedSalary: null };
    expect(() => submitCandidateResponse(db, 2, 'atomic-v', answers)).toThrow('metric failed');
    expect((db.prepare('SELECT COUNT(*) AS n FROM responses').get() as { n: number }).n).toBe(0);
    expect(getVacancy(db, 'atomic-v')!.firstResponseAt).toBeNull();
    db.exec('DROP TRIGGER metric_failure');
    const first = submitCandidateResponse(db, 2, 'atomic-v', answers);
    const second = submitCandidateResponse(db, 2, 'atomic-v', answers);
    expect(first.created).toBe(true); expect(second.created).toBe(false);
    expect(first.response.id).toBe(second.response.id); expect(first.vacancy.firstResponseAt).not.toBeNull();
    db.close();
  });
  it('abort импорта не откатывает пользователей и параллельные наблюдения, в том числе между пачками', () => {
    for (const size of [1, 1000]) {
      const db = openDb(':memory:'); const loader = beginInspectionsLoad(db, 2026, size);
      loader.add(row);
      upsertUser(db, { maxUserId: 111, name: 'Сохранённый' });
      expect(() => recordVacancySeen(db, '78', 'povar', [{ id: 'v', employerInn: null, value: 50000 }], new Date().toISOString())).not.toThrow();
      expect(() => beginInspectionsLoad(db, 2026)).toThrow('уже выполняется');
      loader.abort();
      expect(getUser(db, 111)!.name).toBe('Сохранённый');
      expect((db.prepare('SELECT COUNT(*) AS n FROM vacancy_seen').get() as { n: number }).n).toBe(1);
      const next = beginInspectionsLoad(db, 2026); next.abort(); db.close();
    }
  });
  it('null действительно очищает ИНН, undefined сохраняет остальные поля', () => {
    const db = openDb(':memory:'); upsertUser(db, { maxUserId: 1 });
    updateUser(db, 1, { inn: '7801633015', regionFnsCode: '78' }); updateUser(db, 1, { inn: null });
    expect(getUser(db, 1)).toMatchObject({ inn: null, regionFnsCode: '78' }); db.close();
  });
  it('base64 подпись чувствительна к регистру, hex по-прежнему нет', () => {
    const token = 'test-token'; const vcf = 'BEGIN:VCARD\nTEL:+79990000000\nEND:VCARD';
    const mac = createHmac('sha256', token).update(vcf).digest(); const base64 = mac.toString('base64');
    expect(verifyContactSignature(token, vcf, base64)).toBe(true);
    expect(verifyContactSignature(token, vcf, base64.toLowerCase())).toBe(false);
    expect(verifyContactSignature(token, vcf, mac.toString('base64url'))).toBe(true);
    expect(verifyContactSignature(token, vcf, mac.toString('hex').toUpperCase())).toBe(true);
  });
});
