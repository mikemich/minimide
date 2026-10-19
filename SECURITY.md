# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue: use
**[Report a vulnerability](https://github.com/mikemich/minimide/security/advisories/new)**
on GitHub. Include what you found, how to reproduce it, and which version you used.
You'll get a reply as soon as possible, and credit in the release notes if you'd like.

## Supported versions

Only the latest release gets security fixes. Minimide updates itself
(**Check for Updates…** in the app menu).

## What Minimide protects

- **Folders you open.** git and language servers can run code that comes with a
  repository, so they only run in folders you've chosen to trust (workspace trust).
- **Packages you install.** Installed packages run in a sandboxed worker with no access
  to your files, programs or the internet beyond the permissions you approve when you
  install them. See [the sandbox docs](docs/PLUGINS.md#sharing-packages-and-the-sandbox).
- **Updates.** Downloads are checked against the SHA-256 that GitHub publishes for each
  release file, and releases are immutable once published.

Packages you write yourself, and your `~/.minimide/init.js`, run with full access, like
the rest of your own code.
