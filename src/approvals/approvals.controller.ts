import { Controller, Get, Post, Put, Param, Body, Query, NotFoundException } from '@nestjs/common';
import { Roles } from '../api-gateway/roles.guard';

@Controller('api/v1/approvals')
export class ApprovalsController {
  @Get()
  async getApprovals(@Query('requesterId') requesterId?: string) {
    return [];
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER')
  @Put(':id/review')
  async reviewApproval(@Param('id') id: string, @Body() body: any) {
    throw new NotFoundException(`Approval request '${id}' not found`);
  }
}
