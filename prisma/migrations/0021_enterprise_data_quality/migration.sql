CREATE TYPE "DataQualityStatus" AS ENUM ('CHECKING', 'CERTIFIED', 'BLOCKED');
CREATE TYPE "DataQualityIncidentStatus" AS ENUM ('OPEN', 'RESOLVED');

ALTER TABLE "AmoConnection"
  ADD COLUMN "lastPullSyncAt" TIMESTAMP(3),
  ADD COLUMN "lastReconcileAt" TIMESTAMP(3),
  ADD COLUMN "lastWebhookAppliedAt" TIMESTAMP(3),
  ADD COLUMN "lastCertifiedAt" TIMESTAMP(3);

UPDATE "AmoConnection"
SET "lastPullSyncAt" = "lastIncrementalSyncAt"
WHERE "lastPullSyncAt" IS NULL;

ALTER TABLE report_snapshot
  ADD COLUMN data_cutoff_at TIMESTAMP(3),
  ADD COLUMN quality_status "DataQualityStatus" NOT NULL DEFAULT 'CHECKING',
  ADD COLUMN quality_checked_at TIMESTAMP(3),
  ADD COLUMN quality_incident_id TEXT,
  ADD COLUMN metric_version TEXT NOT NULL DEFAULT '1',
  ADD COLUMN build_id TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX report_snapshot_quality_status_checked_idx
  ON report_snapshot (quality_status, quality_checked_at);

ALTER TABLE worker_runtime
  ADD COLUMN build_id TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN metric_version TEXT NOT NULL DEFAULT '1';

CREATE TABLE data_quality_check (
  id TEXT PRIMARY KEY,
  "connectionId" TEXT,
  check_type TEXT NOT NULL,
  status "DataQualityStatus" NOT NULL DEFAULT 'CHECKING',
  cutoff_at TIMESTAMP(3),
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  message TEXT,
  build_id TEXT NOT NULL DEFAULT 'unknown',
  metric_version TEXT NOT NULL DEFAULT '1',
  started_at TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMP(3),
  created_at TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT data_quality_check_connection_fkey
    FOREIGN KEY ("connectionId") REFERENCES "AmoConnection"(id) ON DELETE CASCADE
);

CREATE INDEX data_quality_check_connection_started_idx ON data_quality_check ("connectionId", started_at);
CREATE INDEX data_quality_check_status_started_idx ON data_quality_check (status, started_at);

CREATE TABLE data_quality_incident (
  id TEXT PRIMARY KEY,
  "connectionId" TEXT,
  code TEXT NOT NULL,
  severity "QualitySeverity" NOT NULL DEFAULT 'CRITICAL',
  status "DataQualityIncidentStatus" NOT NULL DEFAULT 'OPEN',
  scope JSONB NOT NULL DEFAULT '{}'::jsonb,
  message TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  detection_count INTEGER NOT NULL DEFAULT 1,
  first_detected_at TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  last_detected_at TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  confirmed_at TIMESTAMP(3),
  resolved_at TIMESTAMP(3),
  last_notified_at TIMESTAMP(3),
  resolved_notified_at TIMESTAMP(3),
  notification_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  CONSTRAINT data_quality_incident_connection_fkey
    FOREIGN KEY ("connectionId") REFERENCES "AmoConnection"(id) ON DELETE CASCADE
);

CREATE INDEX data_quality_incident_status_confirmed_idx ON data_quality_incident (status, confirmed_at);
CREATE INDEX data_quality_incident_connection_code_status_idx ON data_quality_incident ("connectionId", code, status);
CREATE UNIQUE INDEX data_quality_incident_one_open_code_idx
  ON data_quality_incident (COALESCE("connectionId", ''), code)
  WHERE status = 'OPEN';
