/** Extract complete `data` payloads from a byte-streamed SSE response. */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let dataLines: string[] = [];

  const consumeLine = (line: string): string | undefined => {
    if (line === "") {
      if (dataLines.length === 0) return undefined;
      const data = dataLines.join("\n");
      dataLines = [];
      return data;
    }

    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, "");
        buffered = buffered.slice(newline + 1);
        const data = consumeLine(line);
        if (data !== undefined) yield data;
      }
    }

    buffered += decoder.decode();
    if (buffered !== "") {
      const data = consumeLine(buffered.replace(/\r$/, ""));
      if (data !== undefined) yield data;
    }
    const finalData = consumeLine("");
    if (finalData !== undefined) yield finalData;
  } finally {
    reader.releaseLock();
  }
}
