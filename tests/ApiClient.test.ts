import { ApiClient } from '../src/ApiClient';
import { ApiConnectionException, PrintingException } from '../src/errors';

const mockFetch = jest.fn();
global.fetch = mockFetch;

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => mockFetch.mockReset());

describe('ApiClient', () => {
  const client = new ApiClient({ apiKey: 'test-key' });

  it('uses the correct base URL and auth header', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, { data: {} }));
    await client.sendRequest('/test');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.catzprint.com/api/v1/sdk/test');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-key');
  });

  it('serialises the request body as JSON', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    await client.sendRequest('/test', 'POST', { foo: 'bar' });
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBe('{"foo":"bar"}');
  });

  it('throws PrintingException on 4xx', async () => {
    mockFetch.mockResolvedValue(makeResponse(422, { error: { message: 'bad input' } }));
    await expect(client.sendRequest('/test')).rejects.toThrow(PrintingException);
    await expect(client.sendRequest('/test')).rejects.toThrow('422');
  });

  it('throws ApiConnectionException on network failure', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(client.sendRequest('/test')).rejects.toThrow(ApiConnectionException);
  });

  it('accepts a custom baseUrl', async () => {
    mockFetch.mockResolvedValue(makeResponse(200, {}));
    const custom = new ApiClient({ apiKey: 'k', baseUrl: 'https://localhost:3000' });
    await custom.sendRequest('ping');
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://localhost:3000/ping');
  });
});
