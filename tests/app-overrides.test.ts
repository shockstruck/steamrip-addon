import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { applySetupOverrides } from "../lib/app-overrides";

describe("app setup overrides", () => {
  it("launches Palworld from its WineGDK directory with its DLL overrides", async () => {
    const installPath = await mkdtemp(join(tmpdir(), "palworld-"));
    const gameDirectory = join(installPath, "Pal", "Binaries", "WineGDK");
    await mkdir(gameDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(gameDirectory, "Palworld-WinGDK-Shipping.exe"), ""),
      writeFile(join(gameDirectory, "OnlineFix64.dll"), ""),
      writeFile(join(gameDirectory, "steam_api64.DLL"), ""),
      writeFile(join(gameDirectory, "notes.txt"), ""),
    ]);

    const response = {
      cwd: installPath,
      launchExecutable: join(installPath, "Palworld.exe"),
      version: "1.0.0",
      redistributables: [],
      launchArguments: "%command%",
      umu: {
        umuId: "steam:1623730" as const,
        dllOverrides: [],
        protonVersion: "UMU-Proton",
      },
    };

    const overridden = applySetupOverrides(1623730, response, {
      appID: 1623730,
      platform: "linux",
      installPath,
      executablePath: response.launchExecutable,
      dllOverrides: [],
    });

    expect(overridden.cwd).toBe(gameDirectory);
    expect(overridden.launchExecutable).toBe(
      join(gameDirectory, "Palworld-WinGDK-Shipping.exe"),
    );
    expect(overridden.umu?.dllOverrides).toEqual([
      "OnlineFix64=n,b",
      "steam_api64=n,b",
    ]);
  });

  it("bypasses MECCHA CHAMELEON's Wine-incompatible prerequisite wrapper", async () => {
    const installPath = await mkdtemp(join(tmpdir(), "meccha-chameleon-"));
    const gameDirectory = join(installPath, "Chameleon", "Binaries", "Win64");
    await mkdir(gameDirectory, { recursive: true });
    await Promise.all([
      writeFile(join(gameDirectory, "OnlineFix64.dll"), ""),
      writeFile(join(gameDirectory, "steam_api64.DLL"), ""),
      writeFile(join(gameDirectory, "PenguinHotel-Win64-Shipping.exe"), ""),
    ]);
    const wrapperPath = join(installPath, "PenguinHotel.exe");
    const response = {
      cwd: installPath,
      launchExecutable: wrapperPath,
      version: "2.7.1",
      redistributables: [{ name: "vcrun2022", path: "winetricks" }],
      launchArguments: "%command%",
      umu: {
        umuId: "steam:4704690" as const,
        dllOverrides: [
          "OnlineFix64=n,b",
          "SteamOverlay64=n,b",
          "winmm=n,b",
          "dnet=n,b",
          "steam_api64=n,b",
          "winhttp=n,b",
          "version=n,b",
        ],
        protonVersion: "UMU-Proton",
      },
    };

    const overridden = applySetupOverrides(4704690, response, {
      appID: 4704690,
      platform: "linux",
      installPath,
      executablePath: wrapperPath,
      dllOverrides: response.umu.dllOverrides,
    });

    expect(overridden.launchExecutable).toBe(
      join(
        installPath,
        "Chameleon",
        "Binaries",
        "Win64",
        "PenguinHotel-Win64-Shipping.exe",
      ),
    );
    expect(overridden.cwd).toBe(gameDirectory);
    expect(overridden.redistributables).toEqual(response.redistributables);
    expect(overridden.umu?.dllOverrides).toEqual([
      "OnlineFix64=n,b",
      "steam_api64=n,b",
    ]);
  });
});
