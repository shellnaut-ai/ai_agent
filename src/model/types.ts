// 모델 요청을 처리할 실행 주체.
// llama는 llama.cpp 서버를 통해 로컬 GGUF 모델을 실행한다.
export type ProviderId = 'codex' | 'claude' | 'llama' | 'fake';

// 외부 혹은 로컬 모델들의 공통된 속성만 추출, 원본의 경우 확장을 위해 더 많은 요소가 있지만 당장의 클론 코딩에선 필요 없기 때문에 제외.
export interface Model{
    // provider에 어떤 모델 이름을 보낼 것인지
    id:string;
    // 사용자에게 표시하는 이름
    name: string;
    // 어떤 provider가 실행할 것인가
    provider: ProviderId;
    // 언제context compaction이 필요한가?
    contextWindow: number;
    // 최대 출력을 얼마로 요청할 것인가?
    maxOutputTokens: number;
}

// 사용자의 질문과 이전 모델 답변
export interface Message{
    role: "user" | "assistant";
    content: string;
}

// 선택한 모델과 대화 기록을 묶은 요청
export interface ModelRequest{
    model: Model;
    messages:Message[];
}

export type StopReason = "stop" | 'length';
export type ErrorReason = 'aborted' | 'error';

export type StreamEvent = {type: 'start'} | {type:"text-delta"; delta: string} | {type: 'done'; reason:StopReason} | {type: 'error'; reason: ErrorReason; error:Error};