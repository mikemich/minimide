# Releasing Minimide

Releases are built by GitHub Actions from a `v*` tag and stay drafts until someone checks them.
Published releases are immutable, so check before publishing.

1. **Start from a green `master`.** `git status` is clean, and `npm test`, `npm run test:web` and `npm run test:themes`
   pass (the Test workflow runs them on every push).

2. **Bump the version.**

   ```bash
   npm version 0.2.8 --no-git-tag-version
   ```

   npm's `version` hook rebuilds the browser demo in `docs/try/` with the new version number and
   stages it. Commit and push:

   ```bash
   git add package.json package-lock.json
   git commit -m "v0.2.8"
   git push origin master
   ```

   GitHub Pages then serves the updated demo at https://mikemich.github.io/minimide/try/.

3. **Write the notes and create a draft**, then push the tag. The Release workflow builds macOS,
   Windows and Linux and attaches the files to the draft.

   ```bash
   gh release create v0.2.8 --draft --title "Minimide 0.2.8" --notes-file notes.md --target master
   git tag v0.2.8
   git push origin v0.2.8
   ```

   Notes follow the earlier releases: a **New** section, **Fixes** if there are any, and the
   **Update** section with the install command.

4. **Check the build** once the workflow is green: download the Mac zip from the draft, then

   ```bash
   ditto -x -k Minimide-0.2.8-arm64-mac.zip x
   codesign --verify --deep --strict x/Minimide.app
   plutil -extract CFBundleShortVersionString raw x/Minimide.app/Contents/Info.plist
   ```

   and open it once to see that it starts.

5. **Publish.**

   ```bash
   gh release edit v0.2.8 --draft=false --latest
   ```

   Installed copies pick it up from **Check for Updates…** (and on their own within a day).

6. **Update the site** (`docs/index.html`) if the release adds something worth showing.
