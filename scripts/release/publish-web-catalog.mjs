/** Publish original signed catalog bytes on a CORS-readable, append-only branch. */
import { createPublicKey, verify } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { githubJson, assetBytes, sha256 } from './github.mjs';
import { immutableArtifact } from './assemble.mjs';

const branch = 'release-metadata';
const names = ['downloads.json', 'downloads.json.sig'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

export async function publishWebCatalog({ directory, releaseVersion, sourceSha, publicKey,
  request = githubJson, downloadAsset = assetBytes }) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(releaseVersion) || !sha(sourceSha)) throw new Error('Invalid web catalog version or source');
  const tag = `v${releaseVersion}`, bytes = [];
  for (const [index, name] of names.entries()) {
    const path = resolve(directory, name), size = (await stat(path)).size;
    if (size < 1 || size > (index ? 4096 : 512 * 1024)) throw new Error('Web catalog metadata is missing or oversized');
    bytes.push(await readFile(path));
  }
  const trusted = createPublicKey(publicKey ?? await readFile(new URL('../../plugins/benchgo/shared/update-public-key.pem', import.meta.url)));
  if (!verify(null, bytes[0], trusted, Buffer.from(bytes[1].toString('utf8').trim(), 'base64'))) throw new Error('Invalid web catalog signature');
  const catalog = JSON.parse(bytes[0]);
  if (catalog.schemaVersion !== 1 || catalog.releaseVersion !== releaseVersion || catalog.sourceSha !== sourceSha
    || !Array.isArray(catalog.files) || !catalog.files.length) throw new Error('Wrong web catalog source');
  for (const file of catalog.files) immutableArtifact(file);
  const release = await request(`/releases/tags/${tag}`);
  if (!release || release.draft || release.prerelease || release.tag_name !== tag || release.target_commitish !== sourceSha
    || (await request(`/commits/${tag}`)).sha !== sourceSha) throw new Error('Web catalog release does not match public stable source');
  // Exact comparison also works on older GitHub assets without a stored digest.
  for (const [index, name] of names.entries()) {
    const matches = release.assets?.filter(row => row.name === name) ?? [], asset = matches[0];
    if (matches.length !== 1 || asset.size !== bytes[index].length
      || asset.digest && asset.digest !== `sha256:${sha256(bytes[index])}`
      || !(await downloadAsset(asset)).equals(bytes[index])) throw new Error(`Public web catalog bytes differ: ${name}`);
  }
  const send = (path, method, body) => request(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const ref = await request(`/git/ref/heads/${branch}`, { missing: true });
  const head = ref?.object?.sha;
  if (ref && !sha(head)) throw new Error('Invalid web metadata branch head');
  const paths = names.map(name => `releases/${tag}/${name}`), tree = [];
  const check = async (commit, index) => {
    const file = await request(`/contents/${paths[index]}?ref=${commit}`, { missing: true });
    if (!file) return false;
    if (file.type !== 'file' || file.encoding !== 'base64' || file.size !== bytes[index].length
      || !Buffer.from(file.content, 'base64').equals(bytes[index])) throw new Error(`Refusing to overwrite immutable web metadata: ${paths[index]}`);
    return true;
  };
  for (const [index, path] of paths.entries()) {
    if (head && await check(head, index)) continue;
    // Blob API base64 preserves every original byte, including trailing newlines.
    tree.push({ path, mode: '100644', type: 'blob', bytes: bytes[index] });
  }
  if (!tree.length) return { branch, tag, commit: head, changed: false };
  const parent = head ? await request(`/git/commits/${head}`) : null;
  if (parent && !sha(parent.tree?.sha)) throw new Error('Invalid web metadata base tree');
  const entries = [];
  for (const entry of tree) {
    const blob = await send('/git/blobs', 'POST', { content: entry.bytes.toString('base64'), encoding: 'base64' });
    if (!sha(blob?.sha)) throw new Error('Invalid web metadata blob');
    entries.push({ path: entry.path, mode: entry.mode, type: entry.type, sha: blob.sha });
  }
  const nextTree = await send('/git/trees', 'POST', { ...(parent ? { base_tree: parent.tree.sha } : {}), tree: entries });
  if (!sha(nextTree?.sha)) throw new Error('Invalid web metadata tree');
  const commit = await send('/git/commits', 'POST', { message: `Publish signed download catalog ${tag}`, tree: nextTree.sha, parents: head ? [head] : [] });
  if (!sha(commit?.sha)) throw new Error('Invalid web metadata commit');
  // A concurrent update fails closed; never force or discard another release.
  if (head) await send(`/git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha, force: false });
  else await send('/git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha });
  for (const index of names.keys()) if (!await check(commit.sha, index)) throw new Error('Published web metadata verification failed');
  return { branch, tag, commit: commit.sha, changed: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { directory: { type: 'string' }, version: { type: 'string' }, 'source-sha': { type: 'string' } } });
  publishWebCatalog({ directory: values.directory, releaseVersion: values.version, sourceSha: values['source-sha'] })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
