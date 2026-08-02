import { defineConfig } from "vitest/config";

/**
 * 테스트 파일을 소스 가까이에 두면 구현과 계약을 한 커밋에서 함께 비교하기 쉽다.
 * 별도 tests 디렉터리 대신 src 아래의 .test.ts 파일만 수집하는 이유가 여기에 있다.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});

