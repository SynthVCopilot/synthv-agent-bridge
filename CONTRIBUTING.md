# Contributing

1. Use Node.js 20.10 or later and Synthesizer V Studio 2 Pro 2.1.2 or later.
2. Create a focused branch and keep protocol changes backward compatible where possible.
3. Run `npm run check` before opening a pull request.
4. Run `luac5.4 -p synthv/*.lua` when Lua is installed.
5. Test write operations in a copy of a SynthV project and confirm undo behavior.

Do not commit generated `dist/`, local IPC files, user projects, rendered audio, or voice-database assets.

## v3 development workflow

Read [the v3 architecture baseline](docs/architecture-v3.md), its linked
ADRs, [test matrix](docs/v3-test-matrix.md), and
[development plan](docs/v3-development-plan.md) before changing the v3
internals.

Develop one vertical slice at a time:

1. Record the goal, non-goals, aggregate, compatibility requirement, and
   rollback path.
2. Add a regression or acceptance test before changing behavior.
3. Preserve the six-tool MCP v3 surface and file IPC protocol v3.
4. Run the automated checks.
5. Test project writes in a saved SynthV working copy and record Undo and
   postcondition results.
