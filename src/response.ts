/** Bound each response stream before the MCP SDK parses JSON or server events. */
export function boundedResponse(response: Response, maximum: number): Response {
    if (!response.body) return response;
    let received = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                received += chunk.byteLength;
                if (received > maximum) throw new Error("The Pollen response exceeds its byte limit.");
                decoder.decode(chunk, { stream: true });
                controller.enqueue(chunk);
            },
            flush() {
                decoder.decode();
            },
        }),
    );
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}
