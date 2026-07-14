#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

mode="${1:-summary}"
out_file="${2:-}"

require_postgres() {
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qx dune-postgres; then
    echo "dune-postgres is not running." >&2
    exit 1
  fi
}

summary_sql() {
  cat <<'SQL'
with
accounts_without_encrypted as (
  select count(*) as count
  from dune.accounts a
  left join dune.encrypted_accounts ea on ea.id = a.id
  where ea.id is null
),
encrypted_without_accounts as (
  select count(*) as count
  from dune.encrypted_accounts ea
  left join dune.accounts a on a.id = ea.id
  where a.id is null
),
player_state_without_accounts as (
  select count(*) as count
  from dune.player_state ps
  left join dune.accounts a on a.id = ps.account_id
  where a.id is null
),
encrypted_player_state_without_accounts as (
  select count(*) as count
  from dune.encrypted_player_state eps
  left join dune.accounts a on a.id = eps.account_id
  where a.id is null
)
select 'accounts_without_encrypted', count from accounts_without_encrypted
union all
select 'encrypted_without_accounts', count from encrypted_without_accounts
union all
select 'player_state_without_accounts', count from player_state_without_accounts
union all
select 'encrypted_player_state_without_accounts', count from encrypted_player_state_without_accounts
order by 1;
SQL
}

detail_sql() {
  cat <<'SQL'
select
  orphan_type,
  account_id,
  fls_id,
  funcom_id,
  character_name
from (
  select
    'accounts_without_encrypted'::text as orphan_type,
    a.id::text as account_id,
    coalesce(a."user", '') as fls_id,
    coalesce(a.funcom_id, '') as funcom_id,
    coalesce(ps.character_name, '') as character_name
  from dune.accounts a
  left join dune.encrypted_accounts ea on ea.id = a.id
  left join dune.player_state ps on ps.account_id = a.id
  where ea.id is null

  union all

  select
    'encrypted_without_accounts'::text as orphan_type,
    ea.id::text as account_id,
    coalesce(convert_from(ea.encrypted_funcom_id, 'UTF8'), '') as fls_id,
    '' as funcom_id,
    coalesce(ps.character_name, '') as character_name
  from dune.encrypted_accounts ea
  left join dune.accounts a on a.id = ea.id
  left join dune.player_state ps on ps.account_id = ea.id
  where a.id is null

  union all

  select
    'player_state_without_accounts'::text as orphan_type,
    ps.account_id::text as account_id,
    '' as fls_id,
    '' as funcom_id,
    coalesce(ps.character_name, '') as character_name
  from dune.player_state ps
  left join dune.accounts a on a.id = ps.account_id
  where a.id is null

  union all

  select
    'encrypted_player_state_without_accounts'::text as orphan_type,
    eps.account_id::text as account_id,
    '' as fls_id,
    '' as funcom_id,
    '' as character_name
  from dune.encrypted_player_state eps
  left join dune.accounts a on a.id = eps.account_id
  where a.id is null
) rows
order by orphan_type, account_id;
SQL
}

require_postgres

case "$mode" in
  summary)
    docker exec dune-postgres psql -U postgres -d dune -At -F $'\t' -c "$(summary_sql)"
    ;;
  detail)
    docker exec dune-postgres psql -U postgres -d dune -At -F $'\t' -c "$(detail_sql)"
    ;;
  export)
    if [ -z "$out_file" ]; then
      echo "Usage: db-orphan-audit.sh export <output.tsv>" >&2
      exit 1
    fi
    mkdir -p "$(dirname "$out_file")"
    {
      printf 'orphan_type\taccount_id\tfls_id\tfuncom_id\tcharacter_name\n'
      docker exec dune-postgres psql -U postgres -d dune -At -F $'\t' -c "$(detail_sql)"
    } >"$out_file"
    ;;
  *)
    echo "Usage: db-orphan-audit.sh [summary|detail|export <output.tsv>]" >&2
    exit 1
    ;;
esac
