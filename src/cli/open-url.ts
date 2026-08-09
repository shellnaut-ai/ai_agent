import { spawn, type ChildProcess } from "node:child_process";

export type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: {
    readonly detached: boolean;
    readonly stdio: "ignore";
    readonly windowsHide: boolean;
  },
) => ChildProcess;

export interface OpenExternalUrlOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: SpawnProcess;
}

/**
 * OAuth URL을 shell 문자열로 조립하지 않고 OS URL handler에 인자 배열로 전달한다.
 * URL 안의 `&` 같은 문자가 shell 연산자로 해석되지 않게 하는 것이 이 작은 경계의 목적이다.
 */
export async function openExternalUrl(
  url: string,
  options: OpenExternalUrlOptions = {},
): Promise<boolean> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http and https URLs can be opened");
  }

  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawn ?? spawn;
  const [command, args] = commandForPlatform(platform, parsed.toString());
  const child = spawnProcess(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  return new Promise<boolean>((resolve) => {
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
    child.once("error", () => resolve(false));
  });
}

function commandForPlatform(
  platform: NodeJS.Platform,
  url: string,
): readonly [string, readonly string[]] {
  if (platform === "win32") {
    return ["rundll32.exe", ["url.dll,FileProtocolHandler", url]];
  }
  if (platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}
