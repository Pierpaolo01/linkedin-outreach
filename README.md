# linkedin-outreach

A local web app that runs LinkedIn outreach through a dedicated Chrome window. Private.

See [docs/spec-v1.2.md](docs/spec-v1.2.md) and [docs/handoff.md](docs/handoff.md).

## Verification

Use Node 22 and npm. After `npm ci`, `npm run verify` runs typechecking, lint, portable unit and fixture tests, the UI build and fake-driver dashboard tests. The browser tests need installed Google Chrome. GitHub runs this command on Ubuntu; no real LinkedIn account is used.

On the development Mac, run `npm run verify:macos` before shipping changes to Mac integration or its dependencies. This runs the regular checks plus `npm run test:macos`, which validates the launchd property list with `plutil` and checks real `caffeinate` cleanup. The native command fails explicitly on other operating systems. The app still targets macOS; Linux CI does not establish support for installing the app on Linux.
