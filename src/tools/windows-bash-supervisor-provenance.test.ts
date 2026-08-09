import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

const powershell = join(
  process.env["SystemRoot"] ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);
const verifier = resolve(
  "scripts/verify-windows-bash-supervisor-assembly.ps1",
);
const canonicalSource = resolve(
  "src/tools/windows-bash-supervisor-helper.cs",
);
const canonicalPayload = resolve(
  "src/tools/windows-bash-supervisor-reviewed-assembly.ts",
);

test.skipIf(process.platform !== "win32")(
  "accepts only the complete normalized semantics of the reviewed helper source",
  async () => {
    await expect(runVerifier(canonicalSource, canonicalPayload)).resolves.toMatch(
      /matches the complete normalized source manifest/i,
    );

    const rootDir = await mkdtemp(join(tmpdir(), "bash-provenance-tamper-"));
    try {
      const source = await readFile(canonicalSource, "utf8");
      const mutations = [
        [
          "constant",
          "private const uint CREATE_SUSPENDED = 0x00000004;",
          "private const uint CREATE_SUSPENDED = 0x00000008;",
        ],
        [
          "sequential-field-order",
          "        public int nLength;\n        public IntPtr lpSecurityDescriptor;",
          "        public IntPtr lpSecurityDescriptor;\n        public int nLength;",
        ],
        [
          "field-rva-bytes",
          "new[] { ' ', '\\t', '\\n', '\\v', '\"' }",
          "new[] { '!', '\\t', '\\n', '\\v', '\"' }",
        ],
      ] as const;

      for (const [name, before, after] of mutations) {
        const tamperedSource = join(rootDir, `${name}.cs`);
        const tampered = source.replace(before, after);
        expect(tampered, `${name} mutation did not apply`).not.toBe(source);
        await writeFile(tamperedSource, tampered, "utf8");

        await expect(
          runVerifier(tamperedSource, canonicalPayload),
        ).rejects.toThrow(
          /(?:semantic manifest|normalized whole PE image) differs from source/i,
        );
      }

      const canonicalPayloadText = await readFile(canonicalPayload, "utf8");
      const decoyPayload = join(rootDir, "decoy-payload.ts");
      await writeFile(
        decoyPayload,
        `/*\n${canonicalPayloadText}\n*/\n` +
          "export const WINDOWS_BASH_SUPERVISOR_REVIEWED_ASSEMBLY_SHA256 =\n" +
          `  "${"0".repeat(64)}";\n\n` +
          "export const WINDOWS_BASH_SUPERVISOR_REVIEWED_ASSEMBLY_BASE64 = [\n" +
          "  \"AA==\",\n" +
          "].join(\"\");\n",
        "utf8",
      );
      await expect(
        runVerifier(canonicalSource, decoyPayload),
      ).rejects.toThrow(/canonical generated-file grammar/i);

      const canonicalBase64 = [
        ...canonicalPayloadText.matchAll(
          /^  "(?<chunk>[A-Za-z0-9+/=]+)",$/gmu,
        ),
      ].map((match) => match.groups?.["chunk"] ?? "").join("");
      const peHeaderTamperedBytes = Buffer.from(canonicalBase64, "base64");
      const peOffset = peHeaderTamperedBytes.readUInt32LE(0x3c);
      const optionalHeaderOffset = peOffset + 24;
      const optionalHeaderMagic = peHeaderTamperedBytes.readUInt16LE(
        optionalHeaderOffset,
      );
      expect([0x10b, 0x20b]).toContain(optionalHeaderMagic);
      const dllCharacteristicsOffset = optionalHeaderOffset + 70;
      const originalDllCharacteristics = peHeaderTamperedBytes.readUInt16LE(
        dllCharacteristicsOffset,
      );
      expect(originalDllCharacteristics & 0x140).toBe(0x140);
      peHeaderTamperedBytes.writeUInt16LE(
        originalDllCharacteristics & ~0x140,
        dllCharacteristicsOffset,
      );
      const peHeaderTamperedPayload = join(rootDir, "pe-header-payload.ts");
      await writeFile(
        peHeaderTamperedPayload,
        serializePayload(peHeaderTamperedBytes),
        "utf8",
      );
      await expect(
        runVerifier(canonicalSource, peHeaderTamperedPayload),
      ).rejects.toThrow(/PE\/COFF\/CLR header manifest differs/i);

      const sections = readPeSections(peHeaderTamperedBytes);
      for (const sectionName of [".text", ".rsrc", ".reloc"] as const) {
        const section = sections.get(sectionName);
        expect(section, `${sectionName} section is required`).toBeDefined();
        const sectionTamperedBytes = Buffer.from(
          Buffer.from(canonicalBase64, "base64"),
        );
        const mutationOffset = section!.rawOffset + section!.rawSize - 1;
        expect(mutationOffset).toBeLessThan(sectionTamperedBytes.length);
        sectionTamperedBytes[mutationOffset] =
          (sectionTamperedBytes[mutationOffset] ?? 0) ^ 0x01;
        const sectionTamperedPayload = join(
          rootDir,
          `${sectionName.slice(1)}-body-payload.ts`,
        );
        await writeFile(
          sectionTamperedPayload,
          serializePayload(sectionTamperedBytes),
          "utf8",
        );

        await expect(
          runVerifier(canonicalSource, sectionTamperedPayload),
          `${sectionName} body mutation must be bound to reviewed source`,
        ).rejects.toThrow(/normalized whole PE image differs/i);
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  },
  30_000,
);

function serializePayload(bytes: Buffer): string {
  const base64 = bytes.toString("base64");
  const chunks: string[] = [];
  for (let offset = 0; offset < base64.length; offset += 100) {
    chunks.push(`  "${base64.slice(offset, offset + 100)}",`);
  }

  return [
    "// Generated only from windows-bash-supervisor-helper.cs by Windows PowerShell 5.1.",
    "// CI recompiles the source and compares a complete normalized semantic manifest.",
    "export const WINDOWS_BASH_SUPERVISOR_REVIEWED_ASSEMBLY_SHA256 =",
    `  "${createHash("sha256").update(bytes).digest("hex")}";`,
    "",
    "export const WINDOWS_BASH_SUPERVISOR_REVIEWED_ASSEMBLY_BASE64 = [",
    ...chunks,
    '].join("");',
    "",
  ].join("\n");
}

function readPeSections(
  bytes: Buffer,
): Map<string, { readonly rawOffset: number; readonly rawSize: number }> {
  const peOffset = bytes.readUInt32LE(0x3c);
  const sectionCount = bytes.readUInt16LE(peOffset + 6);
  const optionalHeaderSize = bytes.readUInt16LE(peOffset + 20);
  const sectionTableOffset = peOffset + 24 + optionalHeaderSize;
  const sections = new Map<
    string,
    { readonly rawOffset: number; readonly rawSize: number }
  >();

  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTableOffset + index * 40;
    const name = bytes
      .toString("ascii", offset, offset + 8)
      .replace(/\0+$/u, "");
    sections.set(name, {
      rawSize: bytes.readUInt32LE(offset + 16),
      rawOffset: bytes.readUInt32LE(offset + 20),
    });
  }

  return sections;
}

function runVerifier(sourcePath: string, payloadPath: string): Promise<string> {
  return new Promise((resolveRun, reject) => {
    execFile(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        verifier,
        "-InputSourcePath",
        sourcePath,
        "-InputPayloadPath",
        payloadPath,
      ],
      {
        encoding: "utf8",
        timeout: 25_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolveRun(stdout);
        } else {
          reject(new Error(stderr || stdout || error.message, { cause: error }));
        }
      },
    );
  });
}
