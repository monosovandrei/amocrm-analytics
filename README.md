# amoCRM Analytics

Сервис управленческой отчетности поверх amoCRM. amoCRM остается рабочей системой менеджеров, сервис забирает данные по API, сохраняет отдельную копию в PostgreSQL и строит отчеты для РОПа.

Проект не является AI-агентом и не управляет продажами автоматически. На этапе пилота интеграция должна работать только в режиме чтения amoCRM.

## Что делает сервис

- Подключает amoCRM через OAuth 2.0.
- Синхронизирует сделки, контакты, компании, пользователей, группы, этапы, задачи, события и примечания.
- Хранит данные в PostgreSQL внутри контура компании.
- Строит отчеты по сделкам, суммам, этапам, конверсиям и времени нахождения на этапах.
- Формирует прогноз выручки по воронке.
- Дает рабочий стол с виджетами.
- Экспортирует отчеты в Excel.

## Ограничения пилота

- Только внутренний сервер или закрытый VPN-доступ.
- PostgreSQL не должен быть доступен из интернета.
- amoCRM подключается с минимально нужными правами и только на чтение.
- Сервис не подключается к 1С и не влияет на существующую интеграцию amoCRM/1С.
- Публичная публикация веб-интерфейса без дополнительного аудита запрещена.
- Реальные `.env`, токены, пароли и клиентские данные нельзя коммитить в Git.

## Состав

- `apps/api` - NestJS API, auth, amoCRM OAuth/sync/webhooks, reports, forecast, Excel export.
- `apps/web` - Vite React интерфейс.
- `prisma/schema.prisma` - модель PostgreSQL.
- `prisma/migrations` - миграции базы данных.
- `docker/` - Docker-сборка API, Web и PostgreSQL.
- `docs/IT_REVIEW.md` - справка для ИТ/ИБ.
- `docs/DEPLOYMENT.md` - инструкция выкладки на сервер.
- `docs/RECHECK_REPORT.md` - отчет по закрытию замечаний перед повторной проверкой.
- `docs/TZ.md` - техническое задание.

## Требования

- Node.js `>=20`
- npm `>=10`
- PostgreSQL `16`
- Доступ сервера к amoCRM API по HTTPS
- HTTPS URL для webhook amoCRM, если используются webhooks

## Переменные окружения

Скопировать пример:

```bash
cp .env.example .env
```

Заполнить обязательные значения:

- `DATABASE_URL` - строка подключения к PostgreSQL.
- `JWT_SECRET` - секрет JWT, минимум 32 байта случайных данных.
- `CREDENTIALS_ENCRYPTION_KEY` - ключ AES-256-GCM для OAuth-токенов amoCRM, рекомендуется 64 hex-символа.
- `AMOCRM_CLIENT_ID` - ID private integration amoCRM.
- `AMOCRM_CLIENT_SECRET` - secret private integration amoCRM.
- `AMOCRM_REDIRECT_URI` - redirect URI из настроек amoCRM.
- `WEBHOOK_BASE_URL` - внешний API URL без завершающего slash, например `https://analytics.example.ru/api/v1`.
- `AMOCRM_SYNC_INTERVAL_MINUTES` - страховочный polling amoCRM в минутах; основной production-режим обновления идет через webhooks.
- `AMOCRM_SYNC_JOB_TIMEOUT_MINUTES` - через сколько минут обычная job без heartbeat считается зависшей; для production рекомендуется `30`.
- `AMOCRM_FULL_SYNC_JOB_TIMEOUT_MINUTES` - timeout полной исторической синхронизации; для production рекомендуется `360` или больше.
- `WEB_ORIGIN` - разрешенный origin фронтенда для CORS.
- `VITE_API_URL` - публичный URL API для web-приложения.
- `TELEGRAM_BOT_TOKEN` - токен Telegram-бота для уведомлений.
- `SEED_ADMIN_EMAIL` и `SEED_ADMIN_PASSWORD` - начальный администратор для `npm run db:seed`.

## Локальный запуск

```bash
npm install
cp .env.example .env
docker compose -f docker/docker-compose.yml up -d postgres
npm run db:generate
npm run db:migrate
npm run db:seed
npm test
npm run dev
```

Во втором терминале:

```bash
npm run dev:web
```

Адреса по умолчанию:

- Web: `http://localhost:3000`
- API: `http://localhost:4000/api/v1`
- Healthcheck: `http://localhost:4000/api/v1/health`

## Docker-запуск

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up -d --build
```

API-контейнер перед стартом выполняет:

```bash
prisma migrate deploy --schema prisma/schema.prisma
```

PostgreSQL в `docker/docker-compose.yml` публикуется только на `127.0.0.1:${POSTGRES_PORT:-5433}`. Для промышленного контура рекомендуется managed PostgreSQL или отдельный внутренний database-сервер без внешней публикации порта.
API и Web в Docker Compose также привязаны к `127.0.0.1`; внешний доступ должен идти через контролируемый reverse proxy/VPN.

## Безопасность

- `.env` исключен из Git.
- JWT secret обязателен, fallback-секрета в коде нет.
- OAuth-токены amoCRM шифруются через AES-256-GCM перед записью в БД.
- API включает Helmet, CORS allowlist и ValidationPipe с whitelist.
- Login ограничен rate limit: 5 попыток в минуту на endpoint.
- Админские действия защищены `JwtAuthGuard` + `RolesGuard`.
- Админские и auth-события пишутся в `AuditLog`.
- Webhook amoCRM защищен URL-secret и проверкой subdomain аккаунта.

## Audit log

В `AuditLog` пишутся:

- успешные и неуспешные попытки входа;
- создание пользователей администратором;
- подключение/обновление amoCRM;
- ручной запуск синхронизации;
- изменение forecast-настроек;
- изменение вероятностей этапов;
- изменение видимости менеджеров и групп.
- создание, изменение и удаление шаблонов отчетов;
- изменение раскладки рабочего стола.

Просмотр журнала администратором:

```bash
GET /api/v1/audit/logs?limit=100
```

## Проверка перед передачей ИТ/ИБ

```bash
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

Дополнительно проверить:

- в Git нет `.env`, токенов, паролей и реальных клиентских данных;
- PostgreSQL не доступен снаружи;
- amoCRM integration имеет минимально нужные read-only права;
- сервис запускается во внутреннем контуре;
- 1С не подключена к сервису;
- публичный доступ к Web/API закрыт до отдельного security-аудита.

## Тесты

`npm test` запускает Jest-регрессию backend. Покрыты:

- расчет отчетов;
- исключение sync-артефактов `fromStageId === toStageId`;
- role guard для admin routes;
- audit log для входа и создания пользователей.
