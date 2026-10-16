import { Controller, Get, Param, Logger, Put, Req, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('api/v1/conversations')
export class OmnichannelController {
  private readonly logger = new Logger(OmnichannelController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async getConversations(@Req() req: any) {
    this.logger.log('Fetching omnichannel conversations');
    const user = req?.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user.role);

    const whereClause: any = {};
    if (!isElevated && user) {
      whereClause.OR = [
        { agentId: user.agentId },
        { agentId: user.id },
        { agentId: null }, // Unassigned pool
      ];
    }

    const conversations = await this.prisma.conversation.findMany({
      where: whereClause,
      include: {
        customer: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    return conversations.map(c => ({
      id: c.id,
      customerId: c.customerId,
      customerName: c.customer?.name || 'Unknown',
      lastMessage: 'Conversation opened', 
      timestamp: c.updatedAt.toISOString(),
      status: c.status,
      channel: c.channel.toLowerCase(),
      unreadCount: c.unreadCount,
      priority: c.priority.toLowerCase(),
    }));
  }

  @Get(':id/messages')
  async getMessages(@Param('id') id: string, @Req() req: any) {
    if (!UUID_REGEX.test(id)) {
      throw new NotFoundException('Conversation not found');
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    const user = req?.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user.role);
    if (!isElevated && user && conversation.agentId && conversation.agentId !== user.agentId && conversation.agentId !== user.id) {
      throw new ForbiddenException('Forbidden: Not authorized to access this conversation');
    }

    this.logger.log(`Fetching messages for conversation ${id}`);
    const messages = await this.prisma.message.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
    });

    // Also include Call Sessions as messages for unified threading!
    const calls = await this.prisma.callSession.findMany({
      where: { conversationId: id },
      orderBy: { startedAt: 'asc' },
    });

    const combined: any[] = [];
    
    messages.forEach(m => {
      combined.push({
        id: m.id,
        sender: m.senderType === 'AGENT' ? 'agent' : 'customer', // Or system based on role
        content: m.content,
        timestamp: m.createdAt.toISOString(),
        status: 'read',
      });
    });

    calls.forEach(c => {
      combined.push({
        id: c.id,
        sender: 'system',
        content: `Call ${c.reason?.startsWith('call_outbound_') ? 'to' : 'from'} customer. Duration: ${c.duration}s. Status: ${c.status}`,
        timestamp: c.startedAt?.toISOString() || c.createdAt.toISOString(),
        attachmentType: 'call',
        attachmentUrl: c.recordingUrl,
      });
    });

    combined.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return combined;
  }

  @Put(':id/read')
  async markRead(@Param('id') id: string, @Req() req: any) {
    if (!UUID_REGEX.test(id)) {
      throw new NotFoundException('Conversation not found');
    }
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    const user = req?.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user.role);
    if (!isElevated && user && conversation.agentId && conversation.agentId !== user.agentId && conversation.agentId !== user.id) {
      throw new ForbiddenException('Forbidden: Not authorized to modify this conversation');
    }
    await this.prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0 },
    });
    return { success: true };
  }
}
