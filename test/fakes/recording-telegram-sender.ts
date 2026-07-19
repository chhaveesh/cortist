export interface SentMessage {
  chatId: string;
  text: string;
}

/**
 * Captures outbound Telegram messages instead of sending them.
 *
 * Asserting on what the user was actually *told* is the point: a test that only
 * checks "no event was created" would pass even if the agent silently did
 * nothing, which is a bad experience dressed up as correct behaviour.
 *
 * Shaped to match TelegramSenderService's public surface so it can be swapped
 * in via `overrideProvider(...).useValue(...)`.
 */
export class RecordingTelegramSender {
  readonly sent: SentMessage[] = [];
  private failNext = false;

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated Telegram failure');
    }
    this.sent.push({ chatId, text });
  }

  /** Simulate a Telegram outage on the next send. */
  failNextSend(): void {
    this.failNext = true;
  }

  get last(): SentMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  /** All sent text joined — convenient for a single "did we mention X" assertion. */
  get transcript(): string {
    return this.sent.map((message) => message.text).join('\n---\n');
  }

  reset(): void {
    this.sent.length = 0;
    this.failNext = false;
  }
}
