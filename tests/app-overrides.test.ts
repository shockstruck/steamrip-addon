import { describe, expect, it } from "bun:test";
import { join } from "path";
import { applySetupOverrides } from "../lib/app-overrides";

describe("app setup overrides", () => {
  it("bypasses MECCHA CHAMELEON's Wine-incompatible prerequisite wrapper", () => {
    const installPath = "/games/MECCHA CHAMELEON";
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
    expect(overridden.cwd).toBe(installPath);
    expect(overridden.redistributables).toEqual(response.redistributables);
    expect(overridden.umu?.dllOverrides).toEqual([
      "version=n,b",
      "OnlineFix64=n",
      "SteamOverlay64=n",
      "winmm=n,b",
      "dnet=n",
      "steam_api64=n",
      "winhttp=n,b",
    ]);
  });
});
