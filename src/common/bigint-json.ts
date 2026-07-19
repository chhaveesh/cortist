/**
 * Prisma returns BigInt for 64-bit columns, and `JSON.stringify` throws on
 * BigInt by default. Serializing them as decimal strings matches how the queue
 * contract encodes Telegram ids, so the two representations agree.
 *
 * Called once per process at startup.
 */
export function registerBigIntJson(): void {
  const proto = BigInt.prototype as unknown as { toJSON?: () => string };
  if (typeof proto.toJSON !== 'function') {
    proto.toJSON = function toJSON(this: bigint): string {
      return this.toString();
    };
  }
}
