import { ConfigService } from '@nestjs/config';
import { TokenEncryptionService } from '../../src/crypto/token-encryption.service';

const KEY_A =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const KEY_B =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

function serviceWithKey(hexKey: string): TokenEncryptionService {
  return new TokenEncryptionService({
    get: () => hexKey,
  } as unknown as ConfigService<never, true>);
}

describe('TokenEncryptionService', () => {
  let service: TokenEncryptionService;

  beforeEach(() => {
    service = serviceWithKey(KEY_A);
  });

  it('round-trips a token', () => {
    const token = 'ya29.a0AfH6SMBx-example-google-access-token';
    expect(service.decrypt(service.encrypt(token))).toBe(token);
  });

  it('round-trips unicode and empty strings', () => {
    expect(service.decrypt(service.encrypt(''))).toBe('');
    expect(service.decrypt(service.encrypt('héllo 🌍 世界'))).toBe(
      'héllo 🌍 世界',
    );
  });

  it('never emits the plaintext in the envelope', () => {
    const token = 'super-secret-refresh-token';
    expect(service.encrypt(token)).not.toContain(token);
  });

  it('produces a different ciphertext each time (fresh IV)', () => {
    const token = 'the-same-token';
    const first = service.encrypt(token);
    const second = service.encrypt(token);

    // Equal ciphertexts would mean a reused IV, which breaks GCM outright.
    expect(first).not.toBe(second);
    expect(service.decrypt(first)).toBe(token);
    expect(service.decrypt(second)).toBe(token);
  });

  it('rejects a tampered ciphertext body', () => {
    const envelope = service.encrypt('token');
    const [version, iv, tag, ciphertext] = envelope.split(':');

    // Flip the final byte of the ciphertext.
    const flipped =
      ciphertext.slice(0, -2) + (ciphertext.endsWith('00') ? '01' : '00');

    expect(() =>
      service.decrypt([version, iv, tag, flipped].join(':')),
    ).toThrow();
  });

  it('rejects a tampered auth tag', () => {
    const [version, iv, tag, ciphertext] = service.encrypt('token').split(':');
    const flipped = tag.slice(0, -2) + (tag.endsWith('00') ? '01' : '00');

    expect(() =>
      service.decrypt([version, iv, flipped, ciphertext].join(':')),
    ).toThrow();
  });

  it('rejects a ciphertext encrypted under a different key', () => {
    const envelope = serviceWithKey(KEY_B).encrypt('token');
    expect(() => service.decrypt(envelope)).toThrow();
  });

  it.each([
    ['too few segments', 'v1:aabb:ccdd'],
    ['too many segments', 'v1:aa:bb:cc:dd'],
    ['unknown version', 'v2:aabb:ccdd:eeff'],
    ['empty string', ''],
    ['short iv', 'v1:aabb:00112233445566778899aabbccddeeff:aabb'],
  ])('rejects a malformed envelope (%s)', (_name, envelope) => {
    expect(() => service.decrypt(envelope)).toThrow();
  });

  it('refuses to construct with a key of the wrong length', () => {
    expect(() => serviceWithKey('abcd')).toThrow(/32 bytes/);
  });

  describe('safeEquals', () => {
    it('compares equal and unequal strings correctly', () => {
      expect(TokenEncryptionService.safeEquals('secret', 'secret')).toBe(true);
      expect(TokenEncryptionService.safeEquals('secret', 'secreT')).toBe(false);
      expect(TokenEncryptionService.safeEquals('secret', 'longer-secret')).toBe(
        false,
      );
    });
  });
});
