import { Module } from '@nestjs/common';
import { EnquiryController } from './enquiry.controller';
import { EnquiryService } from './enquiry.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [EnquiryController],
  providers: [EnquiryService],
  exports: [EnquiryService],
})
export class EnquiryModule {}
