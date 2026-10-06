import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { extractRar } from "../lib/archive";
import { decideGameFolder, scanExecutables } from "../lib/executable-detection";
import {
  classifySetupSource,
  hasAllowedArchiveExtension,
  resolveLocalArchive,
} from "../lib/local-archive";

const temporaryDirectories: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "steamrip-local-archive-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("classifySetupSource", () => {
  it("treats empty + local as a local archive", () => {
    expect(classifySetupSource("empty", { source: "local" })).toBe(
      "local-archive",
    );
  });

  it("keeps empty without the local marker as already downloaded", () => {
    expect(classifySetupSource("empty", undefined)).toBe("already-downloaded");
    expect(classifySetupSource("empty", {})).toBe("already-downloaded");
    expect(classifySetupSource("empty", { url: "https://example.invalid" })).toBe(
      "already-downloaded",
    );
  });

  it("treats direct downloads as normal downloads", () => {
    expect(classifySetupSource("direct", { url: "https://example.invalid" })).toBe(
      "download",
    );
    expect(classifySetupSource("direct", { source: "local" })).toBe("download");
  });
});

describe("hasAllowedArchiveExtension", () => {
  it("allows rar, zip and 7z case-insensitively and rejects the rest", () => {
    expect(hasAllowedArchiveExtension("/x/game.rar")).toBe(true);
    expect(hasAllowedArchiveExtension("/x/GAME.ZIP")).toBe(true);
    expect(hasAllowedArchiveExtension("/x/game.7z")).toBe(true);
    expect(hasAllowedArchiveExtension("/x/game.exe")).toBe(false);
    expect(hasAllowedArchiveExtension("/x/game")).toBe(false);
  });
});

describe("resolveLocalArchive", () => {
  it("returns a single archive unchanged", async () => {
    const root = await makeRoot();
    const archive = join(root, "game.rar");
    await writeFile(archive, "x");
    expect(await resolveLocalArchive(archive)).toBe(archive);
  });

  it("resolves any partN.rar volume to part1", async () => {
    const root = await makeRoot();
    for (const n of ["1", "2", "3"]) {
      await writeFile(join(root, `game.part${n}.rar`), "x");
    }
    expect(await resolveLocalArchive(join(root, "game.part2.rar"))).toBe(
      join(root, "game.part1.rar"),
    );
    expect(await resolveLocalArchive(join(root, "game.part1.rar"))).toBe(
      join(root, "game.part1.rar"),
    );
  });

  it("resolves zero-padded partNN.rar volumes", async () => {
    const root = await makeRoot();
    for (const n of ["01", "02"]) {
      await writeFile(join(root, `game.part${n}.rar`), "x");
    }
    expect(await resolveLocalArchive(join(root, "game.part02.rar"))).toBe(
      join(root, "game.part01.rar"),
    );
  });

  it("resolves .r00 style volumes to the sibling .rar", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "game.rar"), "x");
    await writeFile(join(root, "game.r00"), "x");
    expect(await resolveLocalArchive(join(root, "game.rar"))).toBe(
      join(root, "game.rar"),
    );
  });

  it("rejects a missing file", async () => {
    const root = await makeRoot();
    await expect(resolveLocalArchive(join(root, "nope.rar"))).rejects.toThrow(
      /not found/i,
    );
  });

  it("rejects a disallowed extension", async () => {
    const root = await makeRoot();
    const file = join(root, "game.exe");
    await writeFile(file, "x");
    await expect(resolveLocalArchive(file)).rejects.toThrow(/\.rar|\.zip|\.7z/);
  });

  it("rejects a directory", async () => {
    const root = await makeRoot();
    const dir = join(root, "folder.rar");
    await mkdir(dir);
    await expect(resolveLocalArchive(dir)).rejects.toThrow(/not a file/i);
  });

  it("rejects a part volume whose first volume is missing", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "game.part2.rar"), "x");
    await expect(
      resolveLocalArchive(join(root, "game.part2.rar")),
    ).rejects.toThrow(/first volume/i);
  });
});

describe("extract a local archive without owning it", () => {
  it("extracts into the install folder, detects the exe and leaves the source archive untouched", async () => {
    const root = await makeRoot();
    const downloads = join(root, "Downloads");
    const installPath = join(root, "library", "Game");
    await mkdir(downloads, { recursive: true });
    const archivePath = join(downloads, "game.rar");
    await writeFile(archivePath, "archive-bytes");
    const fakeUnrarPath = join(root, "unrar");
    await writeFile(
      fakeUnrarPath,
      `#!/usr/bin/env bun
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

const pe = Buffer.alloc(256 * 1024);
pe.write("MZ", 0, "ascii");
pe.writeUInt32LE(0x40, 0x3c);
pe.writeUInt32LE(0x00004550, 0x40);
pe.writeUInt16LE(0x8664, 0x44);
pe.writeUInt16LE(0x0102, 0x40 + 22);
pe.writeUInt16LE(2, 0x40 + 24 + 68);
await mkdir(join(process.cwd(), "Game"), { recursive: true });
await writeFile(join(process.cwd(), "Game", "Game.exe"), pe);
`,
    );
    await chmod(fakeUnrarPath, 0o755);

    const resolved = await resolveLocalArchive(archivePath);
    await mkdir(installPath, { recursive: true });
    const result = await extractRar(resolved, installPath, fakeUnrarPath);

    expect(result.status).toBe(0);
    const candidates = await scanExecutables(installPath, 4);
    expect(candidates.map((c) => c.relPath)).toContain(join("Game", "Game.exe"));
    expect(
      decideGameFolder([{ name: "Game", isDirectory: true }], []).action,
    ).toBe("collapse");

    // The user's file is neither moved, modified nor deleted.
    expect(await Bun.file(archivePath).exists()).toBe(true);
    expect(await readFile(archivePath, "utf8")).toBe("archive-bytes");
  });
});
