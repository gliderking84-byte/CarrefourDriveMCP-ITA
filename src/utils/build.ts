import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which code is running: the git commit of the checkout (when there is one) and whether the
 * build in dist/ is older than the sources — a `git pull` without `npm run build` keeps
 * running the old code, which is easy to miss.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function gitCommit(): string | undefined {
  try {
    const head = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    if (!head.startsWith('ref: ')) return head.slice(0, 7);
    const ref = head.slice(5);
    const loose = join(ROOT, '.git', ref);
    if (existsSync(loose)) return readFileSync(loose, 'utf8').trim().slice(0, 7);
    const packed = readFileSync(join(ROOT, '.git', 'packed-refs'), 'utf8');
    const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
    return line ? line.slice(0, 7) : undefined;
  } catch {
    return undefined;
  }
}

function newest(dir: string, ext: RegExp): number {
  let max = 0;
  if (!existsSync(dir)) return max;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) max = Math.max(max, newest(path, ext));
    else if (ext.test(entry.name)) max = Math.max(max, statSync(path).mtimeMs);
  }
  return max;
}

export interface BuildInfo {
  commit?: string;
  /** true when a source file is newer than the newest built file: run `npm run build`. */
  stale: boolean;
}

export function buildInfo(): BuildInfo {
  const src = newest(join(ROOT, 'src'), /\.ts$/);
  const dist = newest(join(ROOT, 'dist'), /\.js$/);
  return { commit: gitCommit(), stale: src > 0 && dist > 0 && src > dist + 1000 };
}
