#!/usr/bin/env bash

director_fls_logs_ready() {
  local logs="${1:-}"

  awk '
    {
      lower = tolower($0)
    }

    lower ~ /flsapi.*http request error|battlegroups_.*request (failed|error)/ {
      explicit_success = 0
      valid_declarations = 0
      next
    }

    /Battlegroups_(SendBattlegroupHeartbeat|DeclarePopulationAndActivity|DeclareMaxPlayerCapacities).*Request successful/ {
      explicit_success = 1
      next
    }

    /Population declaration:/ {
      if ($0 ~ /"BattlegroupMaxPlayerCapacity":[[:space:]]*[1-9][0-9]*/ &&
          $0 ~ /"IsLocked":[[:space:]]*false/) {
        valid_declarations++
        invalid_declaration = 0
      } else {
        # An older healthy report cannot keep a stalled/locked map Ready.
        # A successful heartbeat alone does not restore usable capacity.
        explicit_success = 0
        valid_declarations = 0
        invalid_declaration = 1
      }
    }

    END {
      exit(!invalid_declaration && (explicit_success || valid_declarations >= 2) ? 0 : 1)
    }
  ' <<< "$logs"
}
