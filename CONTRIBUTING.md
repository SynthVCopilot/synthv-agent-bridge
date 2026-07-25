# Contributing

1. Use Node.js 20.10 or later and Synthesizer V Studio 2 Pro 2.1.1 or later.
2. Create a focused branch and keep protocol changes backward compatible where possible.
3. Run `npm run check` before opening a pull request.
4. Run `luac5.4 -p synthv/*.lua` when Lua is installed.
5. Test write operations in a copy of a SynthV project and confirm undo behavior.

Do not commit generated `dist/`, local IPC files, user projects, rendered audio, or voice-database assets.
