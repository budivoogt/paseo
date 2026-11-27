import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export const COW_SEED_MARKER = "cow-seed";
const COW_SEED_MODULES_LOCK_MARKER = "cow-seed-modules-lock";

export const DEFAULT_SHARED_HIDDEN_DIRS = new Set([
  ".svelte-kit",
  ".turbo",
  ".next",
  ".nuxt",
  ".parcel-cache",
]);

const HARD_DENY_NAMES = new Set([
  ".git",
  ".git-cow",
  ".cow-seed",
  ".paseo",
  ".claude",
  ".codex",
  ".aws",
  ".cursor",
  ".agent-hold",
  "docker-compose.override.yml",
  "docker-compose.override.yaml",
]);

export interface CowExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
}

export type CowExec = (
  program: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
) => CowExecResult;

export interface ReflinkProbeResult {
  supported: boolean;
  mechanism: "clone" | "reflink" | null;
  reason: string | null;
}

export interface CowWorktreeMaterializeResult {
  mechanism: "clone" | "reflink" | "plain";
  fallbackReason: string | null;
  seedDir: string | null;
  clonedEntries: string[];
  lockfileMatched: boolean;
}

function defaultExec(
  program: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number },
): CowExecResult {
  const res = spawnSync(program, args, {
    encoding: "utf8",
    cwd: options?.cwd,
    timeout: options?.timeoutMs ?? 120_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    error: res.error ?? null,
  };
}

function runGitSync(cwd: string, args: string[], exec: CowExec): string {
  const res = exec("git", [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-C",
    cwd,
    ...args,
  ]);
  if (res.error || res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr || res.stdout).trim()}`);
  }
  return res.stdout.trim();
}

export function cloneEntryCommand(
  platform: NodeJS.Platform = process.platform,
): { program: string; args: string[] } | null {
  if (platform === "darwin") return { program: "/bin/cp", args: ["-c", "-R", "-p"] };
  if (platform === "linux") return { program: "cp", args: ["-a", "--reflink=always"] };
  return null;
}

export function isExcludedCowEntry(
  name: string,
  trackedTopLevel: Set<string>,
  sharedHiddenDirs: Set<string> = DEFAULT_SHARED_HIDDEN_DIRS,
): boolean {
  if (!name || name === "." || name === "..") return true;
  if (HARD_DENY_NAMES.has(name)) return true;
  if (name.toLowerCase().includes(".env")) return true;
  if (/^docker-compose\.override\.ya?ml$/i.test(name)) return true;
  if (name.startsWith(".")) {
    return !sharedHiddenDirs.has(name) && !trackedTopLevel.has(name);
  }
  return false;
}

export function supportsReflink(
  directory: string,
  options?: { platform?: NodeJS.Platform; exec?: CowExec },
): ReflinkProbeResult {
  const platform = options?.platform ?? process.platform;
  const spec = cloneEntryCommand(platform);
  if (!spec) return { supported: false, mechanism: null, reason: "unsupported-platform" };
  mkdirSync(directory, { recursive: true });
  const token = randomUUID();
  const src = join(directory, `.paseo-cow-probe-src-${token}`);
  const dst = join(directory, `.paseo-cow-probe-dst-${token}`);
  try {
    writeFileSync(src, "cow-probe\n", { mode: 0o600 });
    const res = (options?.exec ?? defaultExec)(spec.program, [...spec.args, src, dst], {
      timeoutMs: 10_000,
    });
    if (!res.error && res.status === 0 && existsSync(dst)) {
      return {
        supported: true,
        mechanism: platform === "darwin" ? "clone" : "reflink",
        reason: null,
      };
    }
    return { supported: false, mechanism: null, reason: "reflink-unsupported" };
  } catch {
    return { supported: false, mechanism: null, reason: "probe-failed" };
  } finally {
    rmSync(src, { force: true });
    rmSync(dst, { force: true });
  }
}

function fileSha256(filePath: string): string | null {
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function topLevelTrackedEntries(cwd: string, exec: CowExec): Set<string> {
  const res = exec(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", cwd, "ls-files", "-z"],
    { timeoutMs: 30_000 },
  );
  if (res.error || res.status !== 0) return new Set();
  const names = new Set<string>();
  for (const entry of res.stdout.split("\0")) {
    if (!entry) continue;
    const slash = entry.indexOf("/");
    names.add(slash === -1 ? entry : entry.slice(0, slash));
  }
  return names;
}

function acquireSeedLock(seedDir: string): () => void {
  const lockDir = `${seedDir}.lock`;
  mkdirSync(dirname(lockDir), { recursive: true });
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(join(lockDir, "pid"), `${process.pid}\n`, { mode: 0o600 });
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 10 * 60_000) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Ignore stat race during stale lock cleanup.
      }
      if (Date.now() >= deadline) {
        throw new Error("cow-seed-lock-timeout", { cause: error });
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function markCowSeed(seedDir: string, exec: CowExec): string {
  const gitDir = runGitSync(seedDir, ["rev-parse", "--path-format=absolute", "--git-dir"], exec);
  writeFileSync(join(gitDir, COW_SEED_MARKER), `${new Date().toISOString()}\n`, { mode: 0o600 });
  return gitDir;
}

function readSeedModulesLock(gitDir: string): string | null {
  try {
    const value = readFileSync(join(gitDir, COW_SEED_MODULES_LOCK_MARKER), "utf8").trim();
    return /^[0-9a-f]{64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function writeSeedModulesLock(gitDir: string, digest: string | null): void {
  const file = join(gitDir, COW_SEED_MODULES_LOCK_MARKER);
  if (!digest) {
    rmSync(file, { force: true });
    return;
  }
  writeFileSync(file, `${digest}\n`, { mode: 0o600 });
}

function seedNodeModules(
  cwd: string,
  seedDir: string,
  gitDir: string,
  spec: { program: string; args: string[] },
  exec: CowExec,
): void {
  const srcLock = fileSha256(join(cwd, "pnpm-lock.yaml"));
  const dstLock = fileSha256(join(seedDir, "pnpm-lock.yaml"));
  const srcModules = join(cwd, "node_modules");
  if (!srcLock || !dstLock || srcLock !== dstLock || !existsSync(srcModules)) return;
  const dstModules = join(seedDir, "node_modules");
  const cloneModules = exec(spec.program, [...spec.args, srcModules, dstModules]);
  if (!cloneModules.error && cloneModules.status === 0) {
    writeSeedModulesLock(gitDir, dstLock);
    return;
  }
  rmSync(dstModules, { recursive: true, force: true });
  writeSeedModulesLock(gitDir, null);
}

function ensureCowSeed(
  cwd: string,
  seedDir: string,
  spec: { program: string; args: string[] },
  exec: CowExec,
): { seedHead: string; seedLock: string | null; seedHasModules: boolean } {
  const targetCommit = runGitSync(cwd, ["rev-parse", "HEAD"], exec);
  let gitDir: string;
  if (!existsSync(join(seedDir, ".git"))) {
    rmSync(seedDir, { recursive: true, force: true });
    runGitSync(cwd, ["worktree", "add", "--detach", "--quiet", seedDir, targetCommit], exec);
    gitDir = markCowSeed(seedDir, exec);
    seedNodeModules(cwd, seedDir, gitDir, spec, exec);
  } else {
    gitDir = markCowSeed(seedDir, exec);
    const currentLock = fileSha256(join(seedDir, "pnpm-lock.yaml"));
    const installedLock = readSeedModulesLock(gitDir);
    if (installedLock && currentLock && installedLock !== currentLock) {
      rmSync(join(seedDir, "node_modules"), { recursive: true, force: true });
      writeSeedModulesLock(gitDir, null);
    }
  }
  const seedLock = readSeedModulesLock(gitDir);
  return {
    seedHead: runGitSync(seedDir, ["rev-parse", "HEAD"], exec),
    seedLock,
    seedHasModules: Boolean(seedLock) && existsSync(join(seedDir, "node_modules")),
  };
}

function cloneSeedEntries(
  seedDir: string,
  worktreePath: string,
  spec: { program: string; args: string[] },
  exec: CowExec,
): { clonedEntries: string[]; excludedTracked: string[] } {
  const tracked = topLevelTrackedEntries(seedDir, exec);
  const excludedTracked = [...tracked].filter((name) => isExcludedCowEntry(name, tracked));
  const clonedEntries: string[] = [];
  for (const entry of readdirSync(seedDir, { withFileTypes: true })) {
    if (isExcludedCowEntry(entry.name, tracked)) continue;
    const src = join(seedDir, entry.name);
    const dst = join(worktreePath, entry.name);
    if (existsSync(dst)) continue;
    const res = exec(spec.program, [...spec.args, src, dst]);
    if (res.error || res.status !== 0) {
      throw new Error(`clone ${entry.name} failed: ${(res.stderr || res.stdout).trim()}`);
    }
    clonedEntries.push(entry.name);
  }
  return { clonedEntries, excludedTracked };
}

function syncWorktreeTree(
  seedHead: string,
  worktreePath: string,
  excludedTracked: string[],
  exec: CowExec,
): void {
  const targetHead = runGitSync(worktreePath, ["rev-parse", "HEAD"], exec);
  const refreshArgs = [
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-C",
    worktreePath,
    "update-index",
    "-q",
    "--refresh",
  ];
  if (seedHead === targetHead) {
    runGitSync(worktreePath, ["read-tree", targetHead], exec);
    if (excludedTracked.length > 0) {
      runGitSync(worktreePath, ["checkout", targetHead, "--", ...excludedTracked], exec);
    }
    exec("git", refreshArgs);
  } else {
    runGitSync(worktreePath, ["read-tree", seedHead], exec);
    if (excludedTracked.length > 0) {
      runGitSync(worktreePath, ["checkout", seedHead, "--", ...excludedTracked], exec);
    }
    exec("git", refreshArgs);
    runGitSync(worktreePath, ["read-tree", "-m", "-u", seedHead, targetHead], exec);
  }
}

function cleanupWorktreeSkeleton(cwd: string, worktreePath: string, exec: CowExec): void {
  exec("git", ["-C", cwd, "worktree", "remove", "--force", worktreePath]);
  rmSync(worktreePath, { recursive: true, force: true });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function doesLockfileMatch(
  worktreePath: string,
  seedInfo: { seedLock: string | null; seedHasModules: boolean },
): boolean {
  if (!seedInfo.seedHasModules || !seedInfo.seedLock) return false;
  const wtLock = fileSha256(join(worktreePath, "pnpm-lock.yaml"));
  return Boolean(
    wtLock && seedInfo.seedLock === wtLock && existsSync(join(worktreePath, "node_modules")),
  );
}

export async function createWorktreeWithCowFallback(options: {
  cwd: string;
  worktreePath: string;
  addArguments: string[];
  runPlainAdd: () => Promise<void>;
  runNoCheckoutAdd: () => Promise<void>;
  seedDir?: string;
  platform?: NodeJS.Platform;
  exec?: CowExec;
  enabled?: boolean;
}): Promise<CowWorktreeMaterializeResult> {
  const exec = options.exec ?? defaultExec;
  const platform = options.platform ?? process.platform;
  const enabled = options.enabled ?? process.env.PASEO_WORKTREE_COW !== "0";

  const plain = async (fallbackReason: string): Promise<CowWorktreeMaterializeResult> => {
    await options.runPlainAdd();
    return {
      mechanism: "plain",
      fallbackReason,
      seedDir: null,
      clonedEntries: [],
      lockfileMatched: false,
    };
  };

  if (!enabled) return plain("disabled");
  const parentDir = dirname(options.worktreePath);
  const probe = supportsReflink(parentDir, { platform, exec });
  const spec = cloneEntryCommand(platform);
  if (!probe.supported || !probe.mechanism || !spec) {
    return plain(probe.reason ?? "reflink-unsupported");
  }

  const seedDir = options.seedDir ?? join(parentDir, ".cow-seeds", "default");
  let seedInfo: { seedHead: string; seedLock: string | null; seedHasModules: boolean };
  let clonedEntries: string[];
  let excludedTracked: string[];
  let skeletonCreated = false;
  let releaseSeedLock: (() => void) | null = null;
  try {
    mkdirSync(dirname(seedDir), { recursive: true });
    if (statSync(dirname(seedDir)).dev !== statSync(parentDir).dev) {
      return plain("cross-volume-seed");
    }
    releaseSeedLock = acquireSeedLock(seedDir);
    seedInfo = ensureCowSeed(options.cwd, seedDir, spec, exec);
    await options.runNoCheckoutAdd();
    skeletonCreated = true;
    const cloned = cloneSeedEntries(seedDir, options.worktreePath, spec, exec);
    clonedEntries = cloned.clonedEntries;
    excludedTracked = cloned.excludedTracked;
  } catch (error) {
    if (skeletonCreated) cleanupWorktreeSkeleton(options.cwd, options.worktreePath, exec);
    return plain(`${skeletonCreated ? "cow-failed" : "seed-failed"}:${errorMessage(error)}`);
  } finally {
    releaseSeedLock?.();
  }

  try {
    syncWorktreeTree(seedInfo.seedHead, options.worktreePath, excludedTracked, exec);
    return {
      mechanism: probe.mechanism,
      fallbackReason: null,
      seedDir: resolve(realpathSync(seedDir)),
      clonedEntries,
      lockfileMatched: doesLockfileMatch(options.worktreePath, seedInfo),
    };
  } catch (error) {
    cleanupWorktreeSkeleton(options.cwd, options.worktreePath, exec);
    return plain(`cow-failed:${errorMessage(error)}`);
  }
}
