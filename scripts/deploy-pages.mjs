#!/usr/bin/env node
/**
 * Fallback deployment for GitHub Pages when the repo is set to
 * "Deploy from a branch" instead of "GitHub Actions".
 *
 *   npm run deploy
 *
 * Builds dist/ and force-pushes its contents to the `gh-pages` branch.
 * Then set: Settings → Pages → Build and deployment → Source: "Deploy from a
 * branch", Branch: `gh-pages`, folder: `/ (root)`.
 *
 * Optional automation: copy deploy/github-pages.yml into .github/workflows/ and
 * switch Pages to "GitHub Actions" (see README → GitHub Pages).
 */
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, cpSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BRANCH = 'gh-pages';
const root = resolve(process.cwd());
const dist = join(root, 'dist');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

console.log('→ build');
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build']);
if (!existsSync(join(dist, 'index.html'))) throw new Error('dist/index.html missing — build failed');

const remote = execSync('git remote get-url origin', { cwd: root }).toString().trim();
if (!remote) throw new Error('no git remote "origin"');

const tmp = mkdtempSync(join(tmpdir(), 'rcn-pages-'));
try {
  cpSync(dist, tmp, { recursive: true });
  console.log(`→ publish ${tmp} → origin/${BRANCH}`);
  const git = (...args) => execFileSync('git', args, { stdio: 'inherit', cwd: tmp });
  git('init', '-q', '-b', BRANCH);
  git('add', '-A');
  git('-c', 'user.name=rcn-deploy', '-c', 'user.email=deploy@local',
    'commit', '-q', '-m', `build: ${new Date().toISOString()}`);
  git('remote', 'add', 'origin', remote);
  git('push', '-f', 'origin', `HEAD:${BRANCH}`);
  console.log(`✔ wypchnięte na ${BRANCH}. Ustaw Settings → Pages → Source: Deploy from a branch → ${BRANCH} / (root)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
