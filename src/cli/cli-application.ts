export interface CliApplicationDependencies {
  write(line: string): void;
  runAuth(args: readonly string[]): Promise<boolean>;
  runChat(args: readonly string[]): Promise<boolean>;
}

/**
 * argv를 책임별 명령 처리기에 순서대로 전달하는 가장 얇은 dispatcher다.
 * 인증 명령을 먼저 확인해 login 과정에서 대화용 readline이 만들어지지 않게 한다.
 */
export async function runCliApplication(
  args: readonly string[],
  dependencies: CliApplicationDependencies,
): Promise<number> {
  if (await dependencies.runAuth(args)) return 0;
  if (await dependencies.runChat(args)) return 0;

  dependencies.write("사용법:");
  dependencies.write("  npm run cli -- login [--device]");
  dependencies.write("  npm run cli -- status");
  dependencies.write("  npm run cli -- logout");
  dependencies.write("  npm run cli -- chat [--model MODEL] [--session FILE]");
  return args.length === 0 || args[0] === "help" || args[0] === "--help" ? 0 : 1;
}
