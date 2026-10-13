// The only bridge between the renderer and Node. Everything here is async.
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

function on(channel, fn) {
  const listener = (_e, ...args) => fn(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('native', {
  fs: {
    read: call('fs:read'),
    write: call('fs:write'),
    readdir: call('fs:readdir'),
    stat: call('fs:stat'),
    mkdir: call('fs:mkdir'),
    rename: call('fs:rename'),
    trash: call('fs:trash'),
    watch: call('fs:watch'),
    onChange: (fn) => on('fs:changed', fn),
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
  menu: { popup: call('menu:popup') },
  shell: {
    openExternal: call('shell:openExternal'),
    reveal: call('shell:reveal'),
    openPath: call('shell:openPath'),
  },
  clipboard: { write: call('clipboard:write'), read: call('clipboard:read') },
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
  user: { info: call('user:info') },
  packages: { list: call('packages:list') },
  state: { load: call('state:load'), save: call('state:save') },
  window: {
    newWindow: call('window:new'),
    setTitle: call('window:setTitle'),
    setProject: call('window:setProject'),
    close: call('window:close'),
    toggleDevTools: call('window:toggleDevTools'),
    reload: call('window:reload'),
    onCommand: (fn) => on('app:command', fn),
    onRequestClose: (fn) => on('app:request-close', fn),
  },
});
