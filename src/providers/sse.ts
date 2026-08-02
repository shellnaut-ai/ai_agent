/**
 * byte chunk로 도착한 Server-Sent Events에서 완성된 data payload만 꺼낸다.
 *
 * 네트워크 chunk, 줄, SSE event는 서로 다른 경계다. Provider마다 이 코드를 복제하면
 * CRLF나 multiline data 처리 차이가 생기므로 HTTP 스트림 framing만 공통으로 둔다.
 */
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
    // SSE 사양은 colon 뒤 선택적 공백 하나만 제거한다. JSON 내부 공백은 보존한다.
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
