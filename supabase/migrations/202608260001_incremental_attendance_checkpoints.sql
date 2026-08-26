BEGIN;

CREATE TABLE IF NOT EXISTS public.db_sync_checkpoints (
  id BIGSERIAL PRIMARY KEY,
  company_code VARCHAR(10) NOT NULL,
  source VARCHAR(20) NOT NULL,
  last_success_at TIMESTAMPTZ NOT NULL,
  last_window_start TIMESTAMPTZ,
  last_window_end TIMESTAMPTZ,
  last_row_count INTEGER NOT NULL DEFAULT 0,
  last_query_bytes BIGINT NOT NULL DEFAULT 0,
  last_upsert_bytes BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_code, source)
);

ALTER TABLE public.db_sync_checkpoints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.db_sync_checkpoints FROM anon, authenticated;

COMMIT;

