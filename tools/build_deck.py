"""Сборка презентации «Ставка» (PPTX → PDF через LibreOffice).
Запуск: tools/.venv/bin/python tools/build_deck.py --commit <hash> [--token ...] [--secrets-file .env] --out out/
Служебный первый слайд заполняется из аргументов; без секретов получается публичная версия."""
import argparse, json, os, subprocess, sys
from pathlib import Path
from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.shapes import MSO_SHAPE

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / 'docs' / 'shots'
BLUE = RGBColor(0x2F, 0x6B, 0xFF); DARK = RGBColor(0x11, 0x18, 0x27); MUTED = RGBColor(0x6B, 0x72, 0x80)
LIGHT = RGBColor(0xF3, 0xF6, 0xFF); WHITE = RGBColor(0xFF, 0xFF, 0xFF); GREEN = RGBColor(0x1F, 0x9D, 0x55); ORANGE = RGBColor(0xF9, 0x73, 0x16)
FONT = 'Arial'

ap = argparse.ArgumentParser()
ap.add_argument('--commit', default='<commit hash>')
ap.add_argument('--repo', default='<ссылка на репозиторий>')
ap.add_argument('--secrets-file', default=None, help='.env с MAX_BOT_TOKEN/MAX_WEBHOOK_SECRET для служебного слайда')
ap.add_argument('--out', default=str(ROOT / 'out'))
ap.add_argument('--app-url', default='https://stavka.i-tech.unecon.ru/app/')
ap.add_argument('--name', default='stavka-presentation')
args = ap.parse_args()

secrets = {}
if args.secrets_file and Path(args.secrets_file).exists():
    for line in Path(args.secrets_file).read_text(encoding='utf8').splitlines():
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1); secrets[k.strip()] = v.strip()

prs = Presentation()
prs.slide_width = Inches(13.333); prs.slide_height = Inches(7.5)
BLANK = prs.slide_layouts[6]
W, H = prs.slide_width, prs.slide_height

def txt(slide, x, y, w, h, text, size=18, bold=False, color=DARK, align=PP_ALIGN.LEFT, font=FONT, anchor=MSO_ANCHOR.TOP):
    tb = slide.shapes.add_textbox(x, y, w, h); tf = tb.text_frame; tf.word_wrap = True; tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Inches(0.05); tf.margin_top = tf.margin_bottom = Inches(0.02)
    lines = text if isinstance(text, list) else [text]
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        r = p.add_run(); r.text = line; r.font.size = Pt(size); r.font.bold = bold; r.font.color.rgb = color; r.font.name = font
        p.space_after = Pt(4)
    return tb

def bullets(slide, x, y, w, h, items, size=16, color=DARK):
    tb = slide.shapes.add_textbox(x, y, w, h); tf = tb.text_frame; tf.word_wrap = True
    tf.margin_left = tf.margin_right = Inches(0.05)
    for i, it in enumerate(items):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        bold = False
        if isinstance(it, tuple): it, bold = it
        r = p.add_run(); r.text = ('• ' if not bold else '') + it; r.font.size = Pt(size); r.font.color.rgb = color; r.font.name = FONT; r.font.bold = bold
        p.space_after = Pt(6)
    return tb

def rect(slide, x, y, w, h, fill=LIGHT, line=None, radius=True):
    s = slide.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE, x, y, w, h)
    s.fill.solid(); s.fill.fore_color.rgb = fill
    if line is None: s.line.fill.background()
    else: s.line.color.rgb = line
    if radius: s.adjustments[0] = 0.08
    s.shadow.inherit = False
    return s

def header(slide, title, subtitle=None, n=None):
    rect(slide, 0, 0, W, Inches(0.12), fill=BLUE, radius=False)
    txt(slide, Inches(0.6), Inches(0.35), Inches(11.5), Inches(0.8), title, size=30, bold=True)
    if subtitle: txt(slide, Inches(0.6), Inches(1.05), Inches(11.8), Inches(0.5), subtitle, size=15, color=MUTED)
    txt(slide, Inches(0.6), H - Inches(0.5), Inches(8), Inches(0.35), 'Ставка · unecon.tech · Хакатон MAX 2026 · трек «Эффективный бизнес»', size=10, color=MUTED)
    if n is not None: txt(slide, W - Inches(1.2), H - Inches(0.5), Inches(0.6), Inches(0.35), str(n), size=10, color=MUTED, align=PP_ALIGN.RIGHT)

def tile(slide, x, y, w, h, label, value, fill=LIGHT, vcolor=DARK):
    rect(slide, x, y, w, h, fill=fill)
    txt(slide, x + Inches(0.15), y + Inches(0.1), w - Inches(0.3), Inches(0.4), label, size=11, color=MUTED)
    txt(slide, x + Inches(0.15), y + Inches(0.45), w - Inches(0.3), h - Inches(0.5), value, size=22, bold=True, color=vcolor)

def pic(slide, path, x, y, w=None, h=None):
    p = SHOTS / path
    if not p.exists(): rect(slide, x, y, w or Inches(3), h or Inches(5), fill=LIGHT); txt(slide, x, y + Inches(1), w or Inches(3), Inches(1), f'[скриншот {path}]', size=12, color=MUTED, align=PP_ALIGN.CENTER); return
    if w and h: return slide.shapes.add_picture(str(p), x, y, width=w, height=h)
    if w: return slide.shapes.add_picture(str(p), x, y, width=w)
    return slide.shapes.add_picture(str(p), x, y, height=h)

def crop_top(shape, ratio):
    """Обрезать картинку снизу, оставив верхнюю долю ratio (0..1)."""
    shape.crop_bottom = 1 - ratio
    shape.height = int(shape.height * ratio)

n = 0
# 1. Служебный слайд
s = prs.slides.add_slide(BLANK); n += 1
header(s, 'Техническая информация для проверки', 'Служебный слайд, не оценивается: ссылки, репозиторий, переменные окружения, порядок проверки.', n)
rows = [
    ('Работающее решение в MAX', 'Бот: https://max.ru/t796_hakaton_max_bot  ·  Мини-приложение: ' + args.app_url + '  ·  Состояние: https://stavka.i-tech.unecon.ru/api/health'),
    ('Git-репозиторий и commit hash', f'{args.repo}  ·  commit {args.commit}'),
    ('Собственный API', 'Не заявляется (внутренний HTTP между мини-приложением и сервером; DATA-API.yaml не требуется)'),
    ('Тестовые логины и пароли', 'Не требуются: сценарий доступен любому пользователю MAX. Демо-ИНН: 7801633015 (ООО «Малый 43», СПб), 1601000159 (Агрызское райпо, Татарстан)'),
    ('Переменные окружения для запуска', 'MAX_BOT_TOKEN=' + secrets.get('MAX_BOT_TOKEN', '<токен команды — передаётся через официальный канал сдачи>') + '\nMAX_WEBHOOK_SECRET=' + secrets.get('MAX_WEBHOOK_SECRET', '<секрет вебхука>') + '\nMAX_UPDATES_MODE=none|polling|webhook  ·  PUBLIC_URL=https://…  ·  PORT=8080  ·  DATA_DIR=/data'),
    ('Локальный запуск', 'cp .env.example .env && docker compose up --build  →  http://localhost:8080/app/  (сборка ≈ 1 мин)'),
    ('Порядок прохождения сценария', '1) «Начать» → 2) «Ввести ИНН» → 7801633015 → 3) «Верно, дальше» → «Повар» → 45000 → карточка → 4) «PDF-отчёт» → 5) «Открыть радар» → «Отправить PDF-отчёт в чат» → «Поделиться отчётом в MAX» → 6) «Следить за рынком» → 7) «Текст вакансии». Подробно — README §12'),
]
y = Inches(1.6)
for label, value in rows:
    txt(s, Inches(0.6), y, Inches(3.2), Inches(0.9), label, size=12, bold=True, color=BLUE)
    txt(s, Inches(3.8), y, Inches(9.0), Inches(0.9), value.split('\n'), size=11)
    y += Inches(0.78)

# 2. Титул
s = prs.slides.add_slide(BLANK); n += 1
rect(s, 0, 0, W, H, fill=BLUE, radius=False)
txt(s, Inches(0.8), Inches(1.6), Inches(11), Inches(1.2), 'Ставка', size=66, bold=True, color=WHITE)
txt(s, Inches(0.8), Inches(2.9), Inches(11), Inches(1.0), 'Зарплатный радар для малого бизнеса в MAX', size=30, color=WHITE)
txt(s, Inches(0.8), Inches(3.8), Inches(11), Inches(1.4), ['Чат-бот + мини-приложение: сколько платят конкуренты вашего размера, где ваша ставка на шкале рынка и что написать в вакансии.', 'Только официальные живые данные: реестр МСП ФНС и портал «Работа России».'], size=17, color=WHITE)
txt(s, Inches(0.8), Inches(5.5), Inches(11.5), Inches(1.5), ['Команда unecon.tech (СПбГЭУ): Черевко Валерий — капитан, архитектура и бэкенд · Бережных Михаил — фронтенд и дизайн · Частикова Анастасия — продукт и исследование · Шакирьянова Суфия — UX/UI и презентация', 'Хакатон MAX 2026 · трек «Эффективный бизнес» · https://max.ru/t796_hakaton_max_bot'], size=13, color=WHITE)

# 3. Executive summary
s = prs.slides.add_slide(BLANK); n += 1
header(s, 'Executive summary', 'Одна боль, один сценарий, два настоящих госисточника, детерминированное ядро', n)
bullets(s, Inches(0.6), Inches(1.6), Inches(6.6), Inches(5), [
    'Владелец кафе или магазина вводит ИНН, должность и ставку — и за 30 секунд видит рынок труда своего региона по официальным вакансиям.',
    'Уникальное: сравнение с работодателями своего размера (микро/малое/среднее по реестру МСП), а не с сетями и бюджетом.',
    'Результат: перцентиль ставки, медиана и вилка, варианты ставки, частые требования, PDF-отчёт, пересылка отчёта коллеге в MAX, подписка на сдвиг рынка, черновик вакансии.',
    'Без модельных данных и без генеративных моделей: каждое число выводимо из источника, на карточке — бейдж «источник · дата».',
    'Масштабирование — пакетами контекста (YAML): новый регион = 0 строк кода, новая отрасль = один файл.',
], size=15)
tile(s, Inches(7.6), Inches(1.6), Inches(2.6), Inches(1.3), 'Повар, Санкт-Петербург: медиана', '65 000 ₽')
tile(s, Inches(10.4), Inches(1.6), Inches(2.6), Inches(1.3), 'у микропредприятий', '80 000 ₽')
tile(s, Inches(7.6), Inches(3.1), Inches(2.6), Inches(1.3), 'ставка 45 000 ₽ =', '22-й перцентиль', vcolor=ORANGE)
tile(s, Inches(10.4), Inches(3.1), Inches(2.6), Inches(1.3), 'выборка', '258 вак. / 234 раб.')
tile(s, Inches(7.6), Inches(4.6), Inches(5.4), Inches(1.3), 'Живая демонстрация 23.09.2026, источник «Работа России» + реестр МСП ФНС', 'бот · мини-приложение · PDF · shareMaxContent', fill=LIGHT, vcolor=BLUE)

# 4. Аудитория
s = prs.slides.add_slide(BLANK); n += 1
header(s, 'Целевая аудитория и приоритетный сегмент', 'Три оси сегментации: отрасль, масштаб, ситуация', n)
bullets(s, Inches(0.6), Inches(1.6), Inches(6.8), Inches(5), [
    ('Кто', True), 'Владелец или управляющий 1–5 точек общепита, розницы, бытовых услуг, который нанимает линейный персонал сам — HR-отдела нет.',
    ('Ситуация', True), 'Уволился повар / продавец / пекарь — смена под угрозой, вакансию нужно закрыть за 1–2 недели, а ставку назначить прямо сейчас.',
    ('Почему именно они', True), 'Сети и бюджет имеют HR-аналитику и тарифные сетки; микробизнес назначает ставку «по ощущениям» и проигрывает конкуренцию за людей.',
    ('Первый пилот', True), 'Общепит Санкт-Петербурга и розница Татарстана — два готовых пакета контекста; универсальный пакет покрывает все 91 регион.',
], size=15)
tile(s, Inches(7.8), Inches(1.6), Inches(2.5), Inches(1.3), 'субъектов МСП (реестр ФНС, 10.09.2026)', '6,77 млн')
tile(s, Inches(10.5), Inches(1.6), Inches(2.5), Inches(1.3), 'из них микро', '96 %')
tile(s, Inches(7.8), Inches(3.1), Inches(2.5), Inches(1.3), 'работников в МСП', '15,1 млн')
tile(s, Inches(10.5), Inches(3.1), Inches(2.5), Inches(1.3), 'заявленная потребность в работниках (Росстат, май 2026)', '1,8 млн')
tile(s, Inches(7.8), Inches(4.6), Inches(5.2), Inches(1.3), 'индекс RSBI «Кадры», май 2026 (минимум за 6 лет); обеспеченность кадрами по ЦБ −19,7 п.', '44,2', vcolor=ORANGE)

# 5. Проблема
s = prs.slides.add_slide(BLANK); n += 1
header(s, 'Проблема и её актуальность', 'Формула кейса: пользователь · контекст · результат · барьер · последствие', n)
rect(s, Inches(0.6), Inches(1.6), Inches(12.1), Inches(1.5), fill=LIGHT)
txt(s, Inches(0.8), Inches(1.7), Inches(11.8), Inches(1.4), 'Владелец кафе на две точки, когда у него уволился повар и смена под угрозой, хочет понять, за какие деньги он реально наймёт замену в своём городе за две недели, но видит только разрозненные объявления и не знает рынок целиком — из-за чего ставит нерыночную ставку, месяц стоит в недокомплекте и теряет выручку смен.', size=15)
txt(s, Inches(0.6), Inches(3.3), Inches(5.8), Inches(0.4), 'Как сейчас (As Is)', size=16, bold=True, color=BLUE)
bullets(s, Inches(0.6), Inches(3.7), Inches(5.8), Inches(3), ['8–12 вкладок job-бордов, 30–40 минут ручного просмотра', 'сравнение с сетями и бюджетом, а не с похожими заведениями', 'нет распределения — только «примерно столько»', 'ставку назначают по ощущениям; ошибка видна только через месяц простоя'], size=14)
txt(s, Inches(6.9), Inches(3.3), Inches(5.8), Inches(0.4), 'Со «Ставкой» (To Be)', size=16, bold=True, color=GREEN)
bullets(s, Inches(6.9), Inches(3.7), Inches(5.8), Inches(3), ['ИНН + должность + ставка → карточка за 30 секунд в чате', 'срез «работодатели вашего размера» из реестра МСП', 'перцентиль, медиана, вилка, гистограмма, типичные вакансии', 'варианты ставки, PDF партнёру, подписка на сдвиг рынка'], size=14)
txt(s, Inches(0.6), Inches(6.2), Inches(12), Inches(0.6), 'Подтверждение данными: цена ошибки видна в самих данных — ставка 45 000 ₽ повару в Петербурге ниже 75 % вакансий; у микропредприятий медиана 80 000 ₽ против 46 000 ₽ у бюджетных организаций (выборка 23.09.2026).', size=12, color=MUTED)

# 6. Сценарий
s = prs.slides.add_slide(BLANK); n += 1
header(s, 'Решение и основной пользовательский сценарий', 'Чат-бот ведёт короткий диалог, мини-приложение показывает радар рынка', n)
steps = ['1. «Начать» в боте @t796_hakaton_max_bot', '2. ИНН → профиль из реестра МСП (категория, ОКВЭД, регион) → пакет контекста', '3. Должность кнопкой или текстом', '4. Ставка в месяц до НДФЛ (или «нет»)', '5. Карточка рынка в чате: перцентиль, медиана, «такие же, как вы», требования, выборка и источник', '6. Кнопки: «Открыть радар» · варианты ставки (голосование) · PDF-отчёт · Следить за рынком · Текст вакансии', '7. Мини-приложение: шкала, гистограмма, категории работодателей, типичные вакансии → «Отправить PDF в чат» → «Поделиться в MAX»']
bullets(s, Inches(0.6), Inches(1.6), Inches(6.2), Inches(5.3), steps, size=13)
p1 = pic(s, 'app-02-card-top.png', Inches(7.1), Inches(1.5), h=Inches(5.3))
p2 = pic(s, 'app-04-profile.png', Inches(9.9), Inches(1.5), w=Inches(2.6))
if p2 is not None and p2.height > Inches(5.3): crop_top(p2, float(Inches(5.3)) / float(p2.height))
txt(s, Inches(0.6), Inches(6.55), Inches(6.2), Inches(0.4), 'Скриншоты мини-приложения (iPhone 14, демо-режим); бот проверен в web.max.ru.', size=10, color=MUTED)

# 7. Эффект
s = prs.slides.add_slide(BLANK); n += 1
header(s, 'Ожидаемый эффект и как его проверить', 'Гипотеза: если помочь владельцу назначить ставку по данным, вакансия закроется быстрее, потому что 75 % «долгих» вакансий стоят ниже медианы', n)
tile(s, Inches(0.6), Inches(1.7), Inches(3.9), Inches(1.4), 'время принятия решения о ставке', '40 мин → 1 мин')
tile(s, Inches(4.7), Inches(1.7), Inches(3.9), Inches(1.4), 'ручных действий', '8–12 вкладок → 3 поля')
tile(s, Inches(8.8), Inches(1.7), Inches(3.9), Inches(1.4), 'что измеряем в пилоте', 'срок закрытия вакансии')
bullets(s, Inches(0.6), Inches(3.4), Inches(12), Inches(3.5), [
    'Метрики пилота: доля вакансий с рыночной ставкой (≥ медианы); срок закрытия вакансии (дней); число повторных обращений; доля завершивших сценарий; «метрика честности» — доля карточек в состоянии «данных мало».',
    'Проверяемость уже заложена: сервер ежедневно фиксирует появление и исчезновение вакансий в выдаче — блок «как закрываются вакансии выше и ниже медианы» появляется после трёх дней наблюдений.',
    'Ожидаемая динамика: рост доли вакансий с рыночной ставкой на 20–30 п.п. у пользователей за квартал (гипотеза, проверяется в пилоте).',
], size=14)

# 8. Архитектура
s = prs.slides.add_slide(BLANK); n += 1
header(s, 'Архитектура решения', 'Один сервис, одна база, один контейнер — масштаб MVP без лишних слоёв', n)
boxes = [('MAX (мобильный и веб)', 'чат с ботом · мини-приложение (MAX Bridge)'), ('Вебхук HTTPS:443', 'секрет X-Max-Bot-Api-Secret, ответ 200 сразу, идемпотентность'), ('Сценарий бота / API', 'состояние в БД, HMAC-проверка initData, сессии'), ('Сервис рынка', 'кэш → «Работа России» (6 страниц параллельно) → реестр МСП (обогащение ИНН)'), ('Ядро (core)', 'нормализация · дедупликация · перцентили · вердикт · черновик'), ('Результат', 'карточка в чат · JSON мини-приложению · PDF → uploads → mid → shareMaxContent')]
x = Inches(0.6)
for i, (t, d) in enumerate(boxes):
    rect(s, x, Inches(1.7), Inches(2.0), Inches(2.2), fill=LIGHT if i % 2 == 0 else WHITE, line=BLUE)
    txt(s, x + Inches(0.1), Inches(1.8), Inches(1.8), Inches(0.7), t, size=12, bold=True, color=BLUE)
    txt(s, x + Inches(0.1), Inches(2.5), Inches(1.8), Inches(1.4), d, size=10)
    x += Inches(2.05)
bullets(s, Inches(0.6), Inches(4.2), Inches(12.2), Inches(2.8), [
    'Стек: Node 24 + TypeScript, Fastify, SQLite (node:sqlite), @maxhub/max-bot-api 0.3.1, React 19 + @maxhub/max-ui 0.5.0, pdfkit. Docker: один образ, docker compose up --build, сборка ≈ 1 мин.',
    'Надёжность: сторож вебхука (MAX отписывает бота через 8 ч без 200), таймауты и повторы к источникам, лечение невалидного JSON, кэш при недоступности, «Повторить» без перезапуска сценария.',
    'Безопасность: токен и секрет только в .env на сервере; initData по официальному HMAC-алгоритму (ключ WebAppData, окно 1 час); UUID v4 для карточек; персональные данные не логируются; lock-файл, закреплённый базовый образ, сертификат Минцифры в образе.',
    'Ядро не импортирует ни MAX, ни источники, ни пакеты — 28 автотестов на реальной выборке из 100 вакансий.',
], size=13)

# 9. Данные и интеграции
s = prs.slides.add_slide(BLANK); n += 1
header(s, 'Используемые данные и интеграции', 'Обе интеграции — настоящие, из списка источников кейса; модельных данных нет', n)
rows = [('Источник', 'Что берём', 'Как', 'Подводные камни, которые обработаны'),
        ('«Работа России», Open API v1 (Роструд)', 'живые вакансии: зарплата, ИНН работодателя, требования, график, адреса', 'без авторизации; страницы по 100; до 2000 записей на запрос; кэш 6 ч; ежедневные снимки', 'offset — номер страницы; потолок 10 000; неизвестные параметры молча игнорируются; 88 % дублей от сетей; невалидные escape в JSON'),
        ('Единый реестр субъектов МСП (ФНС)', 'профиль бизнеса по ИНН и категория каждого работодателя выборки', 'search-proc.json?query=ИНН; кэш 30 дней; до 60 ИНН на карточку', 'пустой ответ = не МСП (бюджет/крупный) — не ошибка; ИП = ПДн: храним только ИНН'),
        ('MAX Bot API + Bridge', 'события, сообщения, кнопки, загрузка PDF, initData, shareMaxContent', 'platform-api2.max.ru, сертификат Минцифры, лимиты 30 rps / 2 сообщения в чат в секунду', 'GET /chats удалён; в вебе нет DeviceStorage — состояние на сервере')]
y = Inches(1.6)
widths = [Inches(2.6), Inches(3.0), Inches(3.2), Inches(3.4)]
for ri, row in enumerate(rows):
    x = Inches(0.6)
    for ci, cell in enumerate(row):
        rect(s, x, y, widths[ci] - Inches(0.05), Inches(1.15) if ri else Inches(0.45), fill=BLUE if ri == 0 else (LIGHT if ri % 2 else WHITE), radius=False)
        txt(s, x + Inches(0.05), y + Inches(0.05), widths[ci] - Inches(0.15), Inches(1.1), cell, size=11 if ri else 12, bold=(ri == 0), color=WHITE if ri == 0 else DARK)
        x += widths[ci]
    y += Inches(1.15) if ri else Inches(0.45)
txt(s, Inches(0.6), Inches(5.6), Inches(12.1), Inches(1.2), ['Факт / расчёт / рекомендация разделены на каждом экране и в PDF: факты — заявленные в вакансиях ставки; расчёт — середина вилки, дедупликация, квантили (тип 7), перцентиль = доля ниже; рекомендация — варианты «медиана» и «верхняя четверть». На карточке всегда бейдж «источник · получено ДД.ММ ЧЧ:ММ» и размер выборки.'], size=12, color=MUTED)

# 10. Бонус MAX
s = prs.slides.add_slide(BLANK); n += 1
header(s, 'Возможности MAX сверх минимума', 'Бонус: сценарий доведён до результата и создаёт ценность — отчёт уходит партнёру, не покидая мессенджер', n)
bullets(s, Inches(0.6), Inches(1.6), Inches(7.0), Inches(5.2), [
    ('Пересылка отчёта внутри MAX (shareMaxContent по mid)', True), 'Мини-приложение просит сервер отправить PDF в диалог → бот загружает файл (POST /uploads) и отправляет сообщение (POST /messages) → сервер сохраняет mid → мини-приложение вызывает window.WebApp.shareMaxContent({ mid, chatType }) → пользователь выбирает чат совладельца или бухгалтера.',
    ('Диплинк с восстановлением состояния', True), 'https://max.ru/t796_hakaton_max_bot?startapp=card_<uuid> открывает ту же карточку у коллеги (initData.start_param); кнопка «Поделиться ссылкой».',
    ('Голосование по ставке в чате', True), 'inline-кнопки «оставить / медиана / топ-25 %» → POST /answers; счётчик голосов для решения вдвоём.',
    ('Подписка «Следить за рынком»', True), 'еженедельный пересчёт и сообщение при сдвиге медианы > 5 % — бот живёт после сценария.',
    ('Гигиена платформы', True), 'меню команд (PATCH /me/commands), индикатор набора текста, BackButton в мини-приложении, работа в мобильной и веб-версии.',
], size=13)
p = pic(s, 'app-02-card-full.png', Inches(8.0), Inches(1.5), w=Inches(2.6))
if p is not None: crop_top(p, 0.55)
p = pic(s, 'app-03-vacancy-text.png', Inches(10.8), Inches(1.5), w=Inches(2.3))
if p is not None and p.height > Inches(5.4): crop_top(p, float(Inches(5.4)) / float(p.height))

# 11. Масштабирование
s = prs.slides.add_slide(BLANK); n += 1
header(s, 'Потенциал масштабирования и условия адаптации', 'Ядро и переменная часть разделены физически: server/src/core не знает регионов, отраслей и профессий', n)
txt(s, Inches(0.6), Inches(1.6), Inches(5.9), Inches(0.4), 'Ядро (не меняется)', size=15, bold=True, color=BLUE)
bullets(s, Inches(0.6), Inches(2.0), Inches(5.9), Inches(2.4), ['модель данных, сценарий бота, экраны мини-приложения', 'нормализация, дедупликация, квантили, вердикт, черновик', 'драйверы источников с единым интерфейсом', 'архитектура: вебхук, кэш, PDF, безопасность'], size=13)
txt(s, Inches(6.9), Inches(1.6), Inches(5.9), Inches(0.4), 'Переменная часть (packs/*.yaml)', size=15, bold=True, color=GREEN)
bullets(s, Inches(6.9), Inches(2.0), Inches(5.9), Inches(2.4), ['регион (код ФНС) и отрасль (префиксы ОКВЭД)', 'профессии: запрос, синонимы, исключения', 'пороги достоверности, шаблон условий вакансии', 'словарь требований, демо-пример'], size=13)
rows = [('Контекст', 'Без изменений', 'Адаптируется', 'Трудоёмкость'), ('Любой из 91 региона', 'всё', 'ничего — универсальный пакет берёт регион из профиля', '0'), ('Новая отрасль (автосервис 45.20, салоны 96.02)', 'ядро, бот, приложение', 'один YAML: профессии, синонимы, условия', '≈ 1 час'), ('Второй источник вакансий (hh.ru по договору)', 'ядро, пакеты', 'драйвер в integrations/', '1–2 дня'), ('Сеть центров «Мой бизнес» / банк для МСП', 'всё', 'брендирование, канал входа', 'дни')]
y = Inches(4.5); widths = [Inches(3.6), Inches(2.4), Inches(4.2), Inches(1.9)]
for ri, row in enumerate(rows):
    x = Inches(0.6)
    for ci, cell in enumerate(row):
        rect(s, x, y, widths[ci] - Inches(0.05), Inches(0.42), fill=BLUE if ri == 0 else (LIGHT if ri % 2 else WHITE), radius=False)
        txt(s, x + Inches(0.05), y + Inches(0.04), widths[ci] - Inches(0.15), Inches(0.4), cell, size=10.5, bold=(ri == 0), color=WHITE if ri == 0 else DARK)
        x += widths[ci]
    y += Inches(0.42)
txt(s, Inches(0.6), Inches(6.55), Inches(12), Inches(0.5), 'Доказательство: два пакета уже работают на одном коде (Общепит · СПб и Розница · Татарстан); риски — смещение госпортала, доступность источников (кэш и деградация), актуальность словарей пакета (владелец контента).', size=11, color=MUTED)

# 12. Пилот
s = prs.slides.add_slide(BLANK); n += 1
header(s, 'Сценарий пилотного запуска и внедрения', 'Задел на очный этап: где, с кем и по каким метрикам', n)
bullets(s, Inches(0.6), Inches(1.6), Inches(12), Inches(5.2), [
    ('Где', True), 'Республика Татарстан (финал в Казани): розница и общепит — пакет уже готов; параллельно общепит Санкт-Петербурга.',
    ('Как встраивается', True), 'Ссылка на бота в рассылках центров «Мой бизнес» и канала МСП.РФ в MAX; бот в рабочем чате владельца и управляющего — решение о ставке принимается вдвоём.',
    ('Данные, интеграции, ресурсы', True), 'Два открытых источника уже подключены; один сервер; владелец контента пакетов — отраслевая ассоциация или центр «Мой бизнес»; юридическая проверка формулировок черновика вакансии.',
    ('Метрики пилота', True), '100 бизнесов × 3 месяца: доля вакансий с рыночной ставкой, срок закрытия, повторные обращения, доля «данных мало».',
    ('Следующий шаг', True), 'Второй источник вакансий и наблюдение за закрытием (уже копится) → «за сколько закрывается вакансия с такой ставкой».',
], size=14)

# 13. Ограничения
s = prs.slides.add_slide(BLANK); n += 1
header(s, 'Ограничения, риски и допущения', 'Разделяем факты, расчёты и гипотезы', n)
bullets(s, Inches(0.6), Inches(1.6), Inches(6.2), Inches(5.2), [('Ограничения', True), 'Заявленные в вакансиях ставки ≠ фактические выплаты; госпортал смещён к сетям и бюджету — поэтому срез по размеру работодателя и честный размер выборки.', 'Латентность источника 6–11 с на страницу: первая карточка до 40 с, далее из кэша.', 'Редкие профессии в малых регионах → состояние «данных мало» вместо красивой цифры.', 'Мини-приложение проверяется внутри MAX после привязки организаторами; до этого — демо-режим в браузере.'], size=13)
bullets(s, Inches(6.9), Inches(1.6), Inches(6.0), Inches(5.2), [('Сознательно не делаем (Won’t Have)', True), 'воронку кандидатов и отклики', 'парсинг коммерческих job-бордов без договора', 'генеративную модель в ядре (п. 9.5 правил)', 'расчёт ФОТ, налогов и бухгалтерию', ('Допущения', True), 'оклад в месяц до НДФЛ; единица ставки в вакансиях не всегда явно указана', 'обогащение до 60 работодателей на карточку'], size=13)

# 14. Источники
s = prs.slides.add_slide(BLANK); n += 1
header(s, 'Использованные источники', None, n)
bullets(s, Inches(0.6), Inches(1.4), Inches(12), Inches(5.6), [
    'Кейс трека «Эффективный бизнес» и Правила хакатона MAX 2026 (ред. 21.08.2026).',
    'Документация платформы MAX: dev.max.ru/docs, dev.max.ru/docs-api, dev.max.ru/docs/webapps/bridge, /validation, dev.max.ru/ui; репозитории max-messenger/max-bot-api-client-ts, max-ui.',
    'Портал «Работа России», Open API v1: opendata.trudvsem.ru/api/v1/vacancies; справочники regions.json, profession.json.',
    'Единый реестр субъектов МСП ФНС России: rmsp.nalog.ru (search-proc.json; статистика реестра на 10.09.2026).',
    'Росстат / Роструд — потребность в работниках 1,8 млн (май 2026); Банк России — мониторинг предприятий (обеспеченность работниками −19,7 п., 2 кв. 2026); индекс RSBI (ПСБ, «Опора России»), май 2026; hh.индекс, март 2026.',
    'Официальные сертификаты Минцифры России (gu-st.ru); шрифт PT Sans (ParaType, OFL).',
], size=13)

out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
pptx_path = out / f'{args.name}.pptx'
prs.save(pptx_path)
print('pptx:', pptx_path)
try:
    subprocess.run(["soffice", "--headless", "-env:UserInstallation=file:///tmp/lo-profile", "--convert-to", "pdf", "--outdir", str(out), str(pptx_path)], check=True, capture_output=True, timeout=180)
    print('pdf:', out / f'{args.name}.pdf')
except Exception as e:
    print('pdf conversion failed:', e, file=sys.stderr)
