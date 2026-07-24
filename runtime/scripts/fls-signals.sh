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

    /Population declaration:/ &&
      /"BattlegroupMaxPlayerCapacity":[1-9][0-9]*/ &&
      /"IsLocked":false/ {
      valid_declarations++
    }

    END {
      exit(explicit_success || valid_declarations >= 2 ? 0 : 1)
    }
  ' <<< "$logs"
}
