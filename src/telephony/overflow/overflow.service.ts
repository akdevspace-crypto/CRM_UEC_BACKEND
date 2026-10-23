import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

export interface CreateCallbackDto {
  phoneNumber: string;
  customerId?: string;
  leadId?: string;
  department?: string;
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'EMERGENCY';
  notes?: string;
}

@Injectable()
export class OverflowService {
  private readonly logger = new Logger(OverflowService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registers a callback request when queue timeout occurs or capacity is exhausted.
   */
  async registerCallback(dto: CreateCallbackDto) {
    this.logger.log(`[OVERFLOW-CALLBACK] Registering callback for ${dto.phoneNumber} dept=${dto.department || 'GENERAL'}`);
    try {
      if ((this.prisma as any).callbackRequest?.create) {
        return await (this.prisma as any).callbackRequest.create({
          data: {
            phoneNumber: dto.phoneNumber,
            customerId: dto.customerId || null,
            leadId: dto.leadId || null,
            department: dto.department || 'GENERAL',
            priority: dto.priority || 'NORMAL',
            status: 'PENDING',
            notes: dto.notes || 'Automated queue overflow callback request',
          },
        });
      }

      // Fallback: Create a QueueItem with status OVERFLOW so callback is never lost
      this.logger.warn(`[OVERFLOW-CALLBACK] Fallback to QueueItem storage`);
      const isValidUuid = (val?: string) =>
        typeof val === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
      const safeCustomerId = isValidUuid(dto.customerId) ? dto.customerId : '00000000-0000-0000-0000-000000000000';
      return await (this.prisma as any).queueItem.create({
        data: {
          customerId: safeCustomerId,
          department: dto.department || 'GENERAL',
          priority: (dto.priority as any) || 'NORMAL',
          status: 'OVERFLOW',
          outcome: `CALLBACK:${dto.phoneNumber}`,
          waitDuration: 300,
          enteredAt: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.error(`[OVERFLOW-CALLBACK] Failed to register callback: ${err.message}`);
      return null;
    }
  }

  /**
   * Retrieves pending callback requests for the contact center dashboard.
   */
  async getPendingCallbacks(department?: string) {
    try {
      if ((this.prisma as any).callbackRequest?.findMany) {
        const callbacks = await (this.prisma as any).callbackRequest.findMany({
          where: {
            status: 'PENDING',
            ...(department ? { department } : {}),
          },
          orderBy: [{ priority: 'desc' }, { requestedAt: 'asc' }],
          take: 50,
        }).catch(() => null);

        if (callbacks) return callbacks;
      }

      // Fallback: Query QueueItem with status: 'OVERFLOW'
      const items = await (this.prisma as any).queueItem.findMany({
        where: {
          status: 'OVERFLOW',
          ...(department ? { department } : {}),
        },
        orderBy: { enteredAt: 'asc' },
        take: 50,
      });

      return items.map((i: any) => ({
        id: i.id,
        phoneNumber: (i.outcome || '').replace('CALLBACK:', '').trim() || 'Unknown',
        customerId: i.customerId,
        leadId: null,
        department: i.department,
        priority: i.priority,
        requestedAt: i.enteredAt,
        status: i.status,
        customerName: 'Customer',
        notes: `Queue wait timeout overflow: ${i.outcome}`,
      }));
    } catch (e: any) {
      this.logger.warn(`[OVERFLOW-CALLBACK] Error fetching callbacks: ${e.message}`);
      return [];
    }
  }

  /**
   * Marks a callback request as processed when an agent dials the customer back.
   */
  async markCallbackProcessed(id: string, agentId?: string) {
    try {
      await (this.prisma as any).callbackRequest?.update({
        where: { id },
        data: { status: 'PROCESSED', processedAt: new Date() },
      }).catch(async () => {
        // Fallback update queue item
        await (this.prisma as any).queueItem.update({
          where: { id },
          data: { status: 'PROCESSED', outcome: 'CALLBACK_PROCESSED' },
        });
      });
      return { success: true };
    } catch (e: any) {
      this.logger.warn(`[OVERFLOW-CALLBACK] Error marking processed: ${e.message}`);
      return { success: false };
    }
  }
}
