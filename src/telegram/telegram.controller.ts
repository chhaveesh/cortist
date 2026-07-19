import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { TelegramSecretGuard } from './telegram-secret.guard';
import { TelegramService } from './telegram.service';
import { TelegramUpdate, telegramUpdateSchema } from './telegram.schema';

@Controller('telegram')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(private readonly telegram: TelegramService) {}

  /**
   * Telegram webhook sink.
   *
   * Always answers 200 for anything that passed authentication and schema
   * validation — including updates we deliberately ignore. A non-2xx tells
   * Telegram to retry, and retrying an update we will never act on just wastes
   * deliveries.
   */
  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TelegramSecretGuard)
  @UsePipes(new ZodValidationPipe(telegramUpdateSchema))
  async handleWebhook(
    @Body() update: TelegramUpdate,
  ): Promise<{ ok: true; status: string }> {
    const outcome = await this.telegram.ingestUpdate(update);
    return { ok: true, status: outcome.status };
  }
}
