import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';

@Module({
  controllers: [ApprovalsController],
})
export class ApprovalsModule {}
