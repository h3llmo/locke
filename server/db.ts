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
  {
    // Pixel size a result must have (face_swap, blur keep the input's size); NULL = any size.
    id: "002_result_size",
    sql: "ALTER TABLE jobs ADD COLUMN result_size jsonb",
  },
  {
    // Saved characters, saved prompts and their schedules, automated workflows. Names, prompts and settings are
    // sealed (Locke's master key, bound to the row id inside); face and reference photos are sealed blobs in Garage
    // under a per-row key. Only ids, counts, states and times are in clear.
    id: "003_characters_prompts_workflows",
    sql: `
      CREATE TABLE characters (
        id text PRIMARY KEY,
        owner_sub text NOT NULL,
        data text NOT NULL,
        blob_key text NOT NULL,
        faces jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX characters_owner ON characters (owner_sub, created_at);

      CREATE TABLE prompts (
        id text PRIMARY KEY,
        owner_sub text NOT NULL,
        data text NOT NULL,
        blob_key text NOT NULL,
        refs jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX prompts_owner ON prompts (owner_sub, updated_at DESC);

      CREATE TABLE schedules (
        id text PRIMARY KEY,
        owner_sub text NOT NULL,
        prompt_id text NOT NULL UNIQUE REFERENCES prompts(id) ON DELETE CASCADE,
        spec jsonb NOT NULL,
        active boolean NOT NULL DEFAULT true,
        keep_results boolean NOT NULL DEFAULT false,
        next_run_at timestamptz,
        last_run_at timestamptz,
        run_count int NOT NULL DEFAULT 0,
        skipped_count int NOT NULL DEFAULT 0,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX schedules_due ON schedules (next_run_at) WHERE active;

      ALTER TABLE jobs ADD COLUMN schedule_id text REFERENCES schedules(id) ON DELETE SET NULL;
      ALTER TABLE jobs ADD COLUMN keep boolean NOT NULL DEFAULT false;
      ALTER TABLE jobs ADD COLUMN workflow_run_id text;
      CREATE INDEX jobs_schedule ON jobs (schedule_id, created_at DESC) WHERE schedule_id IS NOT NULL;

      -- The user's delegated key (Nevli), so workflows can read vault sources and save to the vault while they're away.
      CREATE TABLE automation (
        owner_sub text PRIMARY KEY,
        sealed_key text NOT NULL,
        prefix text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE workflows (
        id text PRIMARY KEY,
        owner_sub text NOT NULL,
        data text NOT NULL,
        active boolean NOT NULL DEFAULT false,
        activated_at timestamptz,
        cursors jsonb NOT NULL DEFAULT '{}',
        last_check_at timestamptz,
        last_error text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX workflows_owner ON workflows (owner_sub, created_at);

      -- One per new image a workflow picked up. 'baseline' = already in the source when the workflow started (never run).
      CREATE TABLE workflow_runs (
        id text PRIMARY KEY,
        workflow_id text NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        owner_sub text NOT NULL,
        source text NOT NULL,
        ref text NOT NULL,
        status text NOT NULL CHECK (status IN ('baseline', 'pending', 'running', 'done', 'failed')),
        item_id text,
        step int NOT NULL DEFAULT 0,
        job_id text,
        notes jsonb NOT NULL DEFAULT '[]',
        failure text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (workflow_id, source, ref)
      );
      CREATE INDEX workflow_runs_open ON workflow_runs (workflow_id, created_at) WHERE status IN ('pending', 'running');
    `,
  },
];
