import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ProviderCallOptions,
} from "../core/contracts.js";

/**
 * 네트워크 없이 Agent의 turn 흐름을 재현하는 결정론적 Provider다.
 *
 * 호출마다 미리 준비한 event 배열 하나를 소비하고, 실제로 받은 request도 보관한다.
 * 따라서 테스트는 "두 번째 호출에 ToolResult가 다시 들어갔는가"를 직접 확인할 수 있다.
 */
export class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  private nextScript = 0;

  constructor(private readonly scripts: readonly (readonly ModelStreamEvent[])[]) {}

  async *stream(
    request: ModelRequest,
    _options?: ProviderCallOptions,
  ): AsyncIterable<ModelStreamEvent> {
    // script 위치를 Provider 호출 횟수와 1:1로 대응시켜 예상 밖 추가 호출도 실패로 드러낸다.
    const callIndex = this.nextScript++;
    this.requests.push(request);
    const script = this.scripts[callIndex];
    if (script === undefined) {
      throw new Error(`ScriptedProvider has no script for call ${callIndex}`);
    }

    yield* script;
  }
}
