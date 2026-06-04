# amoCRM Analytics

Мини-проект для аналитики amoCRM в контуре одной компании. Проект забирает данные из amoCRM, сохраняет их в PostgreSQL и позволяет РОПу собирать отчёты через конструктор контрактов данных: количество сделок, переходы по этапам, условия по CRM-полям, суммы/средние по полям, конверсии между показателями, среднее время в этапах и прогноз по воронке.

Проект выделен из PulseBoard и намеренно не содержит billing, телефонию, мессенджеры, AI scoring, multi-tenant и no-CRM режим.

## Состав

- `apps/api` — NestJS API, amoCRM OAuth, sync, webhooks, отчёты, forecast, Excel export.
- `apps/web` — Next.js интерфейс: подключение amoCRM, конструктор отчётов, рабочий стол РОПа, настройки.
- `prisma/schema.prisma` — PostgreSQL-модель данных.
- `docker/` — Dockerfile и compose для локального/серверного запуска.
- `docs/IT_REVIEW.md` — краткая справка для ИТ/СБ по доступам, данным и интеграции.

## Основные возможности

- Подключение amoCRM через OAuth 2.0.
- Полная первичная синхронизация и последующая incremental-синхронизация.
- Приём amoCRM webhooks по URL с секретом.
- Роли `ADMIN` и `ROP`.
- Конструктор отчётов по текущему состоянию сделок и событиям переходов.
- Настраиваемый рабочий стол РОПа с закреплёнными виджетами.
- Forecast: закрывающий этап, отгрузочная воронка, плечо отгрузки, weighted pipeline.
- Экспорт отчётов в Excel.

## Требования

- Node.js `>=20`
- npm `>=10`
- PostgreSQL `16`
- Доступ сервера к amoCRM API по HTTPS
- Внешний HTTPS URL для webhook amoCRM

## Зависимости

Основные backend-зависимости:

- NestJS 11
- Prisma 5
- PostgreSQL
- Passport/JWT
- bcryptjs
- helmet
- class-validator/class-transformer
- exceljs

Основные frontend-зависимости:

- Next.js 16
- React 18
- Tailwind CSS
- lucide-react
- recharts

Полный воспроизводимый список версий зафиксирован в `package-lock.json`.

## Настройки

Скопировать пример:

```bash
cp .env.example .env
```

Заполнить значения в `.env`. В репозиторий нельзя коммитить реальные токены, пароли, OAuth secret, JWT secret и ключ шифрования.

Ключевые переменные:

- `DATABASE_URL` — строка подключения к PostgreSQL.
- `JWT_SECRET` — секрет подписи JWT, минимум 32 байта случайных данных.
- `CREDENTIALS_ENCRYPTION_KEY` — ключ шифрования OAuth-токенов amoCRM. Рекомендуется 64 hex-символа.
- `AMOCRM_CLIENT_ID` — ID private integration amoCRM.
- `AMOCRM_CLIENT_SECRET` — secret private integration amoCRM.
- `AMOCRM_REDIRECT_URI` — redirect URI, зарегистрированный в amoCRM.
- `WEBHOOK_BASE_URL` — внешний API URL без хвостового slash, например `https://analytics.example.ru/api/v1`.
- `WEB_ORIGIN` — разрешённый origin фронтенда для CORS.
- `NEXT_PUBLIC_API_URL` — публичный URL API для web-приложения.

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

Тестовый пользователь создаётся через `npm run db:seed`. Значения задаются переменными `SEED_ADMIN_EMAIL` и `SEED_ADMIN_PASSWORD`.

## Docker запуск

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up -d --build
```

Перед запуском в серверном контуре заменить все `CHANGE_ME_*` значения в `.env`.
В `.env` `DATABASE_URL` может оставаться локальным (`localhost`) для запуска без Docker; `docker-compose.yml` переопределяет его внутри API-контейнера на host `postgres`.

## Подключение amoCRM

1. В amoCRM создать private integration.
2. Указать redirect URI из `AMOCRM_REDIRECT_URI`.
3. Выдать интеграции права на чтение сущностей, перечисленных ниже.
4. Заполнить `AMOCRM_CLIENT_ID` и `AMOCRM_CLIENT_SECRET`.
5. Запустить приложение и открыть раздел `amoCRM`.
6. Ввести домен аккаунта amoCRM.
7. Пройти OAuth авторизацию.
8. Скопировать webhook URL из интерфейса подключения и зарегистрировать его в amoCRM.
9. Запустить первичную синхронизацию.

Поддерживаются домены `*.amocrm.ru` и `*.amocrm.com`.

## Нужные права amoCRM

Минимально нужны права чтения:

- аккаунт;
- пользователи и группы;
- воронки, этапы, причины отказа;
- сделки/leads;
- контакты;
- компании;
- задачи;
- примечания;
- события;
- кастомные поля сделок, контактов и компаний.

Если amoCRM требует детализированные scopes, интеграции нужны scopes на чтение соответствующих сущностей и доступ к webhook-событиям по сделкам.

## Где хранятся данные

Все постоянные данные хранятся в PostgreSQL:

- `AmoConnection` — подключение amoCRM, subdomain, account id/name, webhook secret, зашифрованные OAuth tokens.
- `CrmUser`, `CrmGroup` — менеджеры и группы amoCRM, включая флаги видимости в сервисе.
- `Pipeline`, `PipelineStage`, `LossReason` — воронки, этапы и причины отказа.
- `CustomFieldDefinition` — metadata CRM-полей и enum-значений.
- `Deal`, `Contact`, `CrmCompany` — сделки, контакты, компании и их CRM-поля.
- `DealStageHistory`, `DealResponsibleHistory` — история переходов по этапам и ответственным.
- `Task`, `Note`, `CrmEvent`, `DealProduct` — задачи, примечания, события, товары.
- `ReportTemplate` — сохранённые настройки отчётов.
- `DashboardLayout` — расположение виджетов рабочего стола.
- `ForecastSettings`, `StageProbability` — настройки и вероятности forecast.
- `WebhookEvent`, `SyncJob`, `AuditLog` — технические события синхронизации и аудит.

OAuth-токены amoCRM хранятся только в зашифрованном виде через AES-256-GCM. Ключ шифрования берётся из `CREDENTIALS_ENCRYPTION_KEY` и не должен храниться в Git.

## Проверка перед передачей

```bash
npm test
npm run typecheck
npm run build
```

Дополнительно:

```bash
npm audit
```

На момент подготовки проекта `npm audit --omit=dev` показывает 4 moderate, 0 high, 0 critical. Детали и рекомендации: `docs/IT_REVIEW.md`.

## Автотесты

`npm test` запускает Jest-регрессию backend-расчётов конструктора отчётов. Покрыты сценарии:

- количество сделок за период;
- переходы в этапы с фильтром `откуда -> куда`;
- исключение sync-артефактов `fromStageId === toStageId`;
- текущее состояние сделки в этапе;
- условия по CRM-полям;
- сумма и среднее по выбранному полю;
- конверсия между показателями;
- среднее время нахождения в этапе.

## Безопасность

- Реальные `.env` файлы исключены из Git.
- JWT secret обязателен, fallback-секрета в коде нет.
- OAuth credentials amoCRM шифруются перед записью в БД.
- Webhook amoCRM защищён URL-secret и проверкой subdomain аккаунта.
- API включает Helmet, CORS allowlist и validation pipe с `whitelist`.
- Проект рассчитан на размещение внутри инфраструктуры одной компании.
