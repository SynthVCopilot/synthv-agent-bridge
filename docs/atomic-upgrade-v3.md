# v3 Atomic Upgrade and Rollback

Status: required release procedure

Node and the Lua executor form the write-critical build set. The optional
connection-only Sidebar is versioned and diagnosed separately.

The atomic installer, staged-hash verification, backup restoration, runtime
coherence gate, and executor-mismatch write rejection are implemented in
`0.2.0-alpha.1`. A package is not considered installed merely because files
were copied; the active Lua executor must be reloaded and report the matching
Build ID. A mismatched optional Sidebar is reported but cannot block writes,
because it no longer participates in review or command dispatch.

## Build-time identity

The package injects:

- semantic package version;
- Git commit when available;
- optional GitHub run number and attempt;
- protocol and action-catalog digests;
- Node runtime, Lua executor, and Sidebar source digests.

Runtime behavior is network-free and does not invoke Git or GitHub.

## Installation

1. Build and test the Node package.
2. Stage the Lua executor, stop script, and Sidebar in a temporary sibling
   directory.
3. Verify every staged source hash against the generated manifest.
4. Move the installed set to one backup directory.
5. Replace the complete installed set from staging.
6. Verify the installed hashes.
7. Remove the backup only after successful verification.

If replacement or verification fails, remove the incomplete installed set and
restore the backup. Never leave a mixed component set as a successful install.

## Runtime gate

`sv_status` compares the Node build with the active executor. An executor
mismatch permits status/query diagnostics but blocks project commands with
reinstall/reload guidance. Optional Sidebar identity is diagnostic-only;
whether it is absent, stale, or mismatched does not change `writesAllowed`.

## Manual rollback

Stop the persistent Bridge, reinstall one complete known-good package, reload
the Lua executor, then confirm `coherence.state=matched` before issuing a
project command. Reload the optional Sidebar when its independent diagnostic
shows a mismatch. Protocol v2 is not a fallback mode.

## Release acceptance record

For each release candidate record:

- source commit and generated Node/Lua/Sidebar Build IDs;
- installer target and staged/installed manifest verification;
- active `sv_status` coherence after SynthV script reload and MCP restart;
- confirmation that a deliberately mixed Node/executor build blocks
  `writeIntent` and `sv_command`, while a Sidebar-only mismatch does not;
- the bounded real-host Query/Command matrix and its Undo recovery result.

The previous installed set remains the rollback unit until all five checks
pass.
