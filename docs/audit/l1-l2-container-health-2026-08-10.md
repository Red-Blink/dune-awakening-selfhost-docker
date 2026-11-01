# L1/L2 Audit — ops.health.containers bridge

**Status:** Historical record — audit of the `ops.health.containers` addon bridge as implemented on 2026-08-10. Not maintained.

## L1 Design
Use the Console's existing Docker socket (no new privileges and no cAdvisor dependency). Scope Docker queries to the configured Compose project so an addon cannot enumerate unrelated host containers.

## L2 Implementation

- `services/containerHealth.js`: asynchronous `docker stats` and `docker ps` collection with a five-second timeout and project-label filter
- server.js: bridge route with ops:read permission + audit logging
- Returns per-container `{name, cpu, memory, memoryLimit, networkIO, blockIO, status}`

## Findings
The implementation avoids blocking the API event loop, avoids shell execution, gets status from `docker ps` rather than inventing it from stats output, and does not expose unrelated Docker containers.
