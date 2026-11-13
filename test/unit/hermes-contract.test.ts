import { describe, expect, it } from 'vitest';
import { hermesSigningString } from '../../src/routes/hermes';
import { hmacSha256Hex } from '../../src/utils/hmac';

/**
 * Cross-language contract: the same vectors are asserted by hermes-plugin/tests/test_transfer_client.py
 * (Python poller) and were checked with `openssl dgst -sha256 -hmac`. If either side changes the signing
 * string, one of the two suites fails.
 */
describe('Hermes request signature contract', () => {
  const secret = 'hermes-contract-secret';
  it('poll', async () => {
    const s = hermesSigningString('1700000000', 'get', '/hermes/poll?limit=10&wait=5000', '');
    expect(s).toBe('1700000000.GET./hermes/poll?limit=10&wait=5000.');
    expect(`sha256=${await hmacSha256Hex(secret, s)}`).toBe('sha256=9ec00d9c7ae8cf46b983493cbfcc359316565d3a7d06ac3990d047d48812691c');
  });
  it('ack', async () => {
    const s = hermesSigningString('1700000000', 'POST', '/hermes/ack', '{"deliveryId":"d-1","status":"delivered","result":null}');
    expect(`sha256=${await hmacSha256Hex(secret, s)}`).toBe('sha256=bee039a7485c955fd2c6af601d40b60479be184b953f3e295d61bf13b3603577');
  });
});
