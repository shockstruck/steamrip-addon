import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { extractRar } from "../lib/archive";

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
});
