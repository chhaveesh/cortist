import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Env } from '../config/env.schema';

/**
 * Authenticated encryption for OAuth tokens at rest.
 *
 * AES-256-GCM rather than AES-CBC: GCM authenticates the ciphertext, so a
 * tampered row fails to decrypt instead of yielding attacker-influenced
 * plaintext. A fresh random IV per encryption is mandatory — reusing an IV
 * under the same key breaks GCM catastrophically, leaking the keystream.
 *
 * Envelope format: `v1:<iv-hex>:<authTag-hex>:<ciphertext-hex>`. The version
 * prefix lets a future algorithm change decrypt old rows during migration
 * rather than orphaning them.
 */
@Injectable()
export class TokenEncryptionService {
  private static readonly VERSION = 'v1';
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly IV_BYTES = 12; // 96 bits — the GCM-recommended size
  private static readonly AUTH_TAG_BYTES = 16;

  private readonly key: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const hexKey: string = config.get('TOKEN_ENCRYPTION_KEY', { infer: true });
    this.key = Buffer.from(hexKey, 'hex');

    // The env schema already enforces this; assert anyway, because a short key
    // here would silently weaken every token in the database.
    if (this.key.length !== 32) {
      throw new Error(
        `TOKEN_ENCRYPTION_KEY must decode to 32 bytes, got ${this.key.length}`,
      );
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(TokenEncryptionService.IV_BYTES);
    const cipher = createCipheriv(
      TokenEncryptionService.ALGORITHM,
      this.key,
      iv,
    );

    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return [
      TokenEncryptionService.VERSION,
      iv.toString('hex'),
      authTag.toString('hex'),
      ciphertext.toString('hex'),
    ].join(':');
  }

  /**
   * @throws if the envelope is malformed, or if the ciphertext or auth tag has
   *         been tampered with.
   */
  decrypt(envelope: string): string {
    const parts = envelope.split(':');

    if (parts.length !== 4) {
      throw new Error('Malformed ciphertext envelope');
    }

    const [version, ivHex, authTagHex, ciphertextHex] = parts;

    if (version !== TokenEncryptionService.VERSION) {
      throw new Error(`Unsupported ciphertext version: ${version}`);
    }

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    if (
      iv.length !== TokenEncryptionService.IV_BYTES ||
      authTag.length !== TokenEncryptionService.AUTH_TAG_BYTES
    ) {
      throw new Error('Malformed ciphertext envelope');
    }

    const decipher = createDecipheriv(
      TokenEncryptionService.ALGORITHM,
      this.key,
      iv,
    );
    decipher.setAuthTag(authTag);

    // `final()` throws when the auth tag does not verify.
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }

  /** Constant-time equality, for comparing secrets without leaking timing. */
  static safeEquals(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(b, 'utf8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
