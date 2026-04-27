import { ApiClient } from '../src/ApiClient';
import { Printing } from '../src/Printing';
import { PrintingException } from '../src/errors';

jest.mock('../src/ApiClient');

const MockApiClient = ApiClient as jest.MockedClass<typeof ApiClient>;

describe('Printing', () => {
  let client: jest.Mocked<ApiClient>;

  beforeEach(() => {
    client = new MockApiClient({ apiKey: 'x' }) as jest.Mocked<ApiClient>;
    client.sendRequest = jest.fn();
  });

  it('sends a POST to /print-job with content and orderId', async () => {
    client.sendRequest.mockResolvedValue({ data: { pjId: 'pj-42' } });

    const pjId = await Printing.newPrintTask(client)
      .content('{"json":true}')
      .orderId('order-1')
      .send();

    expect(pjId).toBe('pj-42');
    expect(client.sendRequest).toHaveBeenCalledWith(
      '/print-job',
      'POST',
      expect.objectContaining({ content: '{"json":true}', orderId: 'order-1', source: 'typescript' }),
    );
  });

  it('throws PrintingException when content is empty', async () => {
    await expect(Printing.newPrintTask(client).send()).rejects.toThrow(PrintingException);
  });

  it('returns empty string when pjId is missing', async () => {
    client.sendRequest.mockResolvedValue({ data: {} });
    const pjId = await Printing.newPrintTask(client).content('{}').send();
    expect(pjId).toBe('');
  });
});
