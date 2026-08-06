import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { extractRar, extractWith7Zip } from "../lib/archive";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("extractRar", () => {
  it("extracts from the destination working directory for unrar-free compatibility", async () => {
    const root = await mkdtemp(join(tmpdir(), "steamrip-unrar-"));
    temporaryDirectories.push(root);

    const archivePath = join(root, "game.rar");
    const destinationPath = join(root, "game");
    const fakeUnrarPath = join(root, "unrar");
    await writeFile(archivePath, "fixture");
    await mkdir(destinationPath);
    await writeFile(
      fakeUnrarPath,
      `#!/usr/bin/env bun
import { writeFile } from "fs/promises";
import { join } from "path";

const args = process.argv.slice(2);
const operands = args.filter((arg) => arg !== "x" && !arg.startsWith("-"));
if (operands.length === 1) {
  await writeFile(join(process.cwd(), "extracted.txt"), "ok");
}
`,
    );
    await chmod(fakeUnrarPath, 0o755);

    const result = await extractRar(
      archivePath,
      destinationPath,
      fakeUnrarPath,
    );

    expect(result.status).toBe(0);
    expect(await Bun.file(join(destinationPath, "extracted.txt")).exists()).toBe(
      true,
    );
  });

  it("reports monotonic extractor percentages and completes at 100", async () => {
    const root = await mkdtemp(join(tmpdir(), "steamrip-unrar-progress-"));
    temporaryDirectories.push(root);

    const archivePath = join(root, "game.rar");
    const destinationPath = join(root, "game");
    const fakeUnrarPath = join(root, "unrar");
    await writeFile(archivePath, "fixture");
    await mkdir(destinationPath);
    await writeFile(
      fakeUnrarPath,
      `#!/usr/bin/env bun
process.stdout.write("Extracting  12");
await Bun.sleep(5);
process.stdout.write("%\\rExtracting  67%\\r");
`,
    );
    await chmod(fakeUnrarPath, 0o755);

    const progressUpdates: number[] = [];
    const result = await extractRar(
      archivePath,
      destinationPath,
      fakeUnrarPath,
      (progress: number) => progressUpdates.push(progress),
    );

    expect(result.status).toBe(0);
    expect(progressUpdates).toEqual([12, 67, 100]);
  });

  it("keeps every progress update from coalesced output", async () => {
    const root = await mkdtemp(join(tmpdir(), "steamrip-unrar-coalesced-"));
    temporaryDirectories.push(root);

    const archivePath = join(root, "game.rar");
    const destinationPath = join(root, "game");
    const fakeUnrarPath = join(root, "unrar");
    await writeFile(archivePath, "fixture");
    await mkdir(destinationPath);
    await writeFile(
      fakeUnrarPath,
      `#!/usr/bin/env bun
process.stdout.write(Array.from({ length: 50 }, (_, progress) => \` \${progress}%\\r\`).join(""));
`,
    );
    await chmod(fakeUnrarPath, 0o755);

    const progressUpdates: number[] = [];
    const result = await extractRar(
      archivePath,
      destinationPath,
      fakeUnrarPath,
      (progress: number) => progressUpdates.push(progress),
    );

    expect(result.status).toBe(0);
    expect(progressUpdates).toEqual([
      ...Array.from({ length: 50 }, (_, progress) => progress),
      100,
    ]);
  });

  it("configures 7-Zip to emit progress and reports it", async () => {
    const root = await mkdtemp(join(tmpdir(), "steamrip-7zip-progress-"));
    temporaryDirectories.push(root);

    const archivePath = join(root, "game.rar");
    const destinationPath = join(root, "game");
    const fake7ZipPath = join(root, "7z");
    await writeFile(archivePath, "fixture");
    await mkdir(destinationPath);
    await writeFile(
      fake7ZipPath,
      `#!/usr/bin/env bun
import { writeFile } from "fs/promises";
import { join } from "path";

await writeFile(join(process.cwd(), "args.json"), JSON.stringify(process.argv.slice(2)));
process.stdout.write(" 35%\\r");
`,
    );
    await chmod(fake7ZipPath, 0o755);

    const progressUpdates: number[] = [];
    const result = await extractWith7Zip(
      archivePath,
      destinationPath,
      fake7ZipPath,
      (progress: number) => progressUpdates.push(progress),
    );
    const args: string[] = await Bun.file(
      join(destinationPath, "args.json"),
    ).json();

    expect(result.status).toBe(0);
    expect(args).toEqual([
      "x",
      archivePath,
      `-o${destinationPath}`,
      "-y",
      "-bsp1",
    ]);
    expect(progressUpdates).toEqual([35, 100]);
  });

  it("does not report completion when extraction fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "steamrip-unrar-failure-"));
    temporaryDirectories.push(root);

    const archivePath = join(root, "game.rar");
    const destinationPath = join(root, "game");
    const fakeUnrarPath = join(root, "unrar");
    await writeFile(archivePath, "fixture");
    await mkdir(destinationPath);
    await writeFile(
      fakeUnrarPath,
      `#!/usr/bin/env bun
process.stdout.write(" 42%\\r");
process.exit(2);
`,
    );
    await chmod(fakeUnrarPath, 0o755);

    const progressUpdates: number[] = [];
    const result = await extractRar(
      archivePath,
      destinationPath,
      fakeUnrarPath,
      (progress: number) => progressUpdates.push(progress),
    );

    expect(result.status).toBe(2);
    expect(progressUpdates).toEqual([42]);
  });
});
