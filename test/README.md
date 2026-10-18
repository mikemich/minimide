# End-to-end tests

The tests drive the real app. Each suite is a script that runs inside the editor window, uses the
app the way a person would, and returns a JSON results object that the runner checks.

## Running

```sh
npm test                          # build, then run every suite
node test/run.mjs handsOn core    # just these suites (dependencies such as sessionSave are added)
node test/run.mjs --no-build      # skip `node build.mjs`
node test/run.mjs --keep          # keep the fixture dir even when everything passes
```

On Linux without a display, run under a virtual X server: `xvfb-run -a npm test` (the runner
re-runs itself under `xvfb-run` when it finds one and there is no `DISPLAY`).

Every run creates fresh fixtures in a temp dir (`test/fixtures.mjs`). Logs and screenshots of each
suite land in `test/output/<suite>.{log,png}` (git-ignored).

Some suites need tools on `PATH` and are reported as `SKIP` without them: `lspPaths` needs
`typescript-language-server` (`npm i -g typescript typescript-language-server`), `terminal` needs
`python3` and `cc`.

## How it works

`test/run.mjs` launches Electron once per suite with the dev-build test hooks from
`src/main/main.js`:

| Variable | Meaning |
| --- | --- |
| `MINIMIDE_HOME` | user dir to use instead of `~/.minimide` (config, packages, state) |
| `MINIMIDE_EVAL` | the suite script, evaluated in the renderer; its result is printed as `[eval] <json>` |
| `MINIMIDE_SCREENSHOT` | where to write a screenshot before the app quits |
| `MINIMIDE_SCREENSHOT_DELAY` | ms to wait after load before running the script (default 2500) |

In test mode `window.mideTest.answers(kind, ...values)` queues answers for native dialogs
(`confirm`, `saveAs`, `openFolder`, `openFile`), and `window.minimide` is the app.

A suite passes when its result has no `THREW` / `ERR ` values, no non-empty `errors`/`errs`
arrays, `totalErrors` is 0 (when present), and every entry in its `expect` map holds.

## Adding a suite

1. Write `test/suites/<name>.js`: an async IIFE that returns a JSON-able object. Copy the helpers
   (`wait`, `until`, error capture, `MOD` for Cmd on macOS / Ctrl elsewhere) from an existing suite.
2. If it needs files, add a fixture project (and a home dir if it needs a seeded `~/.minimide`) in
   `test/fixtures.mjs`.
3. Add an entry to `SUITES` in `test/run.mjs`: `name`, `home`, `project`, `timeout` (seconds),
   optional `delay`, `requires` (programs on PATH), `dependsOn`, and `expect`, a function of `env`
   returning `{ 'dotted.path': expected }`. Expected values can be literals (compared as JSON),
   RegExps or predicate functions.
4. A check that fails because of an app bug that is not fixed yet can go in `knownIssues`
   (`{ 'dotted.path': 'what is wrong' }`): it is reported without failing the run, and flagged
   once it passes so the entry can be removed.

To debug a suite by hand: `node test/fixtures.mjs /tmp/fx`, then
`MINIMIDE_HOME=/tmp/fx/qah MINIMIDE_SCREENSHOT=/tmp/s.png MINIMIDE_EVAL=test/suites/handsOn.js npx electron . --mide-test /tmp/fx/qa`.
