/** Additional provider responses are deliberately tiny. The SDK's requested
 * output-token cap is not a memory limit if a provider ignores it. */
export const AUTOMATIC_RESPONSE_BYTES = 96_000;

export function boundedAnnotationFetch(inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const response = await inner(input, { ...init, redirect: 'error' });
    if (!response.body) return response;
    const reader = response.body.getReader();
    let bytes = 0;
    if (Number(response.headers.get('content-length')) > AUTOMATIC_RESPONSE_BYTES) {
      await reader.cancel();
      throw Error('The annotation response exceeded its size limit.');
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            controller.close();
            return;
          }
          bytes += chunk.value.byteLength;
          if (bytes > AUTOMATIC_RESPONSE_BYTES) {
            await reader.cancel();
            controller.error(Error('The annotation response exceeded its size limit.'));
          } else controller.enqueue(chunk.value);
        } catch {
          controller.error(Error('The annotation response could not be read.'));
        }
      },
      cancel: () => reader.cancel(),
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}
