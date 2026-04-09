import type { SetupEventResponse } from "ogi-addon";
import { join } from "path";

export type SetupOverrideContext = {
  appID: number;
  platform: NodeJS.Platform;
  installPath: string;
  executablePath: string;
  dllOverrides: string[];
};

type SetupOverrideValue =
  | Partial<SetupEventResponse>
  | ((context: SetupOverrideContext) => Partial<SetupEventResponse>);

type SetupOverridesMap = Record<number, SetupOverrideValue>;

/**
 * Add app-specific overrides here.
 *
 * Example: override launch arguments for Lossless Scaling (steam app 993090).
 */
const SETUP_OVERRIDES: SetupOverridesMap = {
  // Lossless Scaling (steam app 993090)
  993090: (context) =>
    context.platform === "linux"
      ? {
          cwd: context.installPath,
          launchExecutable: context.executablePath,
          redistributables: [],
          launchArguments: "%command%",
          umu: {
            umuId: `steam:${context.appID}`,
            dllOverrides: [],
            protonVersion: "UMU-Proton",
          },
        }
      : {},
  
  // slay the spire 2 rendering driver patch
  2868840: (context) =>
    context.platform === "linux"
      ? {
        cwd: context.installPath,
        launchExecutable: join(context.installPath, 'launch_opengl.bat'),
        redistributables: [],
        launchArguments: '%command%',
        umu: {
          umuId: `steam:${context.appID}`,
          dllOverrides: [
            ...context.dllOverrides,
            // disable icu dll as it breaks the game
            'icuuc=d',
            'icu=d'
          ]
        },
      }
      : {},
};

export function applySetupOverrides(
  appID: number,
  response: SetupEventResponse,
  context: SetupOverrideContext
): SetupEventResponse {
  const override = SETUP_OVERRIDES[appID];
  if (!override) return response;

  const resolvedOverride =
    typeof override === "function" ? override(context) : override;
  const { umu: overrideUmu, ...overrideWithoutUmu } = resolvedOverride;

  const mergedResponse: SetupEventResponse = {
    ...response,
    ...overrideWithoutUmu,
  };

  if (!response.umu && !overrideUmu) {
    return mergedResponse;
  }

  const umuId = overrideUmu?.umuId ?? response.umu?.umuId;
  if (!umuId) {
    return mergedResponse;
  }

  mergedResponse.umu = {
    ...(response.umu ?? { umuId }),
    ...(overrideUmu ?? {}),
    umuId,
  };

  return mergedResponse;
}
