import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { findPreviousRelease, githubJson, repository } from './github.mjs';
import { assertVersionAvailable, createReleasePlan, currentVersions, git, productPaths, releaseChanges, stable, versionFiles } from './plan.mjs';

const workflow = '/actions/workflows/unified-release.yml';
const mainRef = 'refs/heads/main';
const githubUrl = `https://github.com/${repository}`;
const releaseName = version => `BenchGo v${version} (publish)`;
const repoFile = path => new URL(`../../${path}`, import.meta.url);

function requireGitHubAuth() {
  if (!process.env.GH_TOKEN) {
    try { process.env.GH_TOKEN = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { throw new Error('请设置有 GitHub Actions 写入权限的 GH_TOKEN，或通过 gh auth login 登录 GitHub。'); }
  }
  if (!process.env.GH_TOKEN) throw new Error('GitHub 登录未返回可用令牌，请设置 GH_TOKEN。');
}

function verifyReleaseBranch(sourceSha) {
  if (git('branch', '--show-current') !== 'main') throw new Error('正式发布需要本地 main 分支。');
  const allowed = [`${githubUrl}`, `git@github.com:${repository}`, `ssh://git@github.com/${repository}`]
    .map(url => url.toLowerCase());
  for (const options of [['--all'], ['--push', '--all']]) {
    const urls = git('remote', 'get-url', ...options, 'origin').split(/\r?\n/);
    if (urls.length !== 1 || !allowed.includes(urls[0].replace(/\.git$/i, '').toLowerCase())) {
      throw new Error(`origin 必须指向 ${githubUrl}。`);
    }
  }
  const remoteSha = git('ls-remote', '--exit-code', 'origin', mainRef).split(/\s+/)[0];
  try { git('merge-base', '--is-ancestor', remoteSha, sourceSha); }
  catch { throw new Error('本地 main 未包含远端 main 的最新提交，请先同步分支。'); }
}

function requireStagedProductChanges() {
  const unstaged = git('diff', '--name-only', '--ignore-submodules=none', '--', ...productPaths);
  const untracked = git('ls-files', '--others', '--exclude-standard', '--', ...productPaths);
  if (unstaged || untracked) throw new Error('工作区还有未暂存的产品改动。请将要发布的文件 git add 或提交后再运行。');
}

async function writeComponentVersions(current, proposed, builds) {
  const edits = [];
  const read = path => readFile(repoFile(path), 'utf8');
  if (current.windows !== proposed.windows) {
    const manifest = JSON.parse(await read(versionFiles.windows));
    manifest.version = proposed.windows;
    edits.push([versionFiles.windows, `${JSON.stringify(manifest, null, 2)}\n`]);
  }
  if (builds.plugin) {
    const manifest = JSON.parse(await read(versionFiles.plugin));
    const lock = JSON.parse(await read(versionFiles.pluginLock));
    if (manifest.version !== proposed.plugin) {
      manifest.version = proposed.plugin;
      edits.push([versionFiles.plugin, `${JSON.stringify(manifest, null, 2)}\n`]);
    }
    if (lock.version !== proposed.plugin || lock.packages[''].version !== proposed.plugin) {
      lock.version = lock.packages[''].version = proposed.plugin;
      edits.push([versionFiles.pluginLock, `${JSON.stringify(lock, null, 2)}\n`]);
    }
  }
  if (current.android !== proposed.android || current.androidVersionCode !== proposed.androidVersionCode) {
    const gradle = (await read(versionFiles.android))
      .replace(/(\bversionName\s+['"])[^'"]+(['"])/, (_match, prefix, suffix) => `${prefix}${proposed.android}${suffix}`)
      .replace(/(\bversionCode\s+)\d+/, (_match, prefix) => `${prefix}${proposed.androidVersionCode}`);
    edits.push([versionFiles.android, gradle]);
  }
  for (const [path, content] of edits) await writeFile(repoFile(path), content);
  if (edits.length) git('add', '--', ...edits.map(([path]) => path));
}

async function findRun(version, sourceSha) {
  const query = new URLSearchParams({ branch: 'main', event: 'workflow_dispatch', head_sha: sourceSha, per_page: '100' });
  const { workflow_runs: runs } = await githubJson(`${workflow}/runs?${query}`);
  return runs.find(run => run.display_title === releaseName(version));
}

async function waitForRelease(id, version, sourceSha) {
  const url = `${githubUrl}/actions/runs/${id}`;
  let lastStatus;
  console.log(`跟踪 GitHub Actions ${url}`);
  for (;;) {
    const run = await githubJson(`/actions/runs/${id}`);
    if (run.head_sha !== sourceSha || run.display_title !== releaseName(version)) throw new Error(`发布任务与请求的版本或提交不匹配。${url}`);
    if (run.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`发布流程结束，状态为 ${run.conclusion}。${url}`);
      console.log(`BenchGo v${version} 已发布。${githubUrl}/releases/tag/v${version}`);
      return;
    }
    if (run.status !== lastStatus) console.log(`GitHub Actions 状态 ${run.status}`);
    lastStatus = run.status;
    await delay(10_000);
  }
}

async function main() {
  const { values } = parseArgs({ options: { version: { type: 'string' }, 'notes-file': { type: 'string' },
    publish: { type: 'boolean' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('npm run release:update -- --version X.Y.Z [--publish --notes-file <发布说明.md>]');
    return;
  }
  const version = values.version;
  if (!stable(version)) throw new Error('请通过 --version 指定统一发行版本 X.Y.Z。');
  const head = git('rev-parse', 'HEAD');
  let notes;
  if (values.publish) {
    requireStagedProductChanges();
    requireGitHubAuth();
    if (!git('diff', '--cached', '--name-only')) {
      const existing = await findRun(version, head);
      if (existing) return waitForRelease(existing.id, version, head);
    }
    verifyReleaseBranch(head);
    if (!values['notes-file']) throw new Error('正式发布需要通过 --notes-file 指定 UTF-8 发布说明。');
    notes = await readFile(values['notes-file'], 'utf8');
    if (!notes.trim() || notes.length > 16_384) throw new Error('发布说明需要包含 1 至 16384 个字符。');
  }

  await assertVersionAvailable(version);
  const previous = await findPreviousRelease();
  const current = await currentVersions();
  const plan = createReleasePlan({ releaseVersion: version, sourceSha: head, previous, versions: current,
    ...await releaseChanges(previous, head, { workingTree: true }), bumpVersions: true });
  console.log(JSON.stringify({ version, baseline: previous?.tag ?? null, versions: plan.versions, builds: plan.builds, reasons: plan.reasons }, null, 2));
  if (!values.publish) return;

  requireStagedProductChanges();
  if (git('rev-parse', 'HEAD') !== head) throw new Error('生成计划后本地提交发生变化，请重试。');
  await writeComponentVersions(current, plan.versions, plan.builds);
  if (git('diff', '--cached', '--name-only')) git('commit', '-m', `release: prepare BenchGo ${version}`);
  const sourceSha = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain=v1', '--untracked-files=all', '--', ...productPaths)) {
    throw new Error('发布提交后仍有未提交的产品文件，请检查工作区。');
  }
  createReleasePlan({ releaseVersion: version, sourceSha, previous, versions: await currentVersions(),
    ...await releaseChanges(previous, sourceSha) });
  git('push', 'origin', `${sourceSha}:${mainRef}`);
  console.log(`已推送 ${sourceSha} 到 origin/main。`);
  const run = await githubJson(`${workflow}/dispatches`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-api-version': '2026-03-10' },
    body: JSON.stringify({ ref: 'main', inputs: { version, notes, publish: 'true', source_sha: sourceSha } }) });
  if (!Number.isSafeInteger(run?.workflow_run_id)) throw new Error(`GitHub 未返回发布任务 ID，请查看 ${githubUrl}/actions。`);
  await waitForRelease(run.workflow_run_id, version, sourceSha);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
