# Dependency and CI Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the known high advisory and add continuously runnable GitHub verification without silently changing repository protection policy.

**Architecture:** Make a minimal lockfile and Node-engine update, then add a SHA-pinned Windows workflow that runs the same local verification on PRs, main pushes, schedules, and manual dispatches. Validate locally with actionlint and remotely through the generated GitHub check.

**Tech Stack:** npm lockfile v3, Node.js 22.12.0, GitHub Actions, actionlint, Vitest/TypeScript build scripts.

## Global Constraints

- Base commit is `shellnaut/main@a75dbde3aae18719c32b747bf7dd7c19ca32bc68`.
- Product source files under `src/` must not change.
- Allowed package/config changes are root Node engine, lockfile root engine, nanoid version/resolved/integrity, and the new workflow.
- `nanoid` must resolve to exactly `3.3.18`.
- Actions use the exact full commit SHAs from the design spec and checkout does not persist credentials.
- CI is a verification signal until an administrator separately enables branch protection; do not modify branch policy in this plan.
- Every command failure stops the task; never bypass audit or workflow errors.

---

### Task 1: Patch the vulnerable transitive dependency

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: PostCSS dependency range `nanoid@^3.3.16`.
- Produces: exact `nanoid@3.3.18` and Node engine `>=22.12.0`.

- [ ] **Step 1: Capture the failing security baseline**

Run:

```powershell
npm ci
npm audit --audit-level=high
```

Expected: audit exits non-zero and reports `nanoid <3.3.17` through the Vitest/Vite/PostCSS dev dependency path.

- [ ] **Step 2: Update the declared Node floor**

Change both package root engine declarations to:

```json
"engines": {
  "node": ">=22.12.0"
}
```

- [ ] **Step 3: Update only nanoid in the lockfile**

```powershell
npm update nanoid --package-lock-only --ignore-scripts
```

Inspect the diff and reject any package entry change beyond root engine and nanoid `version`, `resolved`, and `integrity`.

- [ ] **Step 4: Verify GREEN**

```powershell
npm ci
npm ls nanoid
npm audit --audit-level=high
npm run check
```

Expected: exactly `nanoid@3.3.18`, zero high/critical advisories, and all project checks pass.

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json
git commit -m "chore(deps): update vulnerable nanoid"
```

---

### Task 2: Add SHA-pinned GitHub verification

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root `npm run check` and audit scripts.
- Produces: workflow `CI`, job `verify`, displayed check `CI / verify`.

- [ ] **Step 1: Establish the RED workflow validation**

Create a temporary directory outside the repository, download
`https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_windows_amd64.zip`,
expand it, and run the contained `actionlint.exe` against `.github/workflows/ci.yml`
before the file exists. Reuse this exact v1.7.12 binary in Steps 3 and 4.

Expected: validation fails because the workflow file is absent.

- [ ] **Step 2: Create the workflow**

Use this exact structure and values:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "17 2 * * 1"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  verify:
    runs-on: windows-latest
    timeout-minutes: 15
    steps:
      - name: Check out repository
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          persist-credentials: false
      - name: Set up Node.js
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: 22.12.0
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Verify project
        run: npm run check
      - name: Audit dependencies
        run: npm audit --audit-level=high
```

- [ ] **Step 3: Validate workflow syntax and expressions**

Run the downloaded `actionlint` binary against the workflow.

Expected: exit code 0 with no diagnostics.

- [ ] **Step 4: Run local parity checks**

```powershell
npm ci
npm run check
npm audit --audit-level=high
git diff --check shellnaut/main...HEAD
```

Expected: all commands pass.

- [ ] **Step 5: Commit**

```powershell
git add .github/workflows/ci.yml
git commit -m "ci: verify Windows build and dependency audit"
```

---

### Task 3: Quality branch publication verification

**Files:**
- No source changes.

**Interfaces:**
- Consumes: committed branch and GitHub workflow.
- Produces: pushed branch, ready PR, observed `CI / verify` result, and merged `main`.

- [ ] **Step 1: Verify allowed diff**

```powershell
git diff --name-status shellnaut/main...HEAD
git diff -- package.json package-lock.json .github/workflows/ci.yml
```

Expected: spec/plan documents plus the four allowed package/config ranges; no `src/` changes.

- [ ] **Step 2: Run the final local gate**

```powershell
npm ci
npm run check
npm audit --audit-level=high
```

Expected: all pass with zero high/critical advisories.

- [ ] **Step 3: Publish and observe GitHub**

Push `codex/quality-gates`, open a ready PR to `main`, and wait for `CI / verify` to complete. Confirm GitHub lists `pull_request`, `push`, `schedule`, and `workflow_dispatch` triggers. Merge only after the check succeeds, then fetch `shellnaut/main` and verify the merge commit contains this branch.

- [ ] **Step 4: Report policy boundary**

Record that the workflow is not a mandatory merge gate until repository branch protection selects `CI / verify` and restricts direct pushes. Do not change protection settings without a separate explicit request.
