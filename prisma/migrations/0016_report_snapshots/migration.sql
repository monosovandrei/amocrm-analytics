CREATE TABLE "report_snapshot" (
  "cache_key" TEXT NOT NULL,
  "name" TEXT,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "report_config" JSONB,
  "source_sync_at" TIMESTAMP(3),
  "refresh_status" TEXT NOT NULL DEFAULT 'IDLE',
  "refresh_requested_at" TIMESTAMP(3),
  "refreshing_at" TIMESTAMP(3),
  "refresh_error" TEXT,
  "last_accessed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "report_snapshot_pkey" PRIMARY KEY ("cache_key")
);

CREATE TABLE "report_snapshot_job" (
  "id" TEXT NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
  "snapshot_cache_key" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "report_config" JSONB,
  "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "finished_at" TIMESTAMP(3),
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "report_snapshot_job_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "report_snapshot_refreshStatus_refreshRequestedAt_idx"
  ON "report_snapshot"("refresh_status", "refresh_requested_at");
CREATE INDEX "report_snapshot_sourceSyncAt_idx"
  ON "report_snapshot"("source_sync_at");
CREATE INDEX "report_snapshot_job_status_requestedAt_idx"
  ON "report_snapshot_job"("status", "requested_at");
CREATE INDEX "report_snapshot_job_snapshotCacheKey_status_idx"
  ON "report_snapshot_job"("snapshot_cache_key", "status");

ALTER TABLE "report_snapshot_job"
  ADD CONSTRAINT "report_snapshot_job_snapshotCacheKey_fkey"
  FOREIGN KEY ("snapshot_cache_key") REFERENCES "report_snapshot"("cache_key") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$
BEGIN
  IF to_regclass('public.report_result_cache') IS NOT NULL THEN
    INSERT INTO "report_snapshot" (
      "cache_key",
      "name",
      "payload",
      "report_config",
      "source_sync_at",
      "refresh_status",
      "refresh_requested_at",
      "refreshing_at",
      "refresh_error",
      "last_accessed_at",
      "created_at",
      "updated_at"
    )
    SELECT
      "cache_key",
      "name",
      "payload",
      "report_config",
      "source_sync_at",
      "refresh_status",
      "refresh_requested_at",
      "refreshing_at",
      "refresh_error",
      "last_accessed_at",
      "created_at",
      "updated_at"
    FROM "report_result_cache"
    ON CONFLICT ("cache_key") DO NOTHING;

    INSERT INTO "report_snapshot_job" (
      "snapshot_cache_key",
      "status",
      "report_config",
      "requested_at",
      "created_at",
      "updated_at"
    )
    SELECT
      "cache_key",
      'QUEUED',
      "report_config",
      coalesce("refresh_requested_at", "updated_at", now()),
      now(),
      now()
    FROM "report_result_cache"
    WHERE "report_config" IS NOT NULL
      AND "refresh_status" IN ('QUEUED', 'RUNNING')
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
