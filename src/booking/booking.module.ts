import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingAIToolsService } from './booking-ai.service';
import { BookingController } from './booking.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AgentModule } from '../agent/agent.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [PrismaModule, AgentModule, NotificationModule],
  controllers: [BookingController],
  providers: [BookingService, BookingAIToolsService],
  exports: [BookingService, BookingAIToolsService],
})
export class BookingModule {}
