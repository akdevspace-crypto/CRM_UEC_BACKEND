import { Module } from '@nestjs/common';
import { WebsiteLeadsController } from './website-leads.controller';
import { WebsiteLeadsService } from './website-leads.service';
import { WebsiteLeadsRegistry } from './website-leads.registry';
import { PrismaModule } from '../../prisma/prisma.module';
import { TelephonyModule } from '../../telephony/telephony.module';

@Module({
  imports: [PrismaModule, TelephonyModule],
  controllers: [WebsiteLeadsController],
  providers: [WebsiteLeadsService, WebsiteLeadsRegistry],
  exports: [WebsiteLeadsService, WebsiteLeadsRegistry],
})
export class WebsiteLeadsModule {}
