import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { Env } from '../config/env.schema';

export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * Verifies the shared secret Telegram echoes back on every webhook delivery
 * (registered once via setWebhook's `secret_token` parameter).
 *
 * Without this, anyone who learns the webhook URL can inject messages
 * attributed to arbitrary Telegram users.
 */
@Injectable()
export class TelegramSecretGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(config: ConfigService<Env, true>) {
    const secret: string = config.get('TELEGRAM_WEBHOOK_SECRET', {
      infer: true,
    });
    this.expected = Buffer.from(secret, 'utf8');
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.header(TELEGRAM_SECRET_HEADER);

    if (!provided || !this.matches(provided)) {
      throw new UnauthorizedException('Invalid webhook secret token');
    }

    return true;
  }

  /**
   * Constant-time comparison. Length is checked first because timingSafeEqual
   * throws on mismatched buffers — that leaks length only, which is not
   * sensitive here.
   */
  private matches(provided: string): boolean {
    const candidate = Buffer.from(provided, 'utf8');
    if (candidate.length !== this.expected.length) return false;
    return timingSafeEqual(candidate, this.expected);
  }
}
