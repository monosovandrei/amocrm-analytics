# Выкладка на сервер

## Что разворачиваем

Проект состоит из трех частей:

- PostgreSQL 16 - база со слепком amoCRM и настройками платформы.
- API - Node.js/NestJS процесс на порту `4000`.
- Web - собранный React/Vite интерфейс. В Docker он запускается как отдельный web-контейнер на порту `3000`; без Docker его можно отдавать через Nginx из `apps/web/dist`.

Рекомендуемый вариант для ИТ: Docker Compose + reverse proxy/VPN с TLS.

## Что нужно на сервере

- Node.js `>=20`, npm `>=10`, если запуск без Docker.
- Docker и Docker Compose, если запуск через контейнеры.
- PostgreSQL 16 или контейнер `postgres` из `docker/docker-compose.yml`.
- Исходящий HTTPS-доступ сервера к:
  - `*.amocrm.ru`
  - `www.amocrm.ru`
  - `api.telegram.org`, если включены Telegram-уведомления.

## Переменные окружения

Скопировать `.env.example` в `.env` и заполнить реальные значения на сервере.

Обязательные:

- `DATABASE_URL`
- `POSTGRES_PASSWORD`, если используется PostgreSQL из Docker Compose
- `JWT_SECRET`
- `CREDENTIALS_ENCRYPTION_KEY`
- `AMOCRM_CLIENT_ID`
- `AMOCRM_CLIENT_SECRET`
- `AMOCRM_REDIRECT_URI`
- `WEBHOOK_BASE_URL`
- `WEB_ORIGIN`
- `VITE_API_URL`
- `SEED_ADMIN_EMAIL`
- `SEED_ADMIN_PASSWORD`

Для Telegram:

- `TELEGRAM_BOT_TOKEN`

Для частоты фоновой синхронизации amoCRM:

- `AMOCRM_SYNC_INTERVAL_MINUTES=10`

Это не основной production-режим обновления данных. На production данные должны обновляться через amoCRM webhooks. Polling нужен только как страховка, если webhook не дошел.

Секреты не коммитить в Git. Реальный `.env` должен лежать только на сервере.

## Запуск через Docker Compose

```bash
docker compose -f docker/docker-compose.yml up -d --build
docker compose -f docker/docker-compose.yml exec api npm run db:seed
```

API-контейнер сам применяет миграции при старте:

```bash
npx prisma migrate deploy --schema prisma/schema.prisma
```

Проверка после запуска:

```bash
curl http://127.0.0.1:4000/api/v1/health
```

Ожидаемый ответ: HTTP `200`.

## Запуск без Docker

```bash
npm ci
npm run db:generate
npm run db:deploy
npm run db:seed
npm run build
npm run start --workspace=@amocrm-analytics/api
```

Web:

```bash
VITE_API_URL=https://YOUR_DOMAIN/api/v1 npm run build --workspace=@amocrm-analytics/web
```

После сборки отдавать папку:

```txt
apps/web/dist
```

через Nginx или другой внутренний web-сервер.

## Reverse proxy

Нужно опубликовать:

- Web: `/`
- API: `/api/v1`

API внутри сервера слушает `127.0.0.1:4000`.
Web в Docker слушает `127.0.0.1:3000`.

PostgreSQL наружу не публиковать.

## amoCRM

В amoCRM redirect URI должен совпадать с `AMOCRM_REDIRECT_URI`.

`WEBHOOK_BASE_URL` должен быть внешним API-адресом без слеша в конце, например:

```txt
https://analytics.company.ru/api/v1
```

Webhook URL сервис создаст сам после подключения amoCRM.

Для realtime-обновления ИТ должен обеспечить входящий HTTPS-доступ amoCRM к этому webhook URL. Когда в amoCRM происходит изменение, webhook дергает API, API сразу запускает `WEBHOOK`-синхронизацию и отчеты пересчитываются по свежему слепку.

`AMOCRM_SYNC_INTERVAL_MINUTES` оставлен только как fallback-проверка, чтобы поймать редкий пропущенный webhook. Для локальной разработки можно ставить `2`, для production рекомендуется `10` или больше.

## Проверки перед выкладкой

```bash
npm test
npm run typecheck
npm run build
npm run frontend:gate
npm audit --omit=dev
```

Если какая-то команда падает, выкладывать нельзя до исправления причины.

## Что отдать ИТ

- Ссылку на Git-репозиторий.
- Файл `.env.example`.
- Этот документ: `docs/DEPLOYMENT.md`.
- Реальные значения секретов через защищенный канал.
- Домен/адрес, на котором должен открываться интерфейс.
