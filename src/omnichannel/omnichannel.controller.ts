import { Controller, Get, Param, Logger, Put } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('api/v1/conversations')
export class OmnichannelController {
  private readonly logger = new Logger(OmnichannelController.name);

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async getConversations() {
    this.logger.log('Fetching omnichannel conversations');
    const conversations = await this.prisma.conversation.findMany({
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
  async getMessages(@Param('id') id: string) {
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
  async markRead(@Param('id') id: string) {
    await this.prisma.conversation.update({
      where: { id },
      data: { unreadCount: 0 },
    });
    return { success: true };
  }
}
