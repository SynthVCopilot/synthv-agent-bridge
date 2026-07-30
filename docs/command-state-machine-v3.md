# v3 Command State Machine

Status: frozen for `0.2.0-alpha`

Every project command advances monotonically through these stages:

```text
accepted
  -> contextResolved
  -> freshRead
  -> guarded
  -> preflighted
  -> effectPlanned
  -> undoOpened
  -> mutated
  -> verified
  -> cacheInvalidated
  -> projected
```

| Stage | Required evidence | Failure recovery |
|---|---|---|
| `accepted` | Public schema and route valid | Correct request; no IPC or Undo |
| `contextResolved` | Typed Context matches action and explicit scope | Issue fresh `writeIntent` Context |
| `freshRead` | Current host target and dependencies resolved | Reopen/select valid target |
| `guarded` | Session, fingerprints, ownership count match | Reread; no Undo |
| `preflighted` | Capabilities, dynamic ranges, all independent values valid | Correct plan; no Undo |
| `effectPlanned` | Expected effects and already-satisfied state known | Internal planning error; no Undo |
| `undoOpened` | Exactly one recovery boundary created when effects exist | Later failure may require one Undo |
| `mutated` | Official API mutations attempted | Never auto-retry |
| `verified` | Fresh readback satisfies action postconditions | `HOST_POSTCONDITION_FAILED`; one Undo |
| `cacheInvalidated` | Affected read snapshots removed | Cache failure falls back to host reads |
| `projected` | Bounded, redacted public outcome emitted | Projection failure does not authorize retry |

An effect plan with no required changes returns `alreadySatisfied` before
`undoOpened`. Unexpected zero effect after a non-empty effect plan is a failed
postcondition.

Independent batch steps complete preflight before the shared Undo boundary.
A step whose complete value depends on an earlier result is resolved and
preflighted just in time. If an earlier step already wrote, any later failure
returns `undoRequired=true`.
