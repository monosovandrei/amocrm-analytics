# Справка для ИТ и ИБ

## Назначение

`amoCRM Analytics` - внутренний сервис отчетности продаж для одной компании. Сервис подключается к amoCRM, синхронизирует CRM-данные в PostgreSQL и строит отчеты/дашборды для РОПа.

Сервис не использует LLM, AI-агентов, OpenAI, Anthropic, LangChain и аналогичные внешние AI-сервисы. Данные не отправляются во внешний AI-контур.

## Контур размещения

- Рекомендуемое размещение: внутренний сервер компании или закрытый VPN-контур.
- Публичный доступ к Web/API допустим только после отдельного security-аудита.
- PostgreSQL не должен быть доступен из интернета.
- В `docker/docker-compose.yml` PostgreSQL публикуется только на `127.0.0.1`.
- Backend выполняет исходящие HTTPS-запросы к amoCRM API и OAuth endpoints.
- Frontend обращается только к собственному API из `VITE_API_URL`.

## Секреты

Хранятся в `.env` на сервере и не передаются в Git:

- `DATABASE_URL`
- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `CREDENTIALS_ENCRYPTION_KEY`
- `AMOCRM_CLIENT_ID`
- `AMOCRM_CLIENT_SECRET`
- `SEED_ADMIN_PASSWORD`

Пример без реальных секретов: `.env.example`.

## amoCRM доступы

Для пилота рекомендуется режим только чтения. Минимально нужны права чтения:

- аккаунт;
- пользователи и группы;
- воронки, этапы, причины отказа;
- сделки/leads;
- контакты;
- компании;
- задачи;
- примечания;
- события;
- custom fields сделок, контактов и компаний.

Сервис не должен получать права записи в amoCRM на первом пилоте. Сервис не подключается к 1С и не влияет на существующую интеграцию amoCRM/1С.

## Данные в PostgreSQL

Сервис создает отдельную копию части данных amoCRM. Основные таблицы:

- `AmoConnection` - подключение amoCRM, subdomain, account id/name, webhook secret, OAuth tokens в зашифрованном виде.
- `CrmUser`, `CrmGroup` - пользователи и группы amoCRM.
- `Pipeline`, `PipelineStage`, `LossReason` - структура воронок.
- `CustomFieldDefinition` - metadata CRM-полей.
- `Deal`, `Contact`, `CrmCompany` - сделки, контакты, компании и custom fields.
- `DealStageHistory`, `DealResponsibleHistory` - история изменений для конверсий и SLA-аналитики.
- `Task`, `Note`, `CrmEvent`, `DealProduct` - дополнительные CRM-данные для отчетов.
- `ReportTemplate`, `DashboardLayout` - пользовательские настройки отчетов и рабочего стола.
- `ForecastSettings`, `StageProbability` - настройки прогноза.
- `WebhookEvent`, `SyncJob`, `AuditLog` - технические события, синхронизация и аудит.

## Защита данных

- OAuth-токены amoCRM шифруются AES-256-GCM перед записью в БД.
- `CREDENTIALS_ENCRYPTION_KEY` не хранится в БД и не должен попадать в Git.
- JWT secret обязателен через `ConfigService.getOrThrow`.
- API включает Helmet, CORS allowlist и DTO validation с запретом неизвестных полей.
- Webhook amoCRM защищен URL-secret: `/api/v1/webhooks/amocrm/{secret}`.
- Webhook дополнительно проверяет subdomain аккаунта amoCRM.
- `.env`, build artifacts, logs и `node_modules` исключены из Git.

## Исправления после первичной проверки

- Исправлен порядок guard-ов на admin routes: `JwtAuthGuard` выполняется перед `RolesGuard`.
- Включена защита от перебора пароля: endpoint `POST /api/v1/auth/login` ограничен 5 попытками в минуту.
- Добавлены миграции Prisma: `prisma/migrations/0001_init/migration.sql`.
- API-контейнер применяет миграции при старте через `prisma migrate deploy`.
- PostgreSQL, API и Web в Docker больше не публикуются наружу хоста, только `127.0.0.1`.
- Реализована запись `AuditLog` для auth/admin/amo/settings/reports действий.
- Реализован admin endpoint просмотра журнала: `GET /api/v1/audit/logs`.
- Добавлены regression tests для `RolesGuard` и audit-сценариев auth.
- README заменен на читаемую инструкцию запуска, эксплуатации и проверки.

## Audit log

В `AuditLog` фиксируются:

- успешный вход;
- неуспешный вход;
- создание пользователя администратором;
- подключение/обновление amoCRM;
- ручной запуск синхронизации;
- изменение forecast-настроек;
- изменение вероятностей этапов;
- изменение видимости менеджеров и групп.
- создание, изменение и удаление шаблонов отчетов;
- изменение раскладки рабочего стола.

Audit log не должен содержать пароли, OAuth-токены или значения секретов.

## Проверки

Команды:

```bash
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

Дополнительные проверки перед пилотом:

- убедиться, что `.env` не отслеживается Git;
- убедиться, что в репозитории нет токенов, паролей и реальных клиентских данных;
- проверить, что PostgreSQL недоступен из внешней сети;
- проверить, что amoCRM integration выдана только на чтение;
- запускать сервис только во внутреннем контуре.

## Остаточные ограничения

- Это прототип для ограниченного пилота, не промышленная SaaS-поставка.
- Перед внешней публикацией Web/API нужен отдельный security-аудит.
- Для промышленного запуска нужны централизованные backup/restore, мониторинг, управление доступами и регламент ротации секретов.
- `npm audit --omit=dev` должен показывать `found 0 vulnerabilities`.
