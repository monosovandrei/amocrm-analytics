# Справка для ИТ и СБ

## Назначение

`amoCRM Analytics` — внутренний сервис аналитики продаж для одной компании. Сервис подключается к amoCRM, синхронизирует CRM-данные в PostgreSQL и строит отчёты/дашборды для РОПа.

## Контур размещения

- Размещение: собственные серверы компании.
- Публичный доступ нужен только к web-интерфейсу и API endpoint webhook amoCRM.
- Хранилище: PostgreSQL 16.
- Внешние сетевые обращения backend: HTTPS к amoCRM API и OAuth endpoints.
- Frontend обращается только к API сервиса из `NEXT_PUBLIC_API_URL`.

## Требуемые секреты

Хранятся в `.env` на сервере, в Git не передаются:

- `DATABASE_URL`
- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `CREDENTIALS_ENCRYPTION_KEY`
- `AMOCRM_CLIENT_ID`
- `AMOCRM_CLIENT_SECRET`
- `SEED_ADMIN_PASSWORD`

Пример без реальных секретов: `.env.example`.

## amoCRM доступы

Нужны права чтения:

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

Webhook нужен для событий по сделкам и связанным сущностям, чтобы поддерживать near real-time обновление отчётов.

## Где сохраняются данные

Все данные сохраняются в PostgreSQL. Основные таблицы:

- `AmoConnection` — подключение amoCRM, subdomain, account id/name, webhook secret, OAuth tokens в зашифрованном виде.
- `CrmUser`, `CrmGroup` — пользователи и группы amoCRM, плюс флаги видимости в сервисе.
- `Pipeline`, `PipelineStage`, `LossReason` — структура воронок.
- `CustomFieldDefinition` — metadata CRM-полей.
- `Deal`, `Contact`, `CrmCompany` — CRM-сущности и их custom fields.
- `DealStageHistory`, `DealResponsibleHistory` — история изменений для конверсий и SLA-аналитики.
- `Task`, `Note`, `CrmEvent`, `DealProduct` — дополнительные CRM-данные для отчётов.
- `ReportTemplate` — сохранённые контракты отчётов.
- `DashboardLayout` — расположение виджетов рабочего стола РОПа.
- `ForecastSettings`, `StageProbability` — настройки прогноза.
- `WebhookEvent`, `SyncJob`, `AuditLog` — технический журнал.

## Защита данных

- OAuth tokens amoCRM шифруются AES-256-GCM перед записью в БД.
- `CREDENTIALS_ENCRYPTION_KEY` не хранится в БД и не должен попадать в Git.
- JWT secret обязателен через `ConfigService.getOrThrow`.
- Webhook URL содержит случайный secret: `/api/v1/webhooks/amocrm/{secret}`.
- Webhook дополнительно проверяет subdomain аккаунта amoCRM.
- API включает Helmet, CORS allowlist и DTO validation с запретом неизвестных полей.
- `.env`, build artifacts, logs и `node_modules` исключены из Git/Docker context.

## Регрессионная защита расчётов

Команда:

```bash
npm test
```

Проверяет backend-логику конструктора отчётов через `ReportsService` и in-memory Prisma mock. Покрытые сценарии:

- сделки, созданные в периоде;
- переходы по этапам `откуда -> куда`;
- исключение sync-артефактов `fromStageId === toStageId`;
- текущее состояние в этапе;
- условия по CRM-полям;
- сумма и среднее по выбранному CRM-полю;
- конверсия между двумя показателями;
- среднее время нахождения сделки в этапе;
- фильтрация по менеджеру.

Это закрывает основной регрессионный риск: случайная поломка расчётов конструктора при будущих доработках.

## Остаточный npm audit

После обновления зависимостей и удаления `xlsx`:

- `npm audit --omit=dev` показывает 4 moderate, 0 high, 0 critical.
- Источники:
  - `next -> postcss` advisory. npm предлагает `next@9.3.3`, что является некорректным downgrade для проекта на App Router.
  - `exceljs -> uuid` advisory. Проект использует `exceljs` только для генерации `.xlsx` из внутренних данных, не для парсинга загруженных пользователем файлов.

Рекомендация: принять как остаточный риск для внутреннего контура либо заменить Excel export на CSV/серверный writer без внешней библиотеки, если СБ требует нулевой audit.

## Production рекомендации

- Запускать только за HTTPS reverse proxy.
- Ограничить доступ к API и web по корпоративным сетям/VPN, если возможно.
- Не использовать demo/seed пароль в production.
- Ротировать `JWT_SECRET` и `CREDENTIALS_ENCRYPTION_KEY` только по процедуре, учитывая, что смена ключа шифрования потребует переподключения amoCRM или миграции credentials.
- Делать регулярный backup PostgreSQL.
- Логи webhook/sync не должны выгружаться во внешние системы без маскирования payload.
