#!/usr/bin/env node

import { main } from "./cli/main.js";

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // CLI 최상단은 stack과 cause를 기본 출력하지 않아 token 관련 하위 오류가 터미널에 새지 않게 한다.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`오류: ${message}\n`);
  process.exitCode = 1;
}
