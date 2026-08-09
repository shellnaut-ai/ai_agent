# Dependency and CI Verification Design

## 배경

PR #1은 로컬에서 `npm run check`와 audit를 통과한 뒤 병합됐지만 GitHub check run이
하나도 없었다. 이후 동일 lockfile의 `nanoid@3.3.16`에 high advisory가 추가돼 현재
`npm ci`는 취약점 1건을 보고한다. 로컬 시점 검증만으로는 병합 시점과 이후 공급망 상태를
지속적으로 확인할 수 없다. workflow 추가만으로 branch protection이 생기지는 않으므로
이 설계는 자동 검증 신호를 만들고, 실제 merge gate 활성화는 별도 관리자 작업으로
명확히 구분한다.

## 목표

- 취약한 transitive dev dependency를 안전한 patch로 고정한다.
- pull request, `main` push, 주기적 schedule에서 설치, 테스트, 타입 검사, 빌드, CLI
  smoke와 audit를 자동 실행한다.
- high 또는 critical npm advisory를 CI 실패로 만든다.
- workflow token 권한과 실행 시간을 최소화한다.
- runtime source와 제품 동작은 변경하지 않는다.

## 비목표

- Dependabot, Renovate, release publishing을 도입하지 않는다.
- 여러 Node 버전 matrix를 운영하지 않는다.
- coverage threshold나 lint 도구를 새로 추가하지 않는다.
- GitHub branch protection 자체를 API로 변경하지 않는다. 저장소 정책 변경은 별도 명시적
  승인을 받아 `CI / verify` required check와 direct-push 제한을 설정한다. 그 전에는
  workflow를 merge gate라고 부르지 않는다.

## 의존성 갱신

직접 dependency를 추가하지 않고 다음 명령으로 lockfile의 transitive `nanoid`만
`3.3.18`로 갱신한다.

```powershell
npm update nanoid --package-lock-only --ignore-scripts
```

PostCSS의 `^3.3.16` 범위 안 patch이므로 Vitest/Vite 버전과 제품 dependency graph는
변경하지 않는다. 허용하는 dependency/config diff는 정확히 다음 네 범위다.

1. `package.json` root `engines.node`
2. `package-lock.json` root package의 `engines.node`
3. `package-lock.json` nanoid entry의 version, resolved, integrity
4. 새 `.github/workflows/ci.yml`

그 밖의 package entry 변경은 허용하지 않는다.

검증 명령은 다음과 같다.

```powershell
npm ci
npm audit --audit-level=high
npm run check
npm ls nanoid
```

`npm ls nanoid`는 정확히 `3.3.18` 하나만 보여야 하며 audit 결과는 high/critical 0건이어야
한다.

Vite 8.2.0의 개발 도구 하한과 일치하도록 root `engines.node`를 `>=22.12.0`으로 올린다.
CI도 `22.12.0`에서 실행해 선언한 최소 개발 환경을 직접 검증한다.

## GitHub Actions

`.github/workflows/ci.yml`은 다음 계약을 갖는다.

- trigger: `pull_request`, `push` to `main`, 매주 월요일 02:17 UTC `schedule`,
  `workflow_dispatch`
- permissions: `contents: read`
- concurrency: 같은 PR/branch의 이전 실행 취소
- timeout: 15분
- runner: `windows-latest`
- Node: `22.12.0`, npm cache 사용
- steps: checkout, setup-node, `npm ci`, `npm run check`,
  `npm audit --audit-level=high`

외부 action은 mutable tag 대신 다음 full commit SHA로 고정한다.

- `actions/checkout@11d5960a326750d5838078e36cf38b85af677262` (`v4`)
- `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020` (`v4`)

checkout에는 `persist-credentials: false`를 지정해 workflow token을 git config에 남기지
않는다. concurrency group은 `${{ github.workflow }}-${{ github.event.pull_request.number ||
github.ref }}`를 사용해 같은 PR/ref만 이전 실행을 취소한다. `timeout-minutes: 15`는
`jobs.verify` 아래에 둔다.

프로젝트의 주요 위험과 CLI smoke가 Windows 동작에 의존하므로 첫 CI는 `windows-latest`
단일 runner로 제한한다. Linux matrix는 Bash process-group 구현이 runtime PR에서 안정화된
후 별도 확장할 수 있다.

Job과 workflow 이름은 각각 `verify`, `CI`로 고정해 branch protection에서 `CI / verify`를
required check로 선택할 수 있게 한다. workflow 성공 확인 뒤에도 branch가 보호되지 않은
상태라면 이를 완료 보고의 남은 관리자 단계로 명시한다.

## 실패 정책

- lockfile과 package.json 불일치: `npm ci` 실패
- test, typecheck, build, CLI EOF 실패: `npm run check` 실패
- high/critical advisory: `npm audit --audit-level=high` 실패
- 네트워크나 registry 장애도 check 실패로 유지하고 자동 우회하지 않는다.

Audit advisory는 시간이 지나며 바뀔 수 있다. 새로운 high advisory가 CI를 막는 것은
의도한 공급망 gate이며, 영향 범위를 검토해 lockfile patch 또는 명시적 예외 PR로 해결한다.

## 테스트와 검증

Workflow YAML은 소스 문자열 검사가 아니라 실제 consumer 관점으로 검증한다.

1. 로컬에서 `actionlint`로 GitHub Actions schema와 expression 문법 검증.
2. 새 branch push 후 GitHub Actions가 workflow를 인식하는지 확인.
3. PR에서 `CI / verify` check가 성공하는지 확인.
4. `npm ci`, `npm run check`, audit를 로컬에서도 같은 순서로 실행.

## 완료 기준

- `npm audit --audit-level=high`가 취약점 0건으로 종료한다.
- 기존 64개 테스트와 typecheck, build, CLI EOF smoke가 통과한다.
- GitHub가 `CI / verify` check를 생성하고 성공시킨다.
- schedule과 `workflow_dispatch`가 GitHub workflow metadata에 등록된다.
- 제품 source file 변경이 없다.
- branch protection은 자동 변경하지 않으며, `CI / verify`를 required check로 지정하기
  전까지 강제 gate가 아니라는 점을 완료 보고에 포함한다.
