# Dune Discord Control Bot - Release Checklist

## Release Information

| Field | Value |
| --- | --- |
| Version | |
| Release owner | |
| Date | |
| Commit SHA | |
| Image tag | |
| Rollback version | |

## Scope

Describe released changes.

## Required Gates

```text
[ ] Unit tests passed.
[ ] Authorization matrix tests passed.
[ ] Redaction tests passed.
[ ] Secret scan passed.
[ ] SCA passed.
[ ] SAST passed.
[ ] DCA passed.
[ ] DAST passed or not applicable with documented reason.
[ ] Container image scan passed.
[ ] SBOM generated.
[ ] Image signed.
[ ] Release notes completed.
[ ] Rollback plan documented.
[ ] SOC 2 evidence index updated.
```

## Security Review

```text
[ ] No critical/high open findings without approved exception.
[ ] No secrets in source, logs, image layers, or artifacts.
[ ] Bot container does not mount Docker socket.
[ ] Bot container does not run privileged.
[ ] Bot container runs as non-root.
[ ] Write/admin commands are disabled by default unless explicitly approved.
[ ] Destructive commands require confirmation.
[ ] State-changing commands emit audit events.
```

## SOC 2 Evidence

| Evidence ID | Artifact Link | Notes |
| --- | --- | --- |
| E-001 | | CI gate result |
| E-002 | | Secret scan |
| E-003 | | SCA report |
| E-004 | | SAST report |
| E-005 | | DCA/container scan |
| E-006 | | DAST report |
| E-007 | | Unit/auth test report |
| E-008 | | Release checklist |
| E-009 | | SBOM |
| E-010 | | Image signature/provenance |

## Rollback Plan

Describe rollback command, previous image tag, data compatibility, and verification steps.

## Approval

| Approver | Role | Date | Decision |
| --- | --- | --- | --- |
| | | | |
