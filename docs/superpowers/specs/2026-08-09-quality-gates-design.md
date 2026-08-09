# Dependency and CI Quality Gates Design

## 배경

PR #1은 로컬에서 `npm run check`와 audit를 통과한 뒤 병합됐지만 GitHub check run이
하나도 없었다. 이후 동일 lockfile의 `nanoid@3.3.16`에 high advisory가 추가돼 현재
`npm ci`는 취약점 1건을 보고한다. 로컬 시점 검증만으로는 병합 시점과 이후 공급망 상태를
지속적으로 강제할 수 없다.

## 목표

- 취약한 transitive dev dependency를 안전한 patch로 고정한다.
- pull request와 `main` push에서 설치, 테스트, 타입 검사, 빌드, CLI smoke를 자동 실행한다.
- high 또는 critical npm advisory를 CI 실패로 만든다.
- workflow token 권한과 실행 시간을 최소화한다.
- runtime source와 제품 동작은 변경하지 않는다.

## 비목표

- Dependabot, Renovate, release publishing을 도입하지 않는다.
- 여러 Node 버전 matrix를 운영하지 않는다.
- coverage threshold나 lint 도구를 새로 추가하지 않는다.
- GitHub branch protection 자체를 API로 변경하지 않는다. workflow 확인 후 저장소 관리자가
  required check로 지정할 수 있도록 check 이름을 안정적으로 둔다.

## 의존성 갱신

직접 dependency를 추가하지 않고 lockfile의 transitive `nanoid`를 `3.3.18`로 갱신한다.
PostCSS의 `^3.3.16` 범위 안 patch이므로 Vitest/Vite 버전과 제품 dependency graph는
변경하지 않는다.

검증 명령은 다음과 같다.

```powershell
npm ci
npm audit --audit-level=high
npm run check
npm ls nanoid
```

`npm ls nanoid`는 `3.3.17` 이상 하나만 보여야 하며 audit 결과는 high/critical 0건이어야
한다.

## GitHub Actions

`.github/workflows/ci.yml`은 다음 계약을 갖는다.

- trigger: `pull_request`, `push` to `main`
- permissions: `contents: read`
- concurrency: 같은 PR/branch의 이전 실행 취소
- timeout: 15분
- runner: `windows-latest`
- Node: 22, npm cache 사용
- steps: checkout, setup-node, `npm ci`, `npm run check`,
  `npm audit --audit-level=high`

프로젝트의 주요 위험과 CLI smoke가 Windows 동작에 의존하므로 첫 CI는 `windows-latest`
단일 runner로 제한한다. Linux matrix는 Bash process-group 구현이 runtime PR에서 안정화된
후 별도 확장할 수 있다.

Job과 workflow 이름은 각각 `verify`, `CI`로 고정해 branch protection에서
`CI / verify`를 required check로 선택할 수 있게 한다.

## 실패 정책

- lockfile과 package.json 불일치: `npm ci` 실패
- test, typecheck, build, CLI EOF 실패: `npm run check` 실패
- high/critical advisory: `npm audit --audit-level=high` 실패
- 네트워크나 registry 장애도 check 실패로 유지하고 자동 우회하지 않는다.

Audit advisory는 시간이 지나며 바뀔 수 있다. 새로운 high advisory가 CI를 막는 것은
의도한 공급망 gate이며, 영향 범위를 검토해 lockfile patch 또는 명시적 예외 PR로 해결한다.

## 테스트와 검증

Workflow YAML은 소스 문자열 검사가 아니라 실제 consumer 관점으로 검증한다.

1. 로컬에서 YAML parser 또는 `actionlint`로 문법 검증.
2. 새 branch push 후 GitHub Actions가 workflow를 인식하는지 확인.
3. PR에서 `CI / verify` check가 성공하는지 확인.
4. `npm ci`, `npm run check`, audit를 로컬에서도 같은 순서로 실행.

## 완료 기준

- `npm audit --audit-level=high`가 취약점 0건으로 종료한다.
- 기존 64개 테스트와 typecheck, build, CLI EOF smoke가 통과한다.
- GitHub가 `CI / verify` check를 생성하고 성공시킨다.
- 제품 source file 변경이 없다.
