// Workspace trust. Tools such as git and language servers can run code that a folder provides
// (a command in .git/config, a TypeScript copy in node_modules, a Rust build script…). So the
// first time you open a folder, Minimide asks whether you trust it; until you do, packages that
// run those tools stay off for it ("Restricted Mode"). Reading and editing always work.
import { Emitter } from './events.js';

const FOLD_CASE = /mac|win/i.test(navigator.platform);
function within(path, dir) {
  if (!path || !dir) return false;
  const a = FOLD_CASE ? path.toLowerCase() : path;
  const b = (FOLD_CASE ? dir.toLowerCase() : dir).replace(/\/+$/, '');
  return a === b || a.startsWith(b + '/');
}

export class Trust extends Emitter {
  constructor(app) {
    super();
    this.app = app;
    this.folders = [];
  }

  async init() {
    this.folders = await window.native.trust.list();
    window.native.trust.onChange((list) => { this.folders = list; this.emit('changed'); });
  }

  get enabled() {
    return !this.app.userInfo.trustAll && this.app.config.get('security.workspaceTrust') !== false;
  }

  /** Is this path (default: the open project) inside a trusted folder? */
  isTrusted(path = this.app.workspace.project) {
    if (!this.enabled) return true;
    if (!path) return false;
    return this.folders.some((t) => within(path, t.path) || within(path, t.real));
  }

  async trust(folder) {
    this.folders = await window.native.trust.add(folder);
    this.emit('changed');
  }

  async untrust(folder) {
    this.folders = await window.native.trust.remove(folder);
    this.emit('changed');
  }

  /** Asks about `folder`. Returns true if it's trusted afterwards. */
  async prompt(folder = this.app.workspace.project) {
    if (!folder || this.isTrusted(folder)) return true;
    const name = folder.split('/').filter(Boolean).pop() || folder;
    const parent = folder.replace(/\/[^/]+\/?$/, '') || '/';
    const choice = await window.native.dialog.confirm({
      type: 'question',
      message: `Do you trust the files in “${name}”?`,
      detail: 'Minimide runs git and language servers for folders you trust. Those tools can run code that comes with a folder, for example from its git settings or its node_modules.\n\n'
        + 'In Restricted Mode they stay off. You can still read and edit everything, and trust the folder later from the status bar.',
      buttons: ['Trust Folder', `Trust Everything in “${parent.split('/').pop() || parent}”`, 'Restricted Mode'],
      cancelId: 2,
    });
    if (choice === 0) await this.trust(folder);
    else if (choice === 1) await this.trust(parent);
    return this.isTrusted(folder);
  }
}
