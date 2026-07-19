import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.schema';

/**
 * Outbound half of the Telegram integration — the first thing in Cortist that
 * actually uses TELEGRAM_BOT_TOKEN.
 *
 * Kept as its own injectable so tests can substitute a recording fake and
 * assert on what the agent said, without any network access.
 */
@Injectable()
export class TelegramSenderService {
  private readonly logger = new Logger(TelegramSenderService.name);
  private readonly botToken: string;

  constructor(config: ConfigService<Env, true>) {
    this.botToken = config.get('TELEGRAM_BOT_TOKEN', { infer: true });
  }

  /**
   * Sends a plain-text message. Deliberately not Markdown/HTML parse_mode:
   * event titles come from user data, and an unbalanced `*` or `_` would make
   * Telegram reject the whole message.
   */
  async sendMessage(chatId: string, text: string): Promise<void> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      throw new Error(
        `Telegram sendMessage failed (${response.status}): ${body}`,
      );
    }

    this.logger.debug(`Sent ${text.length} chars to chat ${chatId}`);
  }
}
