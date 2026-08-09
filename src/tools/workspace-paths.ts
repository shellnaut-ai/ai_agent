import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * read/write/edit가 같은 workspace 경계를 공유하도록 경로 해석만 전담한다.
 *
 * lexical 검사는 `..`와 절대경로처럼 문자열만으로 드러나는 탈출을 막고, realpath
 * 검사는 workspace 안의 symlink/junction이 실제로 바깥을 가리키는 우회를 막는다.
 * 파일 도구마다 이 두 검사를 복제하면 새 파일처럼 아직 realpath가 없는 경우의 정책이
 * 서로 달라지므로 한 객체가 기존 파일과 쓰기 대상 경계를 함께 소유한다.
 */
export class WorkspacePaths {
  readonly #rootPath: string;

  constructor(rootDir: string) {
    this.#rootPath = resolve(rootDir);
  }

  /** 이미 존재하는 일반 파일을 실제 경로로 반환한다. */
  async existingFile(requestedPath: string): Promise<string> {
    const targetPath = this.#lexicalTarget(requestedPath);
    const [realRootPath, realTargetPath] = await Promise.all([
      realpath(this.#rootPath),
      realpath(targetPath),
    ]);
    this.#assertInside(realRootPath, realTargetPath);
    if (!(await stat(realTargetPath)).isFile()) {
      throw new Error("Path must point to a file");
    }
    return realTargetPath;
  }

  /**
   * 새 파일이면 안전한 부모를 만든 뒤 lexical target을, 기존 파일이면 실제 경로를 반환한다.
   *
   * mkdir 전에 가장 가까운 기존 부모의 realpath를 확인하는 이유는 `escape/new.txt`에서
   * escape가 외부 junction일 때 workspace 밖에 디렉터리를 먼저 만드는 부작용을 막기 위해서다.
   */
  async writableFile(requestedPath: string): Promise<string> {
    const targetPath = this.#lexicalTarget(requestedPath);
    const realRootPath = await realpath(this.#rootPath);
    let targetExists = true;
    try {
      await lstat(targetPath);
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) throw error;
      targetExists = false;
    }

    if (targetExists) {
      // dangling symlink은 lstat에는 존재하지만 realpath에는 실패한다. 이를 새 파일로
      // 오인하면 write가 링크 대상을 따라갈 수 있으므로 그대로 실행 오류로 남긴다.
      const realTargetPath = await realpath(targetPath);
      this.#assertInside(realRootPath, realTargetPath);
      if (!(await stat(realTargetPath)).isFile()) {
        throw new Error("Path must point to a file");
      }
      return realTargetPath;
    }

    const parentPath = dirname(targetPath);
    const existingAncestor = await nearestExistingAncestor(parentPath);
    this.#assertInside(realRootPath, await realpath(existingAncestor));
    await mkdir(parentPath, { recursive: true });
    // mkdir와 실제 write 사이의 정적 경계를 한 번 더 확인한다. 완전한 TOCTOU 방지는
    // OS sandbox가 필요하지만, 생성 과정에서 생긴 symlink/junction 우회는 여기서 잡는다.
    this.#assertInside(realRootPath, await realpath(parentPath));
    return targetPath;
  }

  #lexicalTarget(requestedPath: string): string {
    if (requestedPath === "") throw new Error("Path must not be empty");
    const targetPath = resolve(this.#rootPath, requestedPath);
    const fromRoot = relative(this.#rootPath, targetPath);
    if (fromRoot === "") {
      throw new Error("Path must point below the workspace root");
    }
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error("Path must stay within the configured root directory");
    }
    return targetPath;
  }

  #assertInside(realRootPath: string, realTargetPath: string): void {
    const fromRoot = relative(realRootPath, realTargetPath);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error("Path must stay within the configured root directory");
    }
  }
}

async function nearestExistingAncestor(startPath: string): Promise<string> {
  let candidate = startPath;
  while (true) {
    try {
      await lstat(candidate);
      return candidate;
    } catch (error: unknown) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
