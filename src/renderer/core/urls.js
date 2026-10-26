// Where the editor loads its own files from: the mide:// protocol in the app, or ordinary web
// URLs in the browser demo, whose stand-in for window.native carries a `web` section.
const web = () => window.native.web;

/** A file in the user's settings folder (styles.css, init.js), always fresh. */
export const userFileUrl = (name) => web()?.userFileUrl(name) ?? `mide://user/${name}?v=${Date.now()}`;

/** Base URL for a package's files: a fresh module graph per activation in the app. */
export const packageUrl = (name) => web()?.packageUrl(name) ?? `mide://pkg/${encodeURIComponent(name)}/~${Date.now()}/`;
