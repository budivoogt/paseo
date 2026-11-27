import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorktreeWithCowFallback,
  isExcludedCowEntry,
  supportsReflink,
  type CowExec,
} from "./cow-worktree.js";

function runGit(cwd: string, args: string[]): string {
  const res = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  expect(res.status, res.stderr).toBe(0);
  return res.stdout.trim();
}

const mockCloneExec: CowExec = (program, args) => {
  if (program === "git") {
    const res = spawnSync(program, args, { encoding: "utf8" });
    return {
      status: res.status,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      error: res.error ?? null,
    };
  }
  const src = args.at(-2)!;
  const dst = args.at(-1)!;
  cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
  return { status: 0, stdout: "", stderr: "", error: null };
};

describe("cow-worktree", () => {
  it("excludes secrets and agent state while allowing tracked dotdirs and build caches", () => {
    const tracked = new Set([".drizzle", ".github", "src"]);
    expect(isExcludedCowEntry(".git", tracked)).toBe(true);
    expect(isExcludedCowEntry(".env", tracked)).toBe(true);
    expect(isExcludedCowEntry(".env.local", tracked)).toBe(true);
    expect(isExcludedCowEntry(".claude", tracked)).toBe(true);
    expect(isExcludedCowEntry(".codex", tracked)).toBe(true);
    expect(isExcludedCowEntry(".drizzle", tracked)).toBe(false);
    expect(isExcludedCowEntry(".svelte-kit", tracked)).toBe(false);
    expect(isExcludedCowEntry("node_modules", tracked)).toBe(false);
  });

  it("probes reflink support and cleans up probe files", () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-cow-probe-"));
    try {
      const ok = supportsReflink(dir, { platform: "linux", exec: mockCloneExec });
      expect(ok).toEqual({ supported: true, mechanism: "reflink", reason: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clones warm seed via CoW, excludes secrets, and falls back when unsupported", async () => {
    const root = mkdtempSync(join(tmpdir(), "paseo-cow-wt-"));
    try {
      const repo = join(root, "repo");
      mkdirSync(repo, { recursive: true });
      runGit(repo, ["init", "-b", "main"]);
      writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env*\n");
      writeFileSync(join(repo, "pnpm-lock.yaml"), "lock: 1\n");
      writeFileSync(join(repo, "index.ts"), "export const v = 1;\n");
      runGit(repo, ["add", ".gitignore", "pnpm-lock.yaml", "index.ts"]);
      runGit(repo, ["commit", "-m", "init"]);
      mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
      writeFileSync(join(repo, ".env.local"), "SECRET=1\n");

      const wt = join(root, "wt-cow");
      const res = await createWorktreeWithCowFallback({
        cwd: repo,
        worktreePath: wt,
        addArguments: ["-b", "feat/cow", "main"],
        runPlainAdd: async () => {
          runGit(repo, ["worktree", "add", wt, "-b", "feat/cow", "main"]);
        },
        runNoCheckoutAdd: async () => {
          runGit(repo, ["worktree", "add", "--no-checkout", wt, "-b", "feat/cow", "main"]);
        },
        platform: "linux",
        exec: mockCloneExec,
        enabled: true,
      });

      expect(res.mechanism).toBe("reflink");
      expect(res.lockfileMatched).toBe(true);
      expect(existsSync(join(wt, "node_modules", "pkg", "index.js"))).toBe(true);
      expect(existsSync(join(wt, ".env.local"))).toBe(false);
      expect(readFileSync(join(wt, "index.ts"), "utf8")).toBe("export const v = 1;\n");
      expect(runGit(wt, ["status", "--porcelain"])).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
