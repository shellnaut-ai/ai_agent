import type { Model, ModelRequest, ProviderId, StreamEvent } from "./types";


export interface StreamOptions {
    signal?: AbortSignal;
}

export interface ModelProvider{
    // 레지스트리가 프로바이더를 찾을 떄 사용하는 안정적인 식별자, 변경 되면 안됨
    readonly id: ProviderId;
    // 사용자에게 표기하는 이름, 마찬가지로 변경 되면 안됨
    readonly name: string;

    // 모델 목록이 정적 데이터 또는 네트워크 요청에서 올 수 있으므로
    // 모든 provider가 동일한 비동기 계약을 사용한다.
    listModels(options?: {
        signal?:AbortSignal;
    }): Promise<readonly Model[]>;

    // 전체 응답을 한 번에 기다리지 않고,
    // 네트워크에서 수신한 이벤트를 순서대로 전달한다.
    stream(
        request:ModelRequest,
        options?: StreamOptions,
    ):AsyncIterable<StreamEvent>
}