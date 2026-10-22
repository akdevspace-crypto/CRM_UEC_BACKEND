import { Controller, Post, Get, Body, Param, Query, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import { DeduplicationService } from './deduplication.service';
import type { DuplicateCheckDto, MergeLeadsDto } from './deduplication.service';
import { DuplicateMatchOutcome } from '@prisma/client';

@Controller(['api/v1/leads/duplicates', 'leads/duplicates'])
export class DeduplicationController {
  constructor(private readonly deduplicationService: DeduplicationService) {}

  @Post('check')
  async checkDuplicate(@Body() dto: DuplicateCheckDto) {
    return await this.deduplicationService.checkDuplicate(dto);
  }

  @Get()
  async getDuplicateReviews(@Query() query: any) {
    return await this.deduplicationService.getDuplicateReviews(query);
  }

  @Post('scan')
  async scanForDuplicates(@Query('limit') limit?: string, @Req() req?: any) {
    const user = (req as any)?.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER'].includes(user.role);
    if (!isElevated) {
      throw new ForbiddenException('Only administrators and supervisors can trigger lead deduplication scans');
    }
    const batchSize = limit ? parseInt(limit, 10) : 100;
    return await this.deduplicationService.scanForDuplicates(batchSize);
  }

  @Post(':id/resolve')
  async resolveReview(
    @Param('id') id: string,
    @Body() body: { status: DuplicateMatchOutcome; notes?: string },
    @Req() req: any,
  ) {
    const user = (req as any)?.user;
    return await this.deduplicationService.resolveReview(id, body.status, body.notes, user);
  }

  @Post('merge')
  async mergeLeads(@Body() dto: MergeLeadsDto, @Req() req: any) {
    const user = (req as any)?.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'AGENT', 'SALES_AGENT'].includes(user.role);
    if (!isElevated) {
      throw new ForbiddenException('Forbidden: You do not have permission to merge leads');
    }
    return await this.deduplicationService.mergeLeads(dto, user);
  }
}
