import { Controller, Get, Param, Logger, Put, Req, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { resolveBestCustomerName } from './name-resolution.util';

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
        lead: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });

    return conversations.map(c => ({
      id: c.id,
      customerId: c.customerId,
      customerName: resolveBestCustomerName(c.customer, c.lead, c.channel),
      customerPhone: c.customer?.phone || null,
      customerEmail: c.customer?.email || null,
      customerAvatar: c.customer?.instagramProfilePic || (c.customer as any)?.avatarUrl || null,
      foundation: c.foundation || 'UEC',
      enquiryCategory: c.enquiryCategory || 'SERVICE_ENQUIRY',
      primaryService: c.primaryService || null,
      subServices: c.subServices || [],
      leadId: c.leadId || null,
      lead: c.lead || null,
      classificationConfidence: c.classificationConfidence,
      isClassificationConfirmed: c.isClassificationConfirmed,
      missingInfo: c.missingInfo || [],
      intakeMetadata: c.intakeMetadata || null,
      lastMessage: 'Conversation active', 
      timestamp: c.updatedAt.toISOString(),
      status: c.status,
      channel: c.channel.toLowerCase(),
      unreadCount: c.unreadCount,
      priority: c.priority,
    }));
  }

  @Get(':id')
  async getConversationById(@Param('id') id: string, @Req() req: any) {
    if (!UUID_REGEX.test(id)) {
      throw new NotFoundException('Conversation not found');
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        customer: true,
        lead: true,
        callSessions: {
          orderBy: { startedAt: 'desc' },
          take: 5,
        },
      },
    });

    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    const user = req?.user;
    const isElevated = user && ['SUPER_ADMIN', 'ADMIN', 'SUPERVISOR', 'SENIOR_MANAGER', 'DEPARTMENT_MANAGER'].includes(user.role);
    if (!isElevated && user && conversation.agentId && conversation.agentId !== user.agentId && conversation.agentId !== user.id) {
      throw new ForbiddenException('Forbidden: Not authorized to access this conversation');
    }

    return {
      id: conversation.id,
      customerId: conversation.customerId,
      customerName: resolveBestCustomerName(conversation.customer, conversation.lead, conversation.channel),
      customerPhone: conversation.customer?.phone || null,
      customerEmail: conversation.customer?.email || null,
      customerAvatar: conversation.customer?.instagramProfilePic || (conversation.customer as any)?.avatarUrl || null,
      foundation: conversation.foundation || 'UEC',
      enquiryCategory: conversation.enquiryCategory || 'SERVICE_ENQUIRY',
      primaryService: conversation.primaryService || null,
      subServices: conversation.subServices || [],
      leadId: conversation.leadId || null,
      lead: conversation.lead || null,
      classificationConfidence: conversation.classificationConfidence,
      isClassificationConfirmed: conversation.isClassificationConfirmed,
      missingInfo: conversation.missingInfo || [],
      intakeMetadata: conversation.intakeMetadata || null,
      status: conversation.status,
      channel: conversation.channel.toLowerCase(),
      unreadCount: conversation.unreadCount,
      priority: conversation.priority,
      callSessions: conversation.callSessions,
      createdAt: conversation.createdAt.toISOString(),
      updatedAt: conversation.updatedAt.toISOString(),
    };
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
