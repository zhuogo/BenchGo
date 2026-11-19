import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Official Models store changed: account enrichment');
  return source.replace(before, after);
}

/** Build-only adaptation of the pinned official store; writes remain official. */
export function officialModelsStore() {
  return { name: 'benchgo-official-models-store', setup(build) {
    build.onLoad({ filter: /ui-settings-models[\\/]src[\\/]client[\\/]store\.ts$/ }, async args => {
      let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
      source = once(source, '  /** Latest load wins; an older response never overwrites a newer one. */', `  private accountAvailable = false
  private accountLoad: Promise<void> | undefined
  private accountRow: ProviderRow | undefined
  private accountGeneration = 0
  private accountScope = {}

  /** The account catalog enriches its own row without gating API provider configuration. */
  private refreshAccount(row: ProviderRow, generation: number): void {
    this.accountRow = row
    this.accountGeneration = generation
    if (this.accountLoad) return
    const pending = Promise.resolve().then(() => this.ctx.remote.session.modelCatalog()).then(catalog => {
      if (this.accountLoad !== pending || generation !== this.generation || !catalog.ok) return
      this.accountAvailable = catalog.value.groups.some(group => group.id === 'deepseek-account' && group.models.length > 0)
      if (this.store.getSnapshot().status !== 'ready') return
      this.store.update(s => {
        const others = s.rows.filter(candidate => candidate.entry.provider !== 'deepseek-account')
        s.rows = this.accountAvailable ? [{ ...row, accountAvailable: true }, ...others] : others
      })
    }).catch(() => {
      // A failed background read keeps the last confirmed row; the next load retries.
    }).finally(() => {
      if (this.accountLoad !== pending) return
      this.accountLoad = undefined
      if (generation !== this.generation
        && this.accountGeneration === this.generation && this.accountRow) {
        this.refreshAccount(this.accountRow, this.accountGeneration)
      }
    })
    this.accountLoad = pending
  }

  /** Latest load wins; an older response never overwrites a newer one. */`);
      source = once(source, `    if (rows.some(row => row.entry.provider === 'deepseek-account')) {
      const catalog = await this.ctx.remote.session.modelCatalog()
      for (const row of rows) {
        if (row.entry.provider === 'deepseek-account') row.accountAvailable = catalog.ok
          && catalog.value.groups.some(group => group.id === 'deepseek-account' && group.models.length > 0)
      }
    }`, `    const account = rows.find(row => row.entry.provider === 'deepseek-account')
    if (account) this.refreshAccount(account, generation)
    else { this.accountAvailable = false; this.accountRow = undefined; this.accountGeneration = generation }`);
      source = once(source, "      s.rows = rows.filter(row => row.entry.provider !== 'deepseek-account' || row.accountAvailable === true).map((row) => {\n        if (row.entry.provider === 'deepseek-account') return row", "      s.rows = rows.filter(row => row.entry.provider !== 'deepseek-account' || this.accountAvailable).map((row) => {\n        if (row.entry.provider === 'deepseek-account') return { ...row, accountAvailable: this.accountAvailable }");
      const readStart = source.indexOf('  private async read('), readEnd = source.indexOf('  /** Settle callers', readStart);
      if (readStart < 0 || readEnd < readStart) throw Error('Official Models store changed: read lifecycle');
      const read = source.slice(readStart, readEnd)
        .replace('private async read(generation: number): Promise<void> {', 'private async read(generation: number): Promise<void> {\n    const accountScope = this.accountScope')
        .replaceAll('if (generation !== this.generation) return', 'if (generation !== this.generation || accountScope !== this.accountScope) return');
      source = source.slice(0, readStart) + read + source.slice(readEnd);
      return { contents: source, loader: 'ts', resolveDir: dirname(args.path) };
    });
  } };
}
