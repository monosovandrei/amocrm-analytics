UPDATE "Deal"
SET "syncedAt" = "updatedAt"
WHERE "syncedAt" <= COALESCE(
  (
    SELECT "finished_at" AT TIME ZONE 'UTC'
    FROM "_prisma_migrations"
    WHERE "migration_name" = '0022_fact_ingestion_watermarks'
      AND "finished_at" IS NOT NULL
    ORDER BY "finished_at" DESC
    LIMIT 1
  ),
  '-infinity'::timestamp
);
