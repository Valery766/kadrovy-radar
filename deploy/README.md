# Деплой

## Боевой стенд (без Docker)
Сервер: общий Ubuntu 24.04 с nginx; приложение слушает `127.0.0.1:8081`, наружу его отдаёт nginx по HTTPS (Let's Encrypt).

1. Один раз: `sudo cp deploy/stavka.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable stavka`
2. Секреты: `/srv/stavka/.env` (по образцу `.env.example`, `MAX_UPDATES_MODE=webhook`, `PUBLIC_URL=https://…`, `PORT=8081`, `DATA_DIR=/srv/stavka/data`).
3. Сайт nginx: `deploy/nginx.conf` → `/etc/nginx/sites-available/stavka`, `nginx -t`, `systemctl reload nginx`, сертификат `certbot --nginx -d <домен>`.
4. Каждый релиз: `deploy/deploy.sh` (сборка локально → rsync → переключение `current` → рестарт → проверка `/api/health`).

Откат: `ln -sfn /srv/stavka/releases/<прежний> /srv/stavka/current && sudo systemctl restart stavka`.

## Локально / у проверяющих
`docker compose up --build` — см. README в корне.
