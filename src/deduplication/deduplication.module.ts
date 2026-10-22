import { Module } from '@nestjs/common';
import { DeduplicationService } from './deduplication.service';
import { DeduplicationController } from './deduplication.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [DeduplicationController],
  providers: [DeduplicationService],
  exports: [DeduplicationService],
})
export class DeduplicationModule {}
