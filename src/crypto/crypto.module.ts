import { Global, Module } from '@nestjs/common';
import { TokenEncryptionService } from './token-encryption.service';

@Global()
@Module({
  providers: [TokenEncryptionService],
  exports: [TokenEncryptionService],
})
export class CryptoModule {}
