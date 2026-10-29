// The only bridge between the renderer and Node. Everything here is async.
const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

function on(channel, fn) {
  const listener = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('native', {
  fs: {
    read: call('fs:read'),
    readDataUrl: call('fs:readDataUrl'),
    writeDataUrl: call('fs:writeDataUrl'),
    write: call('fs:write'),
    readdir: call('fs:readdir'),
    stat: call('fs:stat'),
    mkdir: call('fs:mkdir'),
    rename: call('fs:rename'),
    copy: call('fs:copy'),
    trash: call('fs:trash'),
    removeHistory: call('fs:removeHistory'),
    realpath: call('fs:realpath'),
    watch: call('fs:watch'),
    onChange: (fn) => on('fs:changed', fn),
    onWatchLimited: (fn) => on('fs:watchLimited', fn),
    // The path of a File dropped on the window ('' for one that isn't on disk).
    pathForFile: (file) => webUtils.getPathForFile(file),
  },
  project: {
    files: call('project:files'),
    search: call('project:search'),
    initial: call('project:initial'),
  },
  dialog: {
    openFolder: call('dialog:openFolder'),
    openFile: call('dialog:openFile'),
    saveAs: call('dialog:saveAs'),
    confirm: call('dialog:confirm'),
  },
  menu: { popup: call('menu:popup'), setAccelerators: call('menu:set-accelerators') },
  pkgmgr: {
    stage: call('pkgmgr:stage'),
    install: call('pkgmgr:install'),
    discard: call('pkgmgr:discard'),
    uninstall: call('pkgmgr:uninstall'),
    grant: call('pkgmgr:grant'),
    checkUpdates: call('pkgmgr:checkUpdates'),
    search: call('pkgmgr:search'),
    permissions: call('pkgmgr:permissions'),
  },
  net: { fetch: call('net:fetch') },
  // Import from VS Code: read-only, limited to its settings and color themes.
  vscode: { scan: call('vscode:scan'), read: call('vscode:read'), theme: call('vscode:theme') },
  // Secrets can be stored and deleted but never read back; the gist calls use the token in the main process.
  secrets: { set: call('secrets:set'), has: call('secrets:has'), delete: call('secrets:delete') },
  gist: {
    status: call('gist:status'),
    cliAvailable: call('gist:cliAvailable'),
    cliLogin: call('gist:cliLogin'),
    upload: call('gist:upload'),
    download: call('gist:download'),
    forget: call('gist:forget'),
  },
  remote: {
    connect: call('remote:connect'),
    lookup: call('remote:lookup'),
    sync: call('remote:sync'),
    push: call('remote:push'),
    pull: call('remote:pull'),
    disconnect: call('remote:disconnect'),
    terminalCommand: call('remote:terminalCommand'),
  },
  trust: { list: call('trust:list'), add: call('trust:add'), remove: call('trust:remove'), onChange: (fn) => on('trust:changed', fn) },
  updates: {
    check: call('update:check'),
    prepare: call('update:prepare'),
    staged: call('update:staged'),
    restart: call('update:restart'),
    onProgress: (fn) => on('update:progress', fn),
  },
  shell: {
    openExternal: call('shell:openExternal'),
    reveal: call('shell:reveal'),
    openPath: call('shell:openPath'),
  },
  clipboard: { write: call('clipboard:write'), read: call('clipboard:read'), writeImage: call('clipboard:writeImage') },
  // Chromium's spell checker, for the right-click menu: is this word misspelled, and what could it be?
  spell: {
    check: (word) => (webFrame.isWordMisspelled(word) ? { misspelled: true, suggestions: webFrame.getWordSuggestions(word) } : { misspelled: false, suggestions: [] }),
    addWord: call('spell:addWord'),
  },
  proc: {
    exec: call('proc:exec'),
    spawn: call('proc:spawn'),
    write: call('proc:write'),
    kill: call('proc:kill'),
    spawnRpc: call('proc:spawnRpc'),
    send: call('proc:send'),
    onMessage: (fn) => on('proc:message', fn),
    onData: (fn) => on('proc:data', fn),
    onExit: (fn) => on('proc:exit', fn),
  },
  term: {
    available: call('term:available'),
    create: call('term:create'),
    write: call('term:write'),
    resize: call('term:resize'),
    kill: call('term:kill'),
    onData: (fn) => on('term:data', fn),
    onExit: (fn) => on('term:exit', fn),
  },
  user: { info: call('user:info') },
  ai: {
    status: call('ai:status'),
    setKey: call('ai:set-key'),
    clearKey: call('ai:clear-key'),
    start: call('ai:start'),
    cancel: call('ai:cancel'),
    onEvent: (fn) => on('ai:event', fn),
  },
  packages: { list: call('packages:list') },
  state: { load: call('state:load'), save: call('state:save') },
  window: {
    newWindow: call('window:new'),
    setTitle: call('window:setTitle'),
    setProject: call('window:setProject'),
    close: call('window:close'),
    cancelClose: call('window:cancelClose'),
    toggleDevTools: call('window:toggleDevTools'),
    reload: call('window:reload'),
    onCommand: (fn) => on('app:command', fn),
    setAppIcon: call('window:setAppIcon'),
    onRequestClose: (fn) => on('app:request-close', fn),
    onOpenPath: (fn) => on('app:open-path', fn),
  },
});

// Automated tests only (the main process passes --mide-test when launched in test mode).
if (process.argv.includes('--mide-test')) {
  contextBridge.exposeInMainWorld('mideTest', {
    answers: (kind, ...values) => ipcRenderer.invoke('test:answers', kind, values),
    capture: () => ipcRenderer.invoke('test:capture'),
    menus: () => ipcRenderer.invoke('test:menus'),
  });
}
