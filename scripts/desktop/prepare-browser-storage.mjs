import { resolve } from 'node:path';

const partition = 'persist:benchgo-sidebar-browser';

function replaceOnce(source, before, after, file) {
  if (source.split(before).length !== 2) {
    throw new Error(`Official ${file} changed; review sidebar browser storage integration`);
  }
  return source.replace(before, after);
}

const inputs = {
  'browser-guests.js': [
    ['/** Owns workspace storage partitions independently from individual tab guests. */',
      `const BROWSER_PARTITION = '${partition}';\n/** Owns the shared browser partition and individual tab leases. */`],
    ['    partitions = new Map();\n', ''],
    ['        this.hostUrl = hostUrl;',
      '        this.hostUrl = hostUrl;\n        this.configureSession(session.fromPartition(BROWSER_PARTITION));'],
    [`    /**
     * Reserve one guest in a workspace's process-lifetime partition.
     * @param owner - authenticated primary application WebContents.
     * @param workspace - workspace identity received over IPC.
     * @returns opaque lease and the partition approved for it.
     */
    acquire(owner, workspace) {
        if (typeof workspace !== 'string' || workspace.length === 0 || workspace.length > 4096) {
            throw new Error('desktop browser: a workspace storage identity is required');
        }
        let partition = this.partitions.get(workspace);
        if (partition === undefined) {
            partition = \`dsh-sidebar-browser-\${randomUUID()}\`;
            this.configureSession(session.fromPartition(partition));
            this.partitions.set(workspace, partition);
        }
        const lease = randomUUID();
        this.leases.set(lease, { owner, partition, attached: false });
        return { lease, partition };
    }`, `    /** Reserve an individual guest in the shared local browser partition. */
    acquire(owner) {
        const lease = randomUUID();
        this.leases.set(lease, { owner, attached: false });
        return { lease, partition: BROWSER_PARTITION };
    }`],
    ['workspace storage survives', 'browser storage survives'],
    ['params.partition !== lease.partition', 'params.partition !== BROWSER_PARTITION'],
    ['partition: lease.partition', 'partition: BROWSER_PARTITION'],
  ],
  'main.js': [
    [`    ipcMain.handle(DESKTOP_IPC.browserAcquire, (event, workspace) => {
        assertProductSender(event);
        return browserGuests.acquire(event.sender, workspace);
    });`, `    ipcMain.handle(DESKTOP_IPC.browserAcquire, (event) => {
        assertProductSender(event);
        return browserGuests.acquire(event.sender);
    });`],
  ],
  'preload-browser.js': [
    ['acquire: workspace => ipcRenderer.invoke(DESKTOP_IPC.browserAcquire, workspace),',
      'acquire: () => ipcRenderer.invoke(DESKTOP_IPC.browserAcquire),'],
  ],
};

/** Compile the native storage policy into the staged shell using the pinned official inputs. */
export function browserStoragePlugin(desktop, { preload = false } = {}) {
  const files = preload ? ['preload-browser.js'] : ['browser-guests.js', 'main.js'];
  const paths = new Map(files.map(file => [resolve(desktop, 'lib/types', file), file]));
  const pending = new Set();
  return {
    name: preload ? 'benchgo-browser-storage-preload' : 'benchgo-browser-storage-main',
    buildStart() {
      for (const file of files) pending.add(file);
    },
    transform(source, id) {
      const file = paths.get(resolve(id));
      if (!file) return null;
      if (!pending.delete(file)) throw new Error(`Duplicate sidebar browser storage input: ${file}`);
      let code = source.replaceAll('\r\n', '\n');
      for (const [before, after] of inputs[file]) code = replaceOnce(code, before, after, file);
      return { code, map: null };
    },
    generateBundle() {
      if (pending.size) throw new Error(`Missing sidebar browser storage inputs: ${[...pending].join(', ')}`);
    },
  };
}

export function verifyBrowserStorageBundle(main, preload) {
  if (!main.includes(partition) || main.includes('dsh-sidebar-browser-')
    || !main.includes('browserGuests.acquire(event.sender)')) {
    throw new Error('Compiled desktop must use one persistent sidebar browser partition');
  }
  if (!/acquire:\s*\(\)\s*=>\s*[^\n]*invoke\(DESKTOP_IPC\.browserAcquire\)/.test(preload)) {
    throw new Error('Compiled sidebar browser preload must acquire without a workspace identity');
  }
}
