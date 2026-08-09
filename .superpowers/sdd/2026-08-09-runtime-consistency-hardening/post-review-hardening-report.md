# Post-review runtime consistency hardening report

Date: 2026-08-09
Implementation commit: `c5d1171` (`fix(runtime): close portability and provenance gaps`)
Baseline: `1e485ef`

## Outcome

Both load-bearing blockers in `post-review-hardening.md` are closed within the
documented deployment contract:

1. Linux and macOS session writers no longer spawn `flock` or load a native
   addon. They use a dependency-free, crash-recoverable, atomic directory
   lease whose live owner is never displaced by elapsed time.
2. Windows no longer executes a committed Base64 DLL. The package ships the
   reviewed C# source, compiles it under a protected ephemeral workspace, and
   preserves the existing anonymous-pipe, handle-allowlist, Job Object,
   authenticated-output, environment/cwd, timeout/abort, and cleanup contracts.

No new npm dependency remains, the prior two CI jobs are preserved, and an
explicit macOS lease job was added.

## TDD evidence

### RED: portable writer lease

The first new child-process test cleared `PATH` and exercised the non-Windows
branch. Against `1e485ef` it failed before entering the callback with
`spawn flock ENOENT`, proving that stock macOS/minimal POSIX could not load any
session. A subsequent dependency probe made native-addon loading throw and
failed the exploratory native implementation with `native addons are
unavailable`; this exposed the musl/unsupported-architecture gap before that
dependency was removed.

### GREEN: portable writer lease

`writer-lock.integration.test.ts` now dynamically installs a native-load trap
before importing the lock module, clears `PATH`, forces the POSIX branch, and
acquires successfully. The focused session run passed 49/49 during development;
the final clean-install lease/consistency gate passed 13 tests with the one
legacy-migration test intentionally skipped on Windows. Ubuntu runs that test,
and the new macOS job runs the same writer/consistency suites.

The required behaviors are covered:

- two live processes serialize and exactly one stale-parent append commits;
- a live lease is not stolen even after its mtime is aged;
- a killed owner is recovered;
- an unlocked regular artifact from the old lock family migrates after the
  documented quiescent cutover;
- no executable or native addon is required.

### RED: reviewed Windows helper source

The package assertion initially failed because clean `dist` had no `.cs` helper
and still contained `windows-bash-supervisor-assembly.js`. After source transport
was introduced, the clean installed-package execution using the public default
`BashTool` failed with `Windows Bash supervisor exited before authenticated
stderr completion`; this exposed the pre-existing bare `bash`/CreateProcessW
PATH bug. The protected-compiler test initially failed with `Timed out waiting
for the private compiler workspace`, proving that `Add-Type` still used an
uncontrolled temp boundary.

### GREEN: reviewed Windows helper source

The final focused security suite passed 13/13. It observes the compiler
workspace while compilation is paused, verifies a protected ACL owned by the
current SID with only current-user and SYSTEM FullControl allow rules, and
proves an actual rename attempt fails while the exclusive guard is open. It
then force-terminates the supervisor and verifies the exact pre-test workspace
set is restored.

The clean package smoke removes `dist`, relies on `prepack` to rebuild it,
packs and installs with lifecycle scripts disabled, imports the installed
public API, resolves default `bash`, executes `printf package-dist-ok`, waits
for the real supervisor PID to exit, and checks for scratch leaks.

### Full-load RED and correction

The first full-suite run exposed one Windows timing failure: runtime C#
compilation consumed the process-tree test's 2.5-second execution budget before
Bash could write its fixture. The process-tree test now gives Windows 7.5
seconds to reach Bash under full-suite load. The dedicated 1 ms/25 ms cold-start
timeout and deterministic abort tests remain unchanged and green. Two subsequent
full checks passed.

## Design decisions

### Dependency-free POSIX lease

Each contender creates a random mode-0700 candidate directory, writes and
`fsync`s a mode-0600 `owner.json` containing version/token/PID/host, then
atomically renames that complete non-empty directory to the stable lock path.
POSIX cannot replace a non-empty destination directory, so only one contender
publishes.

Contention re-reads the owner record. A same-host PID that responds to signal 0,
or any owner whose liveness is uncertain, is treated as live. There is no mtime,
heartbeat, or stale-duration takeover. A definitely dead record is atomically
renamed to a retained token-specific non-empty tombstone. That tombstone is the
ABA guard: a delayed observer of the old token cannot rename a newly published
owner over the already-existing destination. Release verifies token/PID/host,
atomically moves the canonical directory to a token-specific released path,
then removes it. Any ownership or release anomaly is surfaced through the
existing `SessionWriterLockCompromisedError` and store poisoning path.

The legacy regular file uses its device/inode captured in the same `lstat` that
classifies it. This closes the second-stat ABA window. Because pure Node cannot
query an old process's kernel `flock`, README now requires all old POSIX writers
to be quiesced before the first new-version access.

### Direct reviewed-source Windows execution

The unchanged 800-line helper body moved to
`src/tools/windows-bash-supervisor-helper.cs`; its only source change is an
auditability comment. Build copies it verbatim into `dist/tools`. The old DLL
generator and generated Base64 assembly module were deleted.

For each Windows execution, Node lazily reads the adjacent shipped source and
sends it through the existing inherited anonymous stdin. PowerShell reads only
the public source, random compiler path, and test delay first. It then:

1. creates a random LocalApplicationData directory with inheritance disabled;
2. grants FullControl only to current-user and SYSTEM and reads the ACL back;
3. opens `.compile-guard` with `FileShare.None`, preventing parent
   `DELETE_CHILD` replacement;
4. temporarily points process TEMP/TMP there and runs PowerShell 5.1 `Add-Type`;
5. restores TEMP/TMP, closes the guard, recursively deletes the workspace, and
   uses `File.GetAttributes` so only true not-found results count as cleanup;
6. only then reads shell/command/cwd/environment/capability.

Node knows the exact random path and removes it after forced close/disposal as
the kill-path backstop. Bare shell resolution happens inside this already
supervised PowerShell process, so a slow PATH/UNC lookup remains covered by the
Bash timeout and abort. Known Git-for-Windows paths are preferred, caller PATH
is supported, relative entries are anchored to the requested cwd, and the C#
helper still receives an absolute executable path.

## Dependency provenance

Final dependency delta: none. `package-lock.json` is byte-identical to baseline;
the production graph remains the existing exact `typebox@1.1.38`. The final
full and production audits report zero vulnerabilities. Registry verification
reports 59 verified package signatures and 33 attestations.

`fs-native-extensions@1.5.0` (Apache-2.0, registry-provenance-attested) was
evaluated but rejected and removed before commit. Its tarball has Darwin/Linux
x64/arm64 prebuilds but no musl build or source-build fallback, so Alpine and
other minimal/Node-supported POSIX targets would fail at module load. The final
solution introduces no binary/native supply-chain surface.

The package's canonical and built helper source share SHA-256
`a037b6dac947d1e7cef77555f138b0e9d02eb8bf81cae121b68898391763b95d`.
Dry-run packaging contains 174 files, includes exactly
`dist/tools/windows-bash-supervisor-helper.cs`, and contains no obsolete helper
assembly name, DLL, EXE, or B64 artifact.

## Files

- `.github/workflows/ci.yml` — Ubuntu focused lock coverage and macOS job.
- `README.md` — local/PID-namespace scope and mandatory quiescent upgrade.
- `package.json` — asset build, `prepack`, and clean package smoke gates.
- `scripts/copy-runtime-assets.mjs` — verbatim helper source copy.
- `scripts/smoke-package-dist.mjs` — clean pack/install/public Bash smoke.
- `src/session/writer-lock.ts` — dependency-free POSIX lease; Windows holder
  preserved.
- `src/session/writer-lock.integration.test.ts` — no-runtime-dependency,
  migration, live/dead, and serialization coverage.
- `src/tools/windows-bash-supervisor.ts` — protected reviewed-source compile,
  guarded cleanup, supervised resolver, and Node cleanup backstop.
- `src/tools/windows-bash-supervisor-helper.cs` — canonical reviewed helper.
- `src/tools/windows-bash-supervisor.test.ts` — ACL/guard/kill cleanup and
  default-bash coverage.
- `src/tools/tool-integration.test.ts` — full-load-safe process-tree timeout.
- Removed `scripts/build-windows-bash-supervisor-assembly.ps1`, the old helper
  source location, and `src/tools/windows-bash-supervisor-assembly.ts`.

## Final verification

- `npm ci` — 59 packages added, 60 audited, 0 vulnerabilities.
- Focused lease/consistency — 13 passed, 1 Windows-only skip.
- Focused Windows lifecycle/security — 33 passed, 1 intentional skip.
- Windows lifecycle x3 — every iteration 33 passed/1 skipped; each iteration
  compared baseline/after PowerShell+Bash PIDs and compiler directories and
  printed `PASS_NO_LEAK`.
- `npm run check` (final) — 31 files passed; 175 tests passed, 2 skipped; clean
  build, clean installed-package Bash smoke, and CLI EOF smoke all passed.
- `npm audit --audit-level=high` — 0 vulnerabilities.
- `npm audit --omit=dev --audit-level=high` — 0 vulnerabilities.
- `npm audit signatures` — 59 verified signatures, 33 attestations.
- actionlint 1.7.12 — workflow lint passed; official Windows archive SHA-256
  `6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9`.
- `npm pack --dry-run --json` plus content assertions — 174 files, helper source
  present once, 0 prohibited binary/Base64 artifacts, source/dist hashes equal.
- `git diff --check` and final TypeScript typecheck — passed.
- Final leak inspection — 0 compiler workspaces, 0 supervisor scratch
  directories, 0 PowerShell supervisor processes.

The macOS job is committed but cannot be executed on this Windows host; it will
provide native macOS evidence in CI. Ubuntu and macOS use only Node filesystem
primitives in the lease path.

## Self-review

Read-only reviewers challenged the native dependency's musl support, Linux
OFD/flock mixed-version behavior, compiler TEMP availability, compiler-directory
parent replacement, default `bash` lookup, resolver cancellation, legacy
second-stat ABA, dynamic-import test rigor, and full-load timing. The final
implementation either fixed each issue or made the non-interoperable deployment
scope explicit. The canonical C# helper body was compared line-for-line with the
old source (800/800 lines, zero differences after the new leading comment).

No load-bearing blocker remains inside the documented local-filesystem,
same-host/PID-namespace, quiescent-upgrade contract.

## Residual concerns

- Old and new POSIX lock families do not interoperate. Rolling upgrade is
  unsafe; quiescing all old session writers is mandatory and documented.
- PID reuse can make a dead lease appear live. This fails closed (availability
  delay), not open (split-brain).
- A crash can retain candidate/released/reaped artifacts. They do not occupy the
  canonical path; reaped tombstones are deliberately retained as ABA guards,
  but accumulation is currently unbounded.
- The POSIX lease assumes a trusted local filesystem and one host/PID namespace;
  shared network storage and cross-container PID namespaces are unsupported.
- Windows execution now requires local policy to permit Windows PowerShell
  5.1/.NET `Add-Type`. Constrained Language, WDAC, or AppLocker can fail closed.
- Runtime source compilation adds cold-start/AV cost. Dedicated timeout/abort
  tests remain green, and the compilation/resolution phases are inside the
  supervisor termination boundary.
- The committed macOS runner has not yet produced remote CI evidence on this
  unpushed branch.
