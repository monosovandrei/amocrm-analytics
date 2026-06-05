# Отчет готовности к повторной проверке

## Статус

Проект подготовлен к повторной технической проверке для запуска во внутреннем production-контуре компании.

## Закрытые замечания ИТ

| Замечание | Статус | Что сделано |
| --- | --- | --- |
| Административная часть может получать отказ в доступе | Закрыто | Admin routes используют порядок `JwtAuthGuard` -> `RolesGuard`; добавлены regression tests. |
| Нет миграций БД | Закрыто | Добавлена `prisma/migrations/0001_init/migration.sql`; API Docker image выполняет `prisma migrate deploy` при старте. |
| Нет защиты от перебора пароля | Закрыто | `POST /api/v1/auth/login` ограничен 5 попытками в минуту; глобальный лимит API 100 req/min. |
| Журнал действий заявлен, но не реализован | Закрыто | Реализован `AuditLog`, запись auth/admin/amo/settings/reports событий и admin endpoint `GET /api/v1/audit/logs`. |
| PostgreSQL публикуется наружу | Закрыто | Postgres/API/Web в compose привязаны к `127.0.0.1`; внешний доступ предполагается только через контролируемый reverse proxy/VPN. |
| Секреты и реальные данные в репозитории | Закрыто | `.env` исключен из Git; выполнен secret scan; реальных токенов/паролей не найдено. |
| Нет инструкции развертывания | Закрыто | Обновлены `README.md` и `docs/IT_REVIEW.md`. |
| Слабая сопровождаемость frontend | Улучшено | Убран Next.js, фронт переведен на Vite; типы и pure helper-логика вынесены из основного UI-файла. |
| Недостаточные тесты критичных сценариев | Улучшено | Добавлены тесты auth audit, role guard, report template audit; сохранены тесты расчетов отчетов. |
| npm audit warnings | Закрыто | `npm audit --omit=dev` показывает `found 0 vulnerabilities`; уязвимые транзитивные зависимости удалены. |

## Проверки

Выполнены команды:

```bash
npm audit --omit=dev
npm test --workspace=@amocrm-analytics/api -- --runInBand
npm run typecheck
npm run build
```

Ожидаемый результат:

- audit: `found 0 vulnerabilities`
- tests: 5 Jest suites / 11 tests passed
- typecheck: API и Web без TypeScript errors
- build: API и Web собираются успешно
- Docker compose config и clean smoke: published ports только `127.0.0.1`; `docker compose build api` успешен; `docker compose up -d` на новой PostgreSQL volume применяет миграции; API health возвращает `200`; Web возвращает `200`.

## Production-условия запуска

- Развертывание только во внутреннем контуре компании или через VPN.
- amoCRM integration на первом этапе только с read-only правами.
- Сервис не подключается к 1С и не влияет на текущую связку amoCRM/1С.
- Внешняя публикация Web/API допускается только через reverse proxy с TLS, allowlist/VPN и отдельными security rules.
- PostgreSQL не публикуется во внешнюю сеть.
- `.env` хранится только на сервере и не коммитится.

## Остаточные требования эксплуатации

Это не замечания к коду, а обязательные эксплуатационные условия production:

- назначить владельца сервиса и администратора доступа;
- настроить backup/restore PostgreSQL и проверить восстановление;
- настроить мониторинг доступности API/Web/PostgreSQL;
- завести регламент ротации `JWT_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, amoCRM OAuth credentials;
- ограничить доступ к серверу по SSH/VPN;
- вести журнал изменений конфигурации и релизов.
