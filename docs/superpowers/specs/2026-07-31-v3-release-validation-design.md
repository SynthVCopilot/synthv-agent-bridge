# SynthV Agent Bridge v3 Release Validation Design

Status: proposed for execution

Date: 2026-07-31

## Goal

Validate `0.2.0-alpha.1` in four increasingly strict stages:

1. prove that the Alpha is safe enough for controlled daily use;
2. close the real-host evidence gaps across the public v3 surface;
3. exercise crash recovery, concurrency, reloads, and sustained operation;
4. make an evidence-based decision to release `0.2.0`, release a reduced
   stable surface, or remain on Alpha.

The validation starts from Git commit `429ac15` on
`codex/v3-implementation`. Historical results are context only. Every release
claim requires fresh evidence from the current source and installed build.

## Supported release scope

The first stable decision covers only:

- Synthesizer V Studio 2 Pro;
- Windows 11;
- SynthV standalone mode;
- local file IPC using protocol v3;
- the six public tools `sv_status`, `sv_describe`, `sv_query`, `sv_command`,
  `sv_ui`, and `sv_review`;
- saved disposable project copies for destructive testing.

Plugin and ARA modes are outside this release decision. The Bridge does not
parse or modify `.svp`, identify the current Vocal, enumerate untouched
default Vocal Modes, save projects, or render/export audio.

## Global safety rules

- SynthV is the authoritative project state.
- Every write begins with a fresh `writeIntent` read of the exact target.
- Track, Group, Reference, and note indices remain 1-based at the public
  boundary.
- Shared Group-content writes default to rejection.
- Each logical command creates at most one SynthV Undo record.
- `alreadySatisfied` creates no mutation and no Undo record.
- Any response with `undoRequired=true` stops all reads and writes to that
  target until one SynthV Undo has been performed and the target has been read
  again.
- A timeout, Session change, or native crash invalidates the old Context and
  Guard data. The command is never retried automatically.
- A native crash preserves only the bounded redacted crash breadcrumb. After
  restart, testing resumes from a newly opened saved project copy.
- Tests never infer a Vocal identity. Before the first tuning write, the user
  must select the intended Note Group, assign its Vocal, and provide the
  complete Vocal Mode panel or every exact mode name.
- Test artifacts, logs, and reports must not contain project lyrics, note
  arrays, curves, raw fingerprints, or Vocal identity claims.

## Evidence model

Each scenario records:

- Git commit and Node/Lua/Sidebar build identities;
- SynthV version, operating mode, Session token, and project-copy identity;
- pre-test authoritative projection;
- command outcome, changed count, Undo count, verification state, warnings,
  trace identifier, response bytes, and timings;
- post-test authoritative projection;
- recovery action and authoritative projection after recovery;
- pass, fail, blocked, unsupported, or experimental status.

Automated Fake Host evidence proves deterministic Bridge behavior. Only real
SynthV evidence proves host integration. A scenario is not promoted from
`sampled` to `verified` until its declared real-host repetitions pass.

## Stage 1: Alpha daily-use acceptance

### Purpose

Prove that the installed Alpha supports controlled everyday use on a saved
test project without exposing the unverified tail of the action catalog as
stable.

### Automated gate

Run:

```text
npm run check
node --check scripts/clean.mjs
node --check scripts/install-synthv-bridge.mjs
luac5.4 -p synthv/SynthVAgentBridge.lua synthv/StopSynthVAgentBridge.lua synthv/SynthVAgentSidebar.lua
git diff --check
npm run check:api-coverage
npm run benchmark:v3
```

All commands must exit zero. The current machine must obtain a working Lua 5.4
compiler before this gate can pass; absence of `luac5.4` is `blocked`, not
`passed`.

### Connection and read gate

- Six-tool catalog is present and below 6,000 characters and UTF-8 bytes.
- Protocol v3 is the only accepted envelope.
- Node, Lua, and Sidebar builds match and project writes are allowed.
- Project, time axis, Tracks, library Groups, notes, Voice, phonemes,
  computed data, Pitch Controls, Automation, and Mixer reads return bounded
  public projections.
- Private Group UUIDs, fingerprints, Guards, lyrics, full note arrays, and
  curves do not leak outside explicitly requested bounded projections.
- Session reload invalidates prior Contexts and restores connection.

### Representative write gate

Use one saved disposable project copy and restore every scenario:

- Mixer change, repeated no-op, and one-Undo restoration;
- Sidebar preview, Apply, and one-Undo restoration;
- stale Context and Session-change rejection before Undo;
- shared Group default rejection before Undo;
- linked, isolated, and shell clone semantics with source preservation;
- guarded note edit/delete/transform with phrase geometry preserved;
- Automation point write and closed-range removal with endpoint verification;
- one successful dependent transaction and one dependent-preflight failure
  that explicitly requires one Undo.

The known transaction APPCRASH means transaction support remains experimental
at the Alpha gate even if these representative cases pass.

### Alpha pass criteria

- No native crash during Stage 1.
- No unexpected mutation or extra Undo record.
- Every test-created mutation is restored and the final project projection
  matches its initial projection.
- No Critical or Important defect affects the daily-use scenarios.
- Public responses meet the 20,000-byte Query, 2,048-byte acknowledgement,
  and 4,096-byte error limits.
- Ordinary real-host operations have p95 below 300 ms.

Passing Stage 1 permits the claim: “The Alpha is suitable for controlled daily
use on saved working copies.” It does not permit a stable-release claim.

## Stage 2: Public capability real-host coverage

### Purpose

Replace broad “sampled” and “pending” labels with explicit real-host evidence
or remove unsupported capabilities from the stable surface.

### Query and UI coverage

- Exercise all 17 Query actions with default and boundary projections.
- Exercise all 9 UI actions and verify the actual selection, viewport,
  clipboard/dialog, snapping/coordinates, playback state, and playhead
  returned by SynthV.
- Verify 1-based indices, paging reconstruction, pending computed data, and
  response budgets on small and large synthetic targets.

### Write coverage

Exercise all 38 public write actions. Each action must finish in exactly one
of these states:

- `verified`: successful write, no-op where applicable, preflight rejection,
  postcondition read, and Undo recovery passed on real SynthV;
- `unsupported`: the host capability is absent and the Bridge fails closed
  before Undo with an accurate public error;
- `experimental`: retained outside the stable surface with an explicit user
  warning and release note.

Coverage includes:

- time-axis, Track, Group, Reference, Mixer, and metadata writes;
- note add/edit/delete/transform, lyrics, phoneme properties, humanization,
  expression, and score import;
- Retake generate/activate/delete where the installed host exposes the
  capability;
- Smart Pitch add/edit/delete;
- Automation set/simplify/closed-range clear;
- linked/isolated/shell cloning and deletions;
- `apply_group_tuning` as one preflighted effect plan and one Undo;
- transaction apply and rollback.

### Vocal and listening gate

After Vocal onboarding:

- perform one integrated `apply_group_tuning` scenario covering Voice/Vocal
  Modes, notes or phonemes, Automation, and Smart Pitch;
- preserve all user-owned note geometry not explicitly targeted;
- account for every gap in notes created by the test;
- start playback and perform a human listening check for audible rendering,
  connected lyric phrases, and absence of unintended gaps.

Artistic quality remains a user judgment. The technical gate verifies that the
requested values reached the intended Group and can be undone once.

### Stage 2 pass criteria

- Every public action has one of the three explicit statuses above.
- No public stable action remains merely `pending` or `sampled`.
- Every supported write has authoritative postconditions and a demonstrated
  recovery path.
- The project is restored to its initial projection after the stage.

## Stage 3: Stability, crash, and sustained-operation gate

### Purpose

Detect intermittent native-host, lifecycle, IPC, and resource failures that
single functional scenarios cannot expose.

### Repetition matrix

- 1,000 mixed read-only queries distributed across all 17 Query actions.
- 200 ordinary write/Undo cycles distributed across every supported write
  action, with at least three cycles per action.
- 30 linked clone, 30 isolated clone, and 30 Track-shell clone/restore cycles.
- 100 successful dependent transactions and 100 dependent-preflight failures.
- 30 Bridge reloads and 30 Session-invalidation checks.
- 200 concurrent Node requests, verifying serialized single-writer IPC and no
  request loss or overlap.
- At least four continuous hours of mixed read, write, Undo, reload, and idle
  heartbeat operation.

### Crash and recovery criteria

- Zero SynthV native crashes.
- Zero lost or silently overlapping IPC requests.
- Zero automatic retries after claimed-request timeout.
- Zero orphaned request/processing/response files after a clean stop.
- Zero commands that report success when the postcondition differs.
- Every partial-write failure reports exactly one required Undo.
- Crash breadcrumbs are removed after handled success/failure and contain only
  the documented redacted fields.

The prior `0xc0000005` transaction crash blocks stable release unless:

- its reproducible root cause is fixed and the repetition matrix passes; or
- transaction apply/rollback is disabled or clearly removed from the stable
  capability set, after which the remaining matrix passes.

### Performance and resource criteria

- Ordinary real-host operation p95 remains below 300 ms, excluding rendering
  and asynchronous computation completion.
- Trace collection adds less than 5% p95 latency.
- Public response budgets remain satisfied in characters and UTF-8 bytes.
- After warm-up, process memory shows no monotonic growth and returns within
  20% of the settled baseline after each destructive cycle batch.
- Heartbeats do not remain stale beyond the configured recovery window.

## Stage 4: Stable-release decision and delivery

### Purpose

Turn the collected evidence into one unambiguous release decision.

### Release candidates

1. **Full `0.2.0` stable** — all stable actions pass Stages 1–3.
2. **Reduced `0.2.0` stable** — unsafe or unavailable actions are disabled or
   removed from the stable capability set, and all remaining actions pass.
3. **Remain `0.2.0-alpha`** — any native crash, data-integrity defect,
   unrecoverable partial write, privacy leak, or unexplained state drift
   remains.

### Final delivery gate

- Re-run the complete automated gate from a clean checkout.
- Test a clean install and an upgrade over the preceding installed build.
- Verify installation rollback after injected replacement failure.
- Verify that mismatched Node/Lua/Sidebar builds block writes.
- Install the exact release commit and confirm build identity in SynthV.
- Produce a release report with the supported-host matrix, action-status
  matrix, performance distribution, defects, crash evidence, recovery
  evidence, and known limitations.
- Update version, release notes, test matrix, API coverage, and development
  plan only after the evidence supports the selected release candidate.

## Stop conditions

Testing stops immediately when:

- SynthV crashes or stops heartbeating during a command;
- a command returns `undoRequired=true`;
- an unexpected mutation, extra Undo, source-object change, Guard leak, or
  build mismatch occurs;
- the active project is not the declared disposable test copy;
- the Vocal or Vocal Mode context changes during tuning tests.

After a stop, the next action is diagnosis and recovery, not another command.

## Expected outputs

- one executable four-stage test plan;
- one timestamped test evidence report;
- updated action-status and performance matrices;
- defect reports with reproduction and recovery evidence;
- a final Alpha/full-stable/reduced-stable decision.
