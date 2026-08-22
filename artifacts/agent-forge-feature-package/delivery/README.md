# Agent Forge 기능 시연 패키지

## 주요 파일

- `agent-forge-demo.pptx`: 로그인, read, write, edit, bash, Agent Loop, 복합 작업 설명 슬라이드
- `agent-forge-feature-demo.mp4`: 설명 슬라이드와 실제 PowerShell 사용 장면을 합친 2분 45초 영상
- `agent-forge-thumbnail.png`: 영상 대표 이미지
- `clips/`: 기능별 실제 사용 원본 클립

## 영상 구성

1. 로그인 필요 안내와 로그인 상태
2. 파일 읽기와 원문 확인
3. 파일 생성과 저장 결과 확인
4. 파일 수정 전후 확인
5. bash 명령과 stdout 확인
6. Agent Loop 설명
7. read/write/edit/bash 복합 작업과 결과 확인

영상에는 테스트 실행 화면이나 mocked SSE가 포함되지 않습니다. 모델 호출과 도구 실행은 OpenAI Codex OAuth 연결과 실제 파일시스템을 사용했습니다.
