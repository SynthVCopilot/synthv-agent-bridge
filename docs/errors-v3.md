# v3 Public Error Catalog

Status: frozen categories; action-specific codes remain discoverable

Every public failure includes `outcome: "failed"`, `traceId`, `code`, `phase`,
`writeState`, and `undoRequired`. Normal errors are at most 4 KB and contain no
raw fingerprint, lyrics, phoneme text, complete note list, or curve array.

| Family and examples | Stage | Project write | Caller action |
|---|---|---:|---|
| `INVALID_ARGUMENT`, `CONTEXT_INCOMPATIBLE`, `CONTEXT_SCOPE_MISMATCH` | accepted/contextResolved | No | Correct schema or obtain a matching Context |
| `SYNTHV_SESSION_CHANGED`, `CONTEXT_NOT_FOUND`, `GUARD_TOKEN_NOT_FOUND` | contextResolved | No | Reread; never reuse the old Context |
| `PROJECT_UNAVAILABLE`, `TRACK_NOT_FOUND`, `GROUP_NOT_FOUND`, `SELECTION_UNAVAILABLE` | freshRead | No | Open or reselect the intended target |
| `STALE_NOTE`, `STALE_AUTOMATION`, `STALE_TRACK`, `STALE_GROUP`, `STALE_TIME_AXIS` | guarded | No | Deliberately reread; do not auto-retry |
| `SHARED_GROUP_WRITE`, `STALE_GROUP_REFERENCE_COUNT` | guarded | No | Choose explicit all-reference intent with fresh count or isolate |
| `UNSUPPORTED_HOST_CAPABILITY`, `PARAMETER_NOT_FOUND`, `VOCAL_MODE_NOT_FOUND` | preflighted | No | Use a supported operation or hand off to the UI |
| `QUERY_RESPONSE_BUDGET_EXCEEDED` | projected | No | Request a smaller page/range or narrower relevant `include`/`fields` projection |
| `PROTOCOL_MISMATCH`, `BUILD_MISMATCH`, `BUILD_COHERENCE_UNKNOWN` | accepted/freshRead | No | Reinstall/reload the complete v3 component set |
| `HOST_POSTCONDITION_FAILED` | verified | Possible | If `undoRequired`, perform exactly one SynthV Undo, then reread |
| `PROJECT_WRITE_EXECUTION_FAILED`, `HOST_WRITE_FAILED` | mutated | Possible | Follow `undoRequired`; never blind-retry |
| `SIDEBAR_PREVIEW_STALE` | contextResolved/review | No | Republish the preview from fresh state |
| `INTERNAL_ERROR` | any | As reported | Use `traceId` and support diagnostics; follow Undo guidance |

`expected` and `actual` raw fingerprints are private diagnostics. Public stale
errors may report target kind, point/note count, changed-range summary, and
fixed-length digests only.

`QUERY_RESPONSE_BUDGET_EXCEEDED` reports only the action, strategy, measured
character count, budget, and narrowing guidance. It never echoes the rejected
Query payload.
