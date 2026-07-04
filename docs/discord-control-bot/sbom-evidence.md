# SBOM Evidence

## Purpose

This document defines the repository-local software bill of materials evidence for the Discord companion bot and Console API adapter.

## Generator

```text
scripts/generate-sbom.mjs
```

## Workflow

```text
.github/workflows/sbom-generation.yml
```

## Output Artifacts

```text
artifacts/security/sbom.cyclonedx.json
artifacts/security/sbom.md
```

## Readiness Mapping

- DC-SOC2-SEC-006: Vulnerabilities are identified before release.
- DC-SOC2-SEC-010: Dependency risk is managed.
- E-009: SBOM evidence for release readiness.

## Notes

The generator is free and repository-local. It reads npm lockfiles and emits CycloneDX-style JSON plus a Markdown summary. It does not claim certification or formal attestation by itself.
