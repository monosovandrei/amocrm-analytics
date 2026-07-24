CREATE TABLE "fact_deal_current" (
  "deal_id" TEXT NOT NULL,
  "deal_external_id" TEXT NOT NULL,
  "pipeline_id" TEXT NOT NULL,
  "pipeline_name" TEXT NOT NULL,
  "stage_id" TEXT NOT NULL,
  "stage_name" TEXT NOT NULL,
  "stage_position" INTEGER NOT NULL,
  "stage_color" TEXT,
  "stage_is_won" BOOLEAN NOT NULL DEFAULT false,
  "stage_is_lost" BOOLEAN NOT NULL DEFAULT false,
  "responsible_id" TEXT,
  "responsible_name" TEXT,
  "responsible_external_id" TEXT,
  "group_id" TEXT,
  "group_name" TEXT,
  "contact_id" TEXT,
  "contact_external_id" TEXT,
  "contact_name" TEXT,
  "contact_email" TEXT,
  "loss_reason_id" TEXT,
  "loss_reason_name" TEXT,
  "title" TEXT NOT NULL,
  "amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'RUB',
  "source" TEXT,
  "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "custom_fields" JSONB NOT NULL DEFAULT '{}',
  "closed_at" TIMESTAMP(3),
  "expected_close_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  "deleted_at" TIMESTAMP(3),
  "fact_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "fact_deal_current_pkey" PRIMARY KEY ("deal_id")
);

CREATE TABLE "fact_stage_transition" (
  "id" TEXT NOT NULL,
  "deal_id" TEXT NOT NULL,
  "deal_external_id" TEXT NOT NULL,
  "deal_title" TEXT NOT NULL,
  "deal_amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "deal_currency" TEXT NOT NULL DEFAULT 'RUB',
  "pipeline_id" TEXT NOT NULL,
  "pipeline_name" TEXT NOT NULL,
  "from_stage_id" TEXT,
  "from_stage_name" TEXT,
  "to_stage_id" TEXT NOT NULL,
  "to_stage_name" TEXT NOT NULL,
  "to_stage_position" INTEGER NOT NULL,
  "to_stage_is_won" BOOLEAN NOT NULL DEFAULT false,
  "to_stage_is_lost" BOOLEAN NOT NULL DEFAULT false,
  "responsible_id" TEXT,
  "responsible_name" TEXT,
  "group_id" TEXT,
  "group_name" TEXT,
  "moved_at" TIMESTAMP(3) NOT NULL,
  "moved_by_id" TEXT,
  "source" TEXT NOT NULL DEFAULT 'sync',
  "fact_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "fact_stage_transition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fact_deal_stage_interval" (
  "id" TEXT NOT NULL,
  "deal_id" TEXT NOT NULL,
  "deal_external_id" TEXT NOT NULL,
  "pipeline_id" TEXT NOT NULL,
  "pipeline_name" TEXT NOT NULL,
  "stage_id" TEXT NOT NULL,
  "stage_name" TEXT NOT NULL,
  "stage_position" INTEGER NOT NULL,
  "stage_is_won" BOOLEAN NOT NULL DEFAULT false,
  "stage_is_lost" BOOLEAN NOT NULL DEFAULT false,
  "responsible_id" TEXT,
  "responsible_name" TEXT,
  "responsible_external_id" TEXT,
  "group_id" TEXT,
  "group_name" TEXT,
  "entered_at" TIMESTAMP(3) NOT NULL,
  "exited_at" TIMESTAMP(3),
  "duration_seconds" INTEGER,
  "is_current" BOOLEAN NOT NULL DEFAULT false,
  "fact_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "fact_deal_stage_interval_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "fact_email_thread_state" (
  "id" TEXT NOT NULL,
  "deal_id" TEXT NOT NULL,
  "deal_external_id" TEXT NOT NULL,
  "deal_title" TEXT NOT NULL,
  "deal_amount" DECIMAL(65,30) NOT NULL DEFAULT 0,
  "deal_currency" TEXT NOT NULL DEFAULT 'RUB',
  "pipeline_id" TEXT NOT NULL,
  "pipeline_name" TEXT NOT NULL,
  "stage_id" TEXT NOT NULL,
  "stage_name" TEXT NOT NULL,
  "stage_is_won" BOOLEAN NOT NULL DEFAULT false,
  "stage_is_lost" BOOLEAN NOT NULL DEFAULT false,
  "responsible_id" TEXT,
  "responsible_name" TEXT,
  "responsible_external_id" TEXT,
  "group_id" TEXT,
  "group_name" TEXT,
  "contact_id" TEXT,
  "contact_external_id" TEXT,
  "contact_name" TEXT,
  "contact_email" TEXT,
  "thread_id" TEXT NOT NULL,
  "last_incoming_note_external_id" TEXT,
  "last_incoming_at" TIMESTAMP(3),
  "last_outgoing_at" TIMESTAMP(3),
  "last_message_at" TIMESTAMP(3) NOT NULL,
  "subject" TEXT,
  "summary" TEXT,
  "body" TEXT,
  "from" TEXT,
  "to" TEXT,
  "attach_count" INTEGER NOT NULL DEFAULT 0,
  "delivery_status" TEXT,
  "messages" JSONB NOT NULL DEFAULT '[]',
  "is_pending" BOOLEAN NOT NULL DEFAULT false,
  "source_updated_at" TIMESTAMP(3) NOT NULL,
  "fact_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "fact_email_thread_state_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "fact_deal_current_deal_external_id_key" ON "fact_deal_current"("deal_external_id");
CREATE INDEX "fact_deal_current_pipeline_id_stage_id_idx" ON "fact_deal_current"("pipeline_id", "stage_id");
CREATE INDEX "fact_deal_current_responsible_id_idx" ON "fact_deal_current"("responsible_id");
CREATE INDEX "fact_deal_current_group_id_idx" ON "fact_deal_current"("group_id");
CREATE INDEX "fact_deal_current_created_at_idx" ON "fact_deal_current"("created_at");
CREATE INDEX "fact_deal_current_updated_at_idx" ON "fact_deal_current"("updated_at");
CREATE INDEX "fact_deal_current_closed_at_idx" ON "fact_deal_current"("closed_at");

CREATE INDEX "fact_stage_transition_deal_id_moved_at_idx" ON "fact_stage_transition"("deal_id", "moved_at");
CREATE INDEX "fact_stage_transition_pipeline_id_to_stage_id_moved_at_idx" ON "fact_stage_transition"("pipeline_id", "to_stage_id", "moved_at");
CREATE INDEX "fact_stage_transition_responsible_id_moved_at_idx" ON "fact_stage_transition"("responsible_id", "moved_at");
CREATE INDEX "fact_stage_transition_group_id_moved_at_idx" ON "fact_stage_transition"("group_id", "moved_at");

CREATE INDEX "fact_deal_stage_interval_deal_id_entered_at_idx" ON "fact_deal_stage_interval"("deal_id", "entered_at");
CREATE INDEX "fact_deal_stage_interval_pipeline_id_stage_id_entered_at_idx" ON "fact_deal_stage_interval"("pipeline_id", "stage_id", "entered_at");
CREATE INDEX "fact_deal_stage_interval_responsible_id_entered_at_idx" ON "fact_deal_stage_interval"("responsible_id", "entered_at");
CREATE INDEX "fact_deal_stage_interval_is_current_stage_id_idx" ON "fact_deal_stage_interval"("is_current", "stage_id");

CREATE UNIQUE INDEX "fact_email_thread_state_deal_id_thread_id_key" ON "fact_email_thread_state"("deal_id", "thread_id");
CREATE INDEX "fact_email_thread_state_is_pending_last_incoming_at_idx" ON "fact_email_thread_state"("is_pending", "last_incoming_at");
CREATE INDEX "fact_email_thread_state_deal_id_is_pending_idx" ON "fact_email_thread_state"("deal_id", "is_pending");
CREATE INDEX "fact_email_thread_state_responsible_id_is_pending_idx" ON "fact_email_thread_state"("responsible_id", "is_pending");
CREATE INDEX "fact_email_thread_state_responsible_external_id_is_pending_idx" ON "fact_email_thread_state"("responsible_external_id", "is_pending");
CREATE INDEX "fact_email_thread_state_pipeline_id_is_pending_idx" ON "fact_email_thread_state"("pipeline_id", "is_pending");
CREATE INDEX "fact_email_thread_state_stage_is_won_stage_is_lost_idx" ON "fact_email_thread_state"("stage_is_won", "stage_is_lost");
