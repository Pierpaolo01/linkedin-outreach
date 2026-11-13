See [AGENTS.md](AGENTS.md).

## Verification

The app targets macOS, but routine CI runs `npm run verify` on Ubuntu with Node 22 and installed Chrome. This is the principal's 2026-11-13 cost decision and supersedes the handoff's macOS CI requirement.

Keep portable tests in the regular suite, including tests of Mac behavior through injected OS dependencies. Put tests that execute native Mac tools in `*.macos.test.ts`. Run `npm run verify:macos` on the development Mac before shipping changes to Mac integration or its dependencies. There is no paid Mac CI job.
