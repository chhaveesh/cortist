import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.schema';

export interface SendOptions {
  /**
   * Tappable quick replies shown under the message.
   *
   * A REPLY keyboard, not an inline one, and that choice is load-bearing:
   * tapping a reply keyboard sends an ordinary text message, so the answer
   * arrives through the same webhook → queue → router path as anything typed.
   * Inline buttons post a `callback_query` instead, which is a different update
   * type the gateway, the job contract, and the router would all have to learn.
   * The user-visible difference is small; the structural one is not.
   */
  quickReplies?: string[];
  /** Clears a previously shown keyboard once it is no longer relevant. */
  clearKeyboard?: boolean;
}

function replyMarkupFor(options: SendOptions): Record<string, unknown> {
  if (options.quickReplies?.length) {
    return {
      reply_markup: {
        keyboard: [options.quickReplies.map((text) => ({ text }))],
        // Collapses after one tap, so the keyboard does not linger over the
        // conversation once the question is answered.
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    };
  }

  if (options.clearKeyboard) {
    return { reply_markup: { remove_keyboard: true } };
  }

  return {};
}

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
  async sendMessage(
    chatId: string,
    text: string,
    options: SendOptions = {},
  ): Promise<void> {
    const response = await fetch(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          ...replyMarkupFor(options),
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
