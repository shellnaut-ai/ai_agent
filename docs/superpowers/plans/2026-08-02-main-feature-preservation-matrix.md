# Main 기능 보존표

`shellnaut/main@0c6c0057`에서 import snapshot 병합 시 삭제되는 41개 파일을
기능 단위로 추적한다. `유지`는 canonical 구현으로 남긴다는 뜻이고 `흡수`는
새 진입점이나 구현에 기능을 옮긴 뒤 원본을 제거할 수 있다는 뜻이다.

| Main 파일 | 결정 | 대체 또는 검증 |
|---|---|---|
| `.gitattributes` | 유지 | final `git diff --check`와 checkout 검증 |
| `README.md` | 유지·확장 | 최종 CLI/Provider 실행 문서 검토 |
| `agent-write-test.txt` | 비제품 제거 | 제품 import가 없는지 `rg`로 확인 |
| `docs/superpowers/plans/2026-07-26-model-retry.md` | 유지 | 문서 이력 보존 |
| `docs/superpowers/plans/2026-07-28-compaction-tool-validation-plan.md` | 유지 | 문서 이력 보존 |
| `docs/superpowers/plans/2026-07-29-session-entry-structure.md` | 유지 | 문서 이력 보존 |
| `docs/superpowers/specs/2026-07-26-model-retry-design.md` | 유지 | 문서 이력 보존 |
| `docs/superpowers/specs/2026-07-28-compaction-tool-validation-design.md` | 유지 | 문서 이력 보존 |
| `src/agent/loop.ts` | 유지·확장 | `test/main-capabilities.test.ts`, `src/agent/loop-integration.test.ts` |
| `src/agent/types.ts` | 유지·확장 | `src/agent/loop-integration.test.ts` typecheck |
| `src/approval/key.ts` | 유지 | `src/approval/session.test.ts` |
| `src/approval/session.ts` | 유지 | `src/approval/session.test.ts` |
| `src/approval/types.ts` | 유지 | 승인 E2E typecheck |
| `src/cli/approval.ts` | 유지·확장 | `src/cli/approval.test.ts` |
| `src/cli/arguments.ts` | 흡수 | `src/cli/main.test.ts` command routing |
| `src/cli/chat.ts` | 유지·확장 | `src/cli/chat.test.ts` provider/approval flow |
| `src/cli/io.ts` | 유지·확장 | `src/cli/node-cli-io.test.ts`, EOF smoke |
| `src/context/compaction.ts` | 유지 | `src/context/compaction-integration.test.ts` |
| `src/context/serialize.ts` | 유지 | compaction serialization regression |
| `src/context/token-estimator.ts` | 유지 | context budget regression |
| `src/context/types.ts` | 유지 | compaction integration typecheck |
| `src/demo.ts` | 흡수 | 통합 CLI E2E 이후 제거 여부 결정 |
| `src/model/provider.ts` | 유지·확장 | `src/model/provider-matrix.test.ts` |
| `src/model/registry.ts` | 유지·확장 | `src/model/provider-matrix.test.ts` |
| `src/model/retry.ts` | 유지 | retry characterization test |
| `src/model/runtime.ts` | 유지 | `test/main-capabilities.test.ts` |
| `src/model/types.ts` | 유지·확장 | provider matrix typecheck |
| `src/providers/fake-provider.ts` | 유지 | Agent/CLI 결정론적 E2E |
| `src/providers/llama/provider.ts` | 유지 | `src/model/provider-matrix.test.ts` 및 llama SSE test |
| `src/providers/llama/sse.ts` | 유지 | llama multiline/terminal regression |
| `src/session/chat-session.ts` | 유지·확장 | `src/session/session-compatibility.test.ts` |
| `src/session/jsonl-store.ts` | 유지·확장 | validated replay와 line-number regression |
| `src/session/session.ts` | 유지 | branch/approval/compaction round-trip |
| `src/session/types.ts` | 유지·확장 | session compatibility typecheck |
| `src/tools/bash.ts` | 유지·강화 | `src/tools/tool-integration.test.ts` |
| `src/tools/edit.ts` | 유지·강화 | exact-one edit와 path escape regression |
| `src/tools/read.ts` | 유지·강화 | symlink/path escape regression |
| `src/tools/registry.ts` | 유지·확장 | source-order batch regression |
| `src/tools/types.ts` | 유지·확장 | approval-aware Tool contract typecheck |
| `src/tools/validation.ts` | 유지 | invalid input ToolResult regression |
| `src/tools/write.ts` | 유지·강화 | unsafe parent와 approval regression |

## 현재 게이트

- 41개 삭제 후보가 모두 분류되었다.
- 실제 삭제는 대응 테스트가 성공하고 이 표가 갱신된 뒤에만 허용한다.
- 최종 단계에서 `git diff --diff-filter=D shellnaut/main...HEAD`와 대조한다.
