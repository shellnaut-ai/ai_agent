# AI Agent 클론 코딩 주간 학습 정리

이 문서는 현재 프로젝트의 구현을 기준으로, 이번 주에 학습한 핵심 개념과 다음에 코드를 읽을 때 확인할 지점을 정리한 문서입니다.

## 1. 전체 실행 흐름

사용자 입력은 다음 순서로 처리됩니다.

CLI 입력
→ ChatSession.streamTurn()
→ AgentLoop.stream()
→ ModelRuntime / Provider
→ text-delta 또는 tool-call
→ 필요하면 ToolRegistry가 도구 실행
→ ToolResult를 다시 모델에 전달
→ 최종 done
→ Session에 MessageEntry로 저장

역할 분리는 다음과 같습니다.

- ChatSession: 현재 세션과 대화 기록을 관리합니다.
- AgentLoop: 모델 호출, 여러 단계의 사고, 도구 호출 반복을 관리합니다.
- ToolRegistry: 도구를 등록·검증·실행합니다.
- Session: 대화 기록을 Entry 트리로 저장합니다.
- CLI: 입력, 출력, tree/goto/fork/clone, Esc 취소를 담당합니다.

## 2. 모델과 Provider 추상화

핵심 타입은 src/model/types.ts입니다.

Model은 모델 ID, Provider, context window, 최대 출력 토큰을 표현합니다.
Provider마다 API가 달라도 애플리케이션은 공통 ModelRequest와 StreamEvent를 사용합니다.

StreamEvent의 핵심 이벤트는 다음과 같습니다.

- text-delta: 모델이 생성한 텍스트 조각
- tool-call: 모델이 도구 실행을 요청함
- done: 현재 모델 호출이 끝남
- error: 중단 또는 실행 오류

따라서 Llama.cpp를 FakeProvider로 바꾸더라도 AgentLoop와 ChatSession의 구조는 유지됩니다.

## 3. AgentLoop: 에이전트의 핵심

파일: src/agent/loop.ts

AgentLoop는 한 번의 모델 호출만 처리하지 않습니다. 최대 maxSteps까지 다음 작업을 반복합니다.

1. 현재 메시지와 도구 정의를 모델에 전달합니다.
2. 텍스트 delta를 CLI로 전달합니다.
3. 모델이 ToolCall을 반환하면 호출을 검증합니다.
4. 도구를 실행합니다.
5. ToolResult를 메시지로 추가합니다.
6. ToolResult가 포함된 새 요청을 모델에 다시 전달합니다.
7. 모델이 일반 답변을 완료하면 종료합니다.

workingMessages는 현재 작업 중인 모델 문맥이며, newMessages는 이번 턴에서 새로 생긴 메시지입니다.
전자는 도구 반복에 사용하고, 후자는 최종적으로 Session에 저장합니다.

모델 이벤트와 done.reason도 검증합니다.

- tool-call인데 ToolCall이 없으면 오류
- tool-call이 아닌데 ToolCall이 있으면 오류
- 종료 이벤트 없이 스트림이 끝나면 오류
- maxSteps를 초과하면 오류

## 4. ToolCall과 ToolResult

파일: src/tools/types.ts, src/tools/registry.ts

ToolCall은 모델의 명령이고 ToolResult는 실행 결과입니다.
toolCallId로 여러 호출과 결과를 연결합니다.

실행 순서는 다음과 같습니다.

1. 모델이 name과 arguments를 보냅니다.
2. Registry가 도구 이름을 찾습니다.
3. 입력을 스키마에 맞게 검증합니다.
4. 검증된 복사본을 실행합니다.
5. 성공 또는 실패를 ToolResult로 변환합니다.

원본 arguments 대신 검증된 복사본을 사용하는 이유는 요청 원본이 실행 중 변경되지 않도록 하기 위해서입니다.

현재 도구는 read, write, edit, bash입니다. bash처럼 위험할 수 있는 도구는 승인 정책을 거칩니다.

## 5. 승인과 Esc 취소

파일: src/approval/session.ts, src/cli/chat.ts

CLI는 각 턴마다 AbortController를 만들고 Esc 입력 시 abort()를 호출합니다.
이 signal은 AgentLoop, Provider, Tool 실행까지 전달되어 실행 계층 전체가 취소를 관찰합니다.

승인 기록은 세션 JSONL에 저장됩니다.

- allow-once: 현재 호출만 허용
- allow-session: 현재 세션에서 같은 정책을 기억
- deny: 실행하지 않고 오류 ToolResult 생성

fork/clone 시 승인 기록은 복사하지 않으므로 새 세션은 독립적인 승인 상태로 시작합니다.

## 6. Session Entry와 JSONL

파일: src/session/types.ts, src/session/jsonl-store.ts, src/session/session.ts

각 메시지는 독립적인 Entry로 저장됩니다.
Entry에는 id, parentId, timestamp가 있으며, parentId가 바로 이전 leaf를 가리킵니다.

따라서 부모 하나에 여러 자식이 생길 수 있고, 과거 지점에서 대화를 분기할 수 있습니다.

JsonlSessionStore는 JSONL header와 Entry를 복원하고, Entry ID, parentId 관계, 중복 ID, 순환 구조, current leaf를 관리합니다.
현재 leaf에서 parentId를 따라 root까지 이동한 뒤 root부터 정렬하면 모델에 전달할 메시지 경로가 됩니다.

## 7. Session tree, goto, fork

파일: src/session/tree.ts, src/session/repository.ts, src/session/chat-session.ts

tree는 평평한 Entry 배열을 부모-자식 구조로 변환합니다.
goto는 current leaf를 과거 Entry로 이동시키고, 이후 새 메시지는 그 위치에서 branch를 만듭니다.

fork는 특정 지점까지의 root-to-target 경로만 새 JSONL 세션에 복사합니다.

- before: 선택한 user message 직전까지 복사
- at: 선택한 Entry까지 복사

원본 파일은 수정하지 않으며, 새 세션은 새 ID와 새 파일을 가집니다. 승인 기록도 복사하지 않습니다.

## 8. clone

파일: src/session/repository.ts, src/session/chat-session.ts, src/cli/chat.ts

clone은 현재 leaf 기준의 특수한 fork입니다.
즉 현재 대화 상태를 새 JSONL 파일에 복제하고, 이후 ChatSession을 새 세션으로 교체합니다.

fork는 과거 특정 지점에서 다른 방향으로 진행할 때 사용하고, clone은 현재 상태를 보존한 채 독립적으로 계속 작업할 때 사용합니다.
원본의 다른 branch와 승인 기록은 복사하지 않습니다.

## 9. Compaction과 Retry

Compaction은 오래된 문맥을 요약해 context window를 확보하는 기능입니다.
ChatSession.streamTurn()이 필요 여부를 확인하고 CompactionService를 호출합니다.

Retry는 Provider 오류를 다시 시도하는 기능입니다.
CLI는 retry 이벤트를 받아 시도 횟수와 대기 시간을 표시합니다.

모델 호출, 세션 저장, UI가 분리되어 있기 때문에 두 기능을 독립적으로 확장할 수 있습니다.

## 10. 반드시 이해해야 할 핵심

1. ChatSession과 AgentLoop는 역할이 다릅니다. 반복적인 모델-도구 작업은 AgentLoop가 담당합니다.
2. ToolCall은 명령이고 ToolResult는 실행 결과입니다. 결과는 다시 모델 메시지로 들어갑니다.
3. workingMessages와 newMessages를 구분해야 합니다.
4. 모든 실행 계층에 AbortSignal을 전달해야 Esc 취소가 실제로 동작합니다.
5. Entry의 parentId가 대화 tree를 만듭니다.
6. leafId는 현재 작업 중인 branch를 의미합니다.
7. fork/clone은 기존 기록을 수정하지 않고 새 JSONL 파일을 만듭니다.
8. 세션 교체 시 승인 상태도 함께 교체해야 합니다.
9. 모델 응답은 신뢰하지 말고 ToolCall, stop reason, arguments를 검증해야 합니다.
10. Provider, AgentLoop, Tool, Session, CLI를 분리했기 때문에 GUI나 다른 Provider를 추가할 수 있습니다.

## 11. 추천 코드 읽기 순서

1. src/model/types.ts
2. src/tools/types.ts와 src/tools/registry.ts
3. src/agent/loop.ts
4. src/session/types.ts
5. src/session/jsonl-store.ts
6. src/session/session.ts
7. src/session/repository.ts
8. src/session/chat-session.ts
9. src/cli/chat.ts
10. src/demo.ts

특히 AgentLoop.stream(), JsonlSessionStore.appendEntries(), Session.getPathToRoot(),
SessionRepository.fork()/clone(), ChatSession.streamTurn()을 중심으로 읽으면 됩니다.
