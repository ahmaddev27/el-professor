-- Enable pgcrypto for SHA-256 hashing
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Activation codes table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS activation_codes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash             text NOT NULL,
  code_last4            text,
  company_id            uuid REFERENCES companies(id) ON DELETE SET NULL,
  target_email          text,
  duration_type         text NOT NULL CHECK (duration_type IN ('1_monat','3_monate','1_jahr','benutzerdefiniert')),
  duration_months       integer,
  custom_days           integer,
  custom_expires_at     timestamptz,
  expires_at            timestamptz NOT NULL,
  used_at               timestamptz,
  used_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  used_company_id       uuid REFERENCES companies(id) ON DELETE SET NULL,
  revoked_at            timestamptz,
  revoked_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by            uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  status                text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','used','expired','revoked'))
);

-- ── Activation code attempts (brute-force log) ────────────────────────────────
CREATE TABLE IF NOT EXISTS activation_code_attempts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid REFERENCES companies(id) ON DELETE SET NULL,
  user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  input_last4   text,
  success       boolean NOT NULL DEFAULT false,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_activation_codes_status     ON activation_codes(status);
CREATE INDEX IF NOT EXISTS idx_activation_codes_expires_at ON activation_codes(expires_at);
CREATE INDEX IF NOT EXISTS idx_activation_codes_code_hash  ON activation_codes(code_hash);
CREATE INDEX IF NOT EXISTS idx_activation_code_attempts_company
  ON activation_code_attempts(company_id, created_at);

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE activation_codes          ENABLE ROW LEVEL SECURITY;
ALTER TABLE activation_code_attempts  ENABLE ROW LEVEL SECURITY;

-- Super admins can do everything with activation_codes
CREATE POLICY "sa_select_activation_codes" ON activation_codes FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND is_super_admin = true)
  );

CREATE POLICY "sa_insert_activation_codes" ON activation_codes FOR INSERT
  TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND is_super_admin = true)
  );

CREATE POLICY "sa_update_activation_codes" ON activation_codes FOR UPDATE
  TO authenticated
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND is_super_admin = true))
  WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND is_super_admin = true));

CREATE POLICY "sa_delete_activation_codes" ON activation_codes FOR DELETE
  TO authenticated USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND is_super_admin = true)
  );

-- activation_code_attempts: super admins can select; everyone can insert (via RPC only)
CREATE POLICY "sa_select_attempts" ON activation_code_attempts FOR SELECT
  TO authenticated USING (
    EXISTS (SELECT 1 FROM user_profiles WHERE user_id = auth.uid() AND is_super_admin = true)
  );

-- Attempts inserted by RPC (SECURITY DEFINER bypasses RLS) — add permissive policy so RPC can also insert
CREATE POLICY "any_insert_attempts" ON activation_code_attempts FOR INSERT
  TO authenticated WITH CHECK (true);
