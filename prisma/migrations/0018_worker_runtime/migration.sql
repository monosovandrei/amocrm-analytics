CREATE TABLE "worker_runtime" (
  "role" TEXT NOT NULL,
  "process_id" INTEGER NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL,
  "heartbeat_at" TIMESTAMP(3) NOT NULL,
  "rss_mb" INTEGER NOT NULL DEFAULT 0,
  "heap_used_mb" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "worker_runtime_pkey" PRIMARY KEY ("role")
);

CREATE INDEX "worker_runtime_heartbeat_at_idx" ON "worker_runtime"("heartbeat_at");
CREATE INDEX "worker_runtime_started_at_idx" ON "worker_runtime"("started_at");
