import { copyFile, mkdir } from "node:fs/promises";

const sourceUrl = new URL(
  "../src/tools/windows-bash-supervisor-helper.cs",
  import.meta.url,
);
const destinationUrl = new URL(
  "../dist/tools/windows-bash-supervisor-helper.cs",
  import.meta.url,
);

await mkdir(new URL("../dist/tools/", import.meta.url), { recursive: true });
await copyFile(sourceUrl, destinationUrl);
