/** The JSON text a stubbed fetch was called with. */
export function requestBody(init: RequestInit): string {
  if (typeof init.body !== 'string') {
    throw new TypeError('expected a JSON string body');
  }
  return init.body;
}
