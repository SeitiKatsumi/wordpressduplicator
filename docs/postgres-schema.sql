CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS connection_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ssh', 'caprover', 'mysql')),
  host TEXT,
  port INTEGER,
  username TEXT,
  encrypted_secret TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clone_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  source_app TEXT NOT NULL,
  target_app_pattern TEXT,
  old_url TEXT,
  default_wp_path TEXT NOT NULL DEFAULT '/var/www/html',
  source_ssh_profile_id UUID REFERENCES connection_profiles(id),
  source_caprover_profile_id UUID REFERENCES connection_profiles(id),
  target_ssh_profile_id UUID REFERENCES connection_profiles(id),
  target_caprover_profile_id UUID REFERENCES connection_profiles(id),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clone_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID REFERENCES clone_profiles(id),
  source_app TEXT NOT NULL,
  target_app TEXT NOT NULL,
  old_url TEXT NOT NULL,
  new_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'succeeded', 'failed', 'cancelled')),
  current_step TEXT,
  dry_run BOOLEAN NOT NULL DEFAULT true,
  allow_existing_target BOOLEAN NOT NULL DEFAULT false,
  source_summary JSONB NOT NULL DEFAULT '{}',
  target_summary JSONB NOT NULL DEFAULT '{}',
  config_snapshot JSONB NOT NULL DEFAULT '{}',
  report JSONB NOT NULL DEFAULT '{}',
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clone_job_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES clone_jobs(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  message TEXT,
  details JSONB NOT NULL DEFAULT '{}',
  UNIQUE (job_id, step_name)
);

CREATE TABLE IF NOT EXISTS clone_job_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID REFERENCES clone_jobs(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warning', 'error')),
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clone_jobs_status ON clone_jobs(status);
CREATE INDEX IF NOT EXISTS idx_clone_jobs_created_at ON clone_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clone_job_logs_job_id_created_at ON clone_job_logs(job_id, created_at);
