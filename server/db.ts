import type { Migration } from "@ilven/common";

/**
 * Locke's own Postgres. Holds ids, states and timestamps in clear; everything about the content (prompts,
 * parameters, images) is sealed: params with the job's key, the job key with Locke's master key, binaries in Garage.
 */
export const migrations: Migration[] = [
  {
    id: "001_workers_jobs",
    sql: `
      CREATE TABLE workers (
        id text PRIMARY KEY,
        name text NOT NULL,
        key_hash text NOT NULL UNIQUE,
        mode text NOT NULL DEFAULT 'test' CHECK (mode IN ('test', 'live')),
        enabled boolean NOT NULL DEFAULT true,
        public_key bytea,
        pending_public_key bytea,
        capabilities jsonb,
        software jsonb,
        gpu jsonb,
        accepting boolean NOT NULL DEFAULT false,
        last_seen_at timestamptz,
        last_hello_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        key_issued_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE jobs (
        id text PRIMARY KEY,
        owner_sub text NOT NULL,
        type text NOT NULL,
        status text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled', 'expired')),
        is_test boolean NOT NULL DEFAULT false,
        target_worker text REFERENCES workers(id) ON DELETE CASCADE,
        requirements jsonb NOT NULL,
        job_key text,
        params bytea,
        summary text,
        inputs jsonb NOT NULL DEFAULT '[]',
        max_results int NOT NULL,
        attempt int NOT NULL DEFAULT 0,
        max_attempts int NOT NULL DEFAULT 3,
        not_before timestamptz NOT NULL DEFAULT now(),
        worker_id text REFERENCES workers(id) ON DELETE SET NULL,
        lease_id text,
        lease_expires_at timestamptz,
        deadline_at timestamptz,
        progress real,
        cancel_requested boolean NOT NULL DEFAULT false,
        failure_code text,
        result_count int,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        finished_at timestamptz,
        expires_at timestamptz
      );
      CREATE INDEX jobs_queue ON jobs (created_at) WHERE status = 'queued';
      CREATE INDEX jobs_owner ON jobs (owner_sub, created_at DESC);
      CREATE INDEX jobs_running ON jobs (lease_expires_at) WHERE status = 'running';

      CREATE TABLE job_results (
        job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        n int NOT NULL,
        bytes int NOT NULL,
        format text NOT NULL,
        PRIMARY KEY (job_id, n)
      );
    `,
  },
];
