export async function* readSseData(
    stream:ReadableStream<Uint8Array>,
):AsyncIterable<string>{
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    let buffer = "";

    try{
        while(true){
            const result = await reader.read();

            if(result.done){
                break;
            }

            buffer += decoder.decode(result.value, {
                stream: true,
            });

            buffer = buffer.replaceAll("\r\n", "\n");

            let boundary = buffer.indexOf("\n\n");

            while(boundary >= 0){
                const frame = buffer.slice(0, boundary);

                buffer = buffer.slice(boundary + 2);

                const data = frame
                    .split("\n")
                    .filter((line) => line.startsWith("data:"))
                    .map((line) => line.slice(5).trimStart())
                    .join("\n");

                if(data.length > 0){
                    yield data;
                }

                boundary = buffer.indexOf("\n\n");
            }
        }

        buffer+= decoder.decode();
    } finally{
        reader.releaseLock();
    }
}