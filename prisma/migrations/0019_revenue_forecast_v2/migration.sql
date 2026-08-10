CREATE TABLE IF NOT EXISTS forecast_model_run (
    run_id TEXT PRIMARY KEY,
    model_version TEXT NOT NULL,
    forecast_at TIMESTAMPTZ NOT NULL,
    forecast_month DATE NOT NULL,
    expected_revenue NUMERIC NOT NULL,
    actual_revenue NUMERIC NOT NULL,
    summary JSONB NOT NULL,
    diagnostics JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS forecast_deal_snapshot (
    run_id TEXT NOT NULL REFERENCES forecast_model_run(run_id) ON DELETE CASCADE,
    deal_id TEXT NOT NULL,
    deal_external_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    amount NUMERIC NOT NULL,
    feature_keys JSONB NOT NULL,
    prediction JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (run_id, deal_id)
);

CREATE INDEX IF NOT EXISTS forecast_model_run_forecast_at_idx
    ON forecast_model_run (forecast_at DESC);

CREATE INDEX IF NOT EXISTS forecast_deal_snapshot_deal_idx
    ON forecast_deal_snapshot (deal_id, created_at DESC);
