#!/usr/bin/env bash
# Rotate the stack's JWT secrets in .env, in place, without printing one.
#
# Rotates four values that stand or fall together:
#
#   JWT_SECRET         the HS256 signing key
#   ANON_KEY           JWT signed with it, role "anon"        (public, ships in the bundle)
#   SERVICE_ROLE_KEY   JWT signed with it, role "service_role" (bypasses every RLS policy)
#   REALTIME_ENC_KEY   AES-128 key for Realtime's tenant table
#
# The three JWT values are one unit: change the secret without reminting the
# keys and every request is rejected with an invalid signature.
#
# REALTIME_ENC_KEY must be EXACTLY 16 CHARACTERS. Realtime passes it straight to
# :crypto.crypto_one_time(:aes_128_ecb, key, ...), which takes the string's own
# bytes as the key — it is not hex-decoded. A 32-character key is not a stronger
# key, it is a container that will not start:
#
#   ** (ErlangError) Erlang error: {:badarg, ..., ~c"Bad key size"}
#
# Everything is generated with `openssl rand -hex`, so no value can contain a
# character that needs escaping in .env, YAML, or a shell.
#
# Usage:  bash rotate-secrets.sh [path-to-.env]
#
# Prints lengths only, never values. After running it, rebuild the frontend —
# ANON_KEY is baked into the bundle at build time.

set -euo pipefail

ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] || { echo "rotate-secrets: no such file: $ENV_FILE" >&2; exit 1; }

backup="$ENV_FILE.bak-$(date +%Y%m%d-%H%M%S)"
cp -p "$ENV_FILE" "$backup"
echo "rotate-secrets: previous values kept at $backup"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# HS256 JWT in the shape Supabase's services expect.
mint_jwt() {
  local role="$1" secret="$2" iat exp header payload
  iat=$(date +%s)
  exp=$(( iat + 10 * 365 * 24 * 3600 ))
  header=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '{"role":"%s","iss":"supabase","iat":%s,"exp":%s}' "$role" "$iat" "$exp" | b64url)
  printf '%s.%s.%s' "$header" "$payload" \
    "$(printf '%s' "$header.$payload" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)"
}

# Replace KEY=... in place, or append it. awk via ENVIRON so no value is ever
# parsed as a pattern or an escape sequence.
set_var() {
  local key="$1" value="$2" tmp
  tmp=$(mktemp)
  ROTATE_KEY="$key" ROTATE_VAL="$value" awk '
    BEGIN { k = ENVIRON["ROTATE_KEY"]; v = ENVIRON["ROTATE_VAL"]; seen = 0 }
    index($0, k "=") == 1 { print k "=" v; seen = 1; next }
    { print }
    END { if (!seen) print k "=" v }
  ' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"   # preserve the original file's mode
  rm -f "$tmp"
}

jwt_secret=$(openssl rand -hex 32)          # 64 chars, well above the 32 minimum
realtime_enc_key=$(openssl rand -hex 8)     # 16 chars exactly — see above

set_var JWT_SECRET       "$jwt_secret"
set_var ANON_KEY         "$(mint_jwt anon "$jwt_secret")"
set_var SERVICE_ROLE_KEY "$(mint_jwt service_role "$jwt_secret")"
set_var REALTIME_ENC_KEY "$realtime_enc_key"

echo
echo "rotate-secrets: rotated (lengths only)"
for k in JWT_SECRET ANON_KEY SERVICE_ROLE_KEY REALTIME_ENC_KEY; do
  line=$(grep -m1 "^$k=" "$ENV_FILE")
  value=${line#*=}
  note=""
  [ "$k" = REALTIME_ENC_KEY ] && { [ ${#value} -eq 16 ] && note="  (must be 16 — ok)" || note="  (MUST BE 16 — WRONG)"; }
  printf '  %-18s %3d chars%s\n' "$k" "${#value}" "$note"
done
echo
echo "rotate-secrets: ANON_KEY is baked into the frontend at build time — rebuild it."
