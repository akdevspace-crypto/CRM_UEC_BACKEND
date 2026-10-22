import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateSopTemplateDto,
  UpdateSopTemplateDto,
  CreateSopExecutionDto,
  UpdateSopExecutionDto,
  CompleteStepDto,
  ReviewSopApprovalDto,
  CreateSopDocumentDto,
  SopHandoffDto,
  SopQueryDto,
  CreateStaffProfileDto,
  UpdateStaffProfileDto,
  StaffQueryDto,
  CreateStaffRequirementDto,
  UpdateStaffRequirementDto,
  TransitionSalesStageDto,
  CreateCcrComplaintDto,
  UpdateCcrComplaintDto,
  SubmitSopDailyReportDto,
} from './dto/sop.dto';
import {
  SopDepartment,
  SopExecutionStatus,
  SopTemplateStatus,
  SopApprovalStatus,
  Prisma,
} from '@prisma/client';
import { SEED_SOP_TEMPLATES } from './sop-seed.data';

@Injectable()
export class SopService {
  private readonly logger = new Logger(SopService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ==========================================
  // SOP OVERVIEW & DASHBOARD METRICS
  // ==========================================

  async getOverview(query: SopQueryDto, user: any) {
    const unitFilter = this.resolveUnitFilter(query.unitId, user);
    const departmentFilter = query.department ? { department: query.department } : {};

    const baseWhere: Prisma.SopExecutionWhereInput = {
      ...unitFilter,
      ...departmentFilter,
    };

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const [
      totalTasks,
      completedCount,
      inProgressCount,
      assignedCount,
      pendingApprovalCount,
      blockedCount,
      overdueCount,
      dueTodayCount,
      departmentStatsRaw,
      recentExecutions,
      pendingApprovals,
      activeTemplatesCount,
      totalDocumentsCount,
      totalAcknowledgementsCount,
    ] = await Promise.all([
      this.prisma.sopExecution.count({ where: baseWhere }),
      this.prisma.sopExecution.count({ where: { ...baseWhere, status: SopExecutionStatus.COMPLETED } }),
      this.prisma.sopExecution.count({ where: { ...baseWhere, status: SopExecutionStatus.IN_PROGRESS } }),
      this.prisma.sopExecution.count({ where: { ...baseWhere, status: SopExecutionStatus.ASSIGNED } }),
      this.prisma.sopExecution.count({ where: { ...baseWhere, status: SopExecutionStatus.PENDING_APPROVAL } }),
      this.prisma.sopExecution.count({ where: { ...baseWhere, status: SopExecutionStatus.BLOCKED } }),
      this.prisma.sopExecution.count({
        where: {
          ...baseWhere,
          status: { in: [SopExecutionStatus.ASSIGNED, SopExecutionStatus.IN_PROGRESS, SopExecutionStatus.BLOCKED] },
          dueDate: { lt: now },
        },
      }),
      this.prisma.sopExecution.count({
        where: {
          ...baseWhere,
          dueDate: { gte: startOfToday, lte: endOfToday },
        },
      }),
      this.prisma.sopExecution.groupBy({
        by: ['department', 'status'],
        where: baseWhere,
        _count: { id: true },
      }),
      this.prisma.sopExecution.findMany({
        where: baseWhere,
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: {
          assignedAgent: { select: { id: true, name: true, avatarUrl: true, department: true } },
          customer: { select: { id: true, name: true, phone: true } },
          lead: { select: { id: true, customerName: true, phoneNumber: true } },
        },
      }),
      this.prisma.sopExecution.findMany({
        where: { ...baseWhere, status: SopExecutionStatus.PENDING_APPROVAL },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        include: {
          assignedAgent: { select: { id: true, name: true } },
          template: { select: { id: true, title: true, code: true } },
        },
      }),
      this.prisma.sopTemplate.count({ where: { isActive: true, isArchived: false } }),
      this.prisma.sopDocument.count({ where: { status: 'ACTIVE' } }),
      this.prisma.sopAcknowledgement.count(),
    ]);

    // Process Department-wise Breakdown
    const departmentWorkload: Record<string, { total: number; completed: number; inProgress: number; overdue: number; pendingApproval: number }> = {
      HR: { total: 0, completed: 0, inProgress: 0, overdue: 0, pendingApproval: 0 },
      CCR: { total: 0, completed: 0, inProgress: 0, overdue: 0, pendingApproval: 0 },
      SALES: { total: 0, completed: 0, inProgress: 0, overdue: 0, pendingApproval: 0 },
      DATA_ENTRY: { total: 0, completed: 0, inProgress: 0, overdue: 0, pendingApproval: 0 },
      GENERAL: { total: 0, completed: 0, inProgress: 0, overdue: 0, pendingApproval: 0 },
    };

    departmentStatsRaw.forEach((stat) => {
      const dept = stat.department;
      if (!departmentWorkload[dept]) {
        departmentWorkload[dept] = { total: 0, completed: 0, inProgress: 0, overdue: 0, pendingApproval: 0 };
      }
      departmentWorkload[dept].total += stat._count.id;
      if (stat.status === SopExecutionStatus.COMPLETED) {
        departmentWorkload[dept].completed += stat._count.id;
      } else if (stat.status === SopExecutionStatus.IN_PROGRESS || stat.status === SopExecutionStatus.ASSIGNED) {
        departmentWorkload[dept].inProgress += stat._count.id;
      } else if (stat.status === SopExecutionStatus.PENDING_APPROVAL) {
        departmentWorkload[dept].pendingApproval += stat._count.id;
      }
    });

    // Staff Workload Distribution
    const activeStaff = await this.prisma.agent.findMany({
      where: { isDeleted: false },
      select: {
        id: true,
        name: true,
        department: true,
        status: true,
        avatarUrl: true,
        sopAssignedExecutions: {
          where: {
            status: { in: [SopExecutionStatus.ASSIGNED, SopExecutionStatus.IN_PROGRESS, SopExecutionStatus.BLOCKED] },
          },
          select: { id: true, status: true, priority: true, dueDate: true },
        },
      },
      take: 10,
    });

    const staffWorkload = activeStaff.map((agent) => ({
      agentId: agent.id,
      name: agent.name,
      department: agent.department || 'General',
      agentStatus: agent.status,
      avatarUrl: agent.avatarUrl,
      activeTasksCount: agent.sopAssignedExecutions.length,
      urgentCount: agent.sopAssignedExecutions.filter((e) => e.priority === 'URGENT' || e.priority === 'HIGH').length,
    }));

    // Calculate Completion Rate
    const completionRate = totalTasks > 0 ? Math.round((completedCount / totalTasks) * 100) : 100;

    return {
      metrics: {
        totalTasks,
        completedCount,
        inProgressCount: inProgressCount + assignedCount,
        pendingApprovalCount,
        blockedCount,
        overdueCount,
        dueTodayCount,
        completionRate,
        activeTemplatesCount,
        totalDocumentsCount,
        totalAcknowledgementsCount,
      },
      departmentWorkload,
      staffWorkload,
      recentExecutions,
      pendingApprovals,
    };
  }

  // ==========================================
  // DAILY OPERATIONS VIEW
  // ==========================================

  async getDailyOperations(query: SopQueryDto, user: any) {
    const unitFilter = this.resolveUnitFilter(query.unitId, user);
    const departmentFilter = query.department ? { department: query.department } : {};

    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);

    const whereClause: Prisma.SopExecutionWhereInput = {
      ...unitFilter,
      ...departmentFilter,
      OR: [
        { dueDate: { gte: startOfToday, lte: endOfToday } },
        { status: { in: [SopExecutionStatus.IN_PROGRESS, SopExecutionStatus.ASSIGNED, SopExecutionStatus.PENDING_APPROVAL, SopExecutionStatus.BLOCKED] } },
      ],
    };

    const executions = await this.prisma.sopExecution.findMany({
      where: whereClause,
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }],
      include: {
        template: { select: { id: true, code: true, title: true, recurrence: true } },
        assignedAgent: { select: { id: true, name: true, avatarUrl: true, department: true } },
        checklistResponses: {
          include: { step: true },
        },
        customer: { select: { id: true, name: true, phone: true } },
        lead: { select: { id: true, customerName: true, phoneNumber: true } },
      },
    });

    // Categorize for daily operations schedule
    const morningHandovers = executions.filter(
      (e) => e.category.toLowerCase().includes('handover') || e.category.toLowerCase().includes('daily') || e.title.toLowerCase().includes('shift'),
    );
    const criticalActionItems = executions.filter(
      (e) => (e.priority === 'URGENT' || e.priority === 'HIGH') && e.status !== SopExecutionStatus.COMPLETED,
    );
    const standardOperations = executions.filter(
      (e) => !morningHandovers.includes(e) && !criticalActionItems.includes(e),
    );

    return {
      date: startOfToday.toISOString(),
      summary: {
        totalDailyTasks: executions.length,
        completedToday: executions.filter((e) => e.status === SopExecutionStatus.COMPLETED).length,
        criticalOpen: criticalActionItems.length,
      },
      morningHandovers,
      criticalActionItems,
      standardOperations,
      allExecutions: executions,
    };
  }

  // ==========================================
  // SOP TEMPLATES & BUILDER
  // ==========================================

  async getTemplates(query: SopQueryDto, user: any) {
    const whereClause: Prisma.SopTemplateWhereInput = {
      isArchived: false,
      ...(query.department ? { department: query.department } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
              { description: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    return this.prisma.sopTemplate.findMany({
      where: whereClause,
      orderBy: [{ department: 'asc' }, { code: 'asc' }],
      include: {
        versions: {
          orderBy: { versionNumber: 'desc' },
          take: 1,
          include: {
            steps: { orderBy: { stepOrder: 'asc' } },
          },
        },
        _count: { select: { executions: true } },
      },
    });
  }

  async getTemplateById(id: string, user: any) {
    const template = await this.prisma.sopTemplate.findUnique({
      where: { id },
      include: {
        versions: {
          orderBy: { versionNumber: 'desc' },
          include: {
            steps: { orderBy: { stepOrder: 'asc' } },
            acknowledgements: { take: 10, include: { user: { select: { id: true, email: true } } } },
          },
        },
        executions: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, taskNumber: true, title: true, status: true, priority: true, createdAt: true },
        },
      },
    });

    if (!template) {
      throw new NotFoundException(`SOP Template with ID '${id}' not found`);
    }

    return template;
  }

  async createTemplate(dto: CreateSopTemplateDto, user: any) {
    const existing = await this.prisma.sopTemplate.findUnique({
      where: { code: dto.code },
    });
    if (existing) {
      throw new BadRequestException(`SOP Template code '${dto.code}' already exists`);
    }

    return this.prisma.$transaction(async (tx) => {
      const template = await tx.sopTemplate.create({
        data: {
          code: dto.code,
          title: dto.title,
          description: dto.description,
          department: dto.department,
          category: dto.category,
          priority: dto.priority || 'NORMAL',
          recurrence: dto.recurrence || 'NONE',
          unitId: dto.unitId,
          requiresApproval: dto.requiresApproval ?? false,
          escalationHours: dto.escalationHours ?? 24,
          createdById: this.safeUuid(user?.userId || user?.sub || user?.id),
        },
      });

      const version = await tx.sopTemplateVersion.create({
        data: {
          templateId: template.id,
          versionNumber: 1,
          status: SopTemplateStatus.PUBLISHED,
          changelog: 'Initial version publication',
          publishedById: this.safeUuid(user?.userId || user?.sub || user?.id),
          publishedAt: new Date(),
        },
      });

      if (dto.steps && dto.steps.length > 0) {
        await tx.sopStep.createMany({
          data: dto.steps.map((step, idx) => ({
            versionId: version.id,
            stepOrder: step.stepOrder || idx + 1,
            title: step.title,
            description: step.description,
            isMandatory: step.isMandatory ?? true,
            requiresAttachment: step.requiresAttachment ?? false,
            requiresNotes: step.requiresNotes ?? false,
            estimatedMinutes: step.estimatedMinutes,
            roleRequired: step.roleRequired,
            validationRules: step.validationRules,
          })),
        });
      }

      await tx.sopWorkflowEvent.create({
        data: {
          eventType: 'TEMPLATE_CREATED',
          fromDepartment: dto.department,
          actorId: user?.userId || user?.sub || user?.id,
          actorEmail: user?.email,
          action: `Created SOP Template ${template.code}: ${template.title}`,
          details: { templateId: template.id, code: template.code, version: 1 },
        },
      });

      return tx.sopTemplate.findUnique({
        where: { id: template.id },
        include: {
          versions: {
            include: { steps: { orderBy: { stepOrder: 'asc' } } },
          },
        },
      });
    });
  }

  async updateTemplate(id: string, dto: UpdateSopTemplateDto, user: any) {
    const template = await this.prisma.sopTemplate.findUnique({ where: { id } });
    if (!template) {
      throw new NotFoundException(`SOP Template with ID '${id}' not found`);
    }

    const updated = await this.prisma.sopTemplate.update({
      where: { id },
      data: {
        title: dto.title,
        description: dto.description,
        department: dto.department,
        category: dto.category,
        priority: dto.priority,
        recurrence: dto.recurrence,
        unitId: dto.unitId,
        requiresApproval: dto.requiresApproval,
        escalationHours: dto.escalationHours,
        isActive: dto.isActive,
        isArchived: dto.isArchived,
      },
    });

    await this.prisma.sopWorkflowEvent.create({
      data: {
        eventType: 'TEMPLATE_UPDATED',
        fromDepartment: updated.department,
        actorId: user?.userId || user?.sub || user?.id,
        actorEmail: user?.email,
        action: `Updated SOP Template ${updated.code}`,
        details: { templateId: updated.id, changes: dto as any },
      },
    });

    return updated;
  }

  async publishNewVersion(templateId: string, steps: any[], changelog: string, user: any) {
    const template = await this.prisma.sopTemplate.findUnique({
      where: { id: templateId },
      include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
    });
    if (!template) throw new NotFoundException('Template not found');

    const nextVersionNumber = (template.versions[0]?.versionNumber || 0) + 1;

    return this.prisma.$transaction(async (tx) => {
      // Retire older versions
      await tx.sopTemplateVersion.updateMany({
        where: { templateId, status: SopTemplateStatus.PUBLISHED },
        data: { status: SopTemplateStatus.RETIRED },
      });

      const newVersion = await tx.sopTemplateVersion.create({
        data: {
          templateId,
          versionNumber: nextVersionNumber,
          status: SopTemplateStatus.PUBLISHED,
          changelog: changelog || `Version ${nextVersionNumber} release`,
          publishedById: this.safeUuid(user?.userId || user?.sub || user?.id),
          publishedAt: new Date(),
        },
      });

      if (steps && steps.length > 0) {
        await tx.sopStep.createMany({
          data: steps.map((s, idx) => ({
            versionId: newVersion.id,
            stepOrder: s.stepOrder || idx + 1,
            title: s.title,
            description: s.description,
            isMandatory: s.isMandatory ?? true,
            requiresAttachment: s.requiresAttachment ?? false,
            requiresNotes: s.requiresNotes ?? false,
            estimatedMinutes: s.estimatedMinutes,
            roleRequired: s.roleRequired,
          })),
        });
      }

      await tx.sopWorkflowEvent.create({
        data: {
          eventType: 'TEMPLATE_VERSION_PUBLISHED',
          fromDepartment: template.department,
          actorId: user?.userId || user?.sub || user?.id,
          actorEmail: user?.email,
          action: `Published Version ${nextVersionNumber} of SOP ${template.code}`,
          details: { templateId, versionNumber: nextVersionNumber },
        },
      });

      return newVersion;
    });
  }

  // ==========================================
  // SOP TASK EXECUTIONS (DAILY WORKFLOW ENGINE)
  // ==========================================

  async getExecutions(query: SopQueryDto, user: any) {
    const unitFilter = this.resolveUnitFilter(query.unitId, user);
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const skip = (page - 1) * limit;

    const whereClause: Prisma.SopExecutionWhereInput = {
      ...unitFilter,
      ...(query.department ? { department: query.department } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.assignedAgentId ? { assignedAgentId: query.assignedAgentId } : {}),
      ...(query.search
        ? {
            OR: [
              { title: { contains: query.search, mode: 'insensitive' } },
              { taskNumber: { contains: query.search, mode: 'insensitive' } },
              { notes: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    if (query.period === 'today') {
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      whereClause.createdAt = { gte: startOfToday, lte: endOfToday };
    }

    const [total, items] = await Promise.all([
      this.prisma.sopExecution.count({ where: whereClause }),
      this.prisma.sopExecution.findMany({
        where: whereClause,
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
        include: {
          template: { select: { id: true, code: true, title: true } },
          assignedAgent: { select: { id: true, name: true, avatarUrl: true, department: true } },
          customer: { select: { id: true, name: true, phone: true } },
          lead: { select: { id: true, customerName: true, phoneNumber: true, serviceInterest: true } },
          ticket: { select: { id: true, category: true, priority: true, status: true } },
          checklistResponses: {
            select: { id: true, isCompleted: true, stepId: true },
          },
        },
      }),
    ]);

    const formattedItems = items.map((item) => {
      const totalSteps = item.checklistResponses.length;
      const completedSteps = item.checklistResponses.filter((r) => r.isCompleted).length;
      const progressPercent = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;
      return {
        ...item,
        totalSteps,
        completedSteps,
        progressPercent,
      };
    });

    return {
      items: formattedItems,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getExecutionById(id: string, user: any) {
    const execution = await this.prisma.sopExecution.findUnique({
      where: { id },
      include: {
        template: {
          include: {
            unit: { select: { id: true, name: true, code: true } },
          },
        },
        templateVersion: {
          include: {
            steps: { orderBy: { stepOrder: 'asc' } },
          },
        },
        assignedAgent: { select: { id: true, name: true, avatarUrl: true, department: true, email: true } },
        createdByUser: { select: { id: true, email: true } },
        approvedByUser: { select: { id: true, email: true } },
        customer: true,
        lead: true,
        ticket: true,
        callSession: true,
        checklistResponses: {
          include: { step: true },
        },
        approvals: {
          include: { approver: { select: { id: true, email: true } } },
        },
        workflowEvents: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!execution) {
      throw new NotFoundException(`SOP Task Execution '${id}' not found`);
    }

    return execution;
  }

  async createExecution(dto: CreateSopExecutionDto, user: any) {
    let templateId = dto.templateId;
    let templateVersionId = dto.templateVersionId;
    let template: any = null;
    let version: any = null;

    if (templateId) {
      template = await this.prisma.sopTemplate.findUnique({
        where: { id: templateId },
        include: {
          versions: {
            where: { status: SopTemplateStatus.PUBLISHED },
            orderBy: { versionNumber: 'desc' },
            take: 1,
            include: { steps: { orderBy: { stepOrder: 'asc' } } },
          },
        },
      });
      if (template && template.versions.length > 0) {
        version = template.versions[0];
        templateVersionId = version.id;
      }
    } else {
      // Find default template matching department and category if available
      template = await this.prisma.sopTemplate.findFirst({
        where: { department: dto.department, isActive: true },
        include: {
          versions: {
            where: { status: SopTemplateStatus.PUBLISHED },
            orderBy: { versionNumber: 'desc' },
            take: 1,
            include: { steps: { orderBy: { stepOrder: 'asc' } } },
          },
        },
      });
      if (template) {
        templateId = template.id;
        version = template.versions[0];
        templateVersionId = version?.id;
      }
    }

    if (!template || !version) {
      // Fallback: create an ad-hoc template wrapper so execution integrity is preserved
      const code = `AD-HOC-${Date.now()}`;
      template = await this.prisma.sopTemplate.create({
        data: {
          code,
          title: dto.title,
          department: dto.department,
          category: dto.category || 'General Operations',
          priority: dto.priority || 'NORMAL',
          createdById: this.safeUuid(user?.userId || user?.sub || user?.id),
          versions: {
            create: {
              versionNumber: 1,
              status: SopTemplateStatus.PUBLISHED,
              steps: {
                create: [
                  { stepOrder: 1, title: 'Verify task requirements', isMandatory: true },
                  { stepOrder: 2, title: 'Execute operational procedure', isMandatory: true },
                  { stepOrder: 3, title: 'Document outcome and completion', isMandatory: true },
                ],
              },
            },
          },
        },
        include: { versions: { include: { steps: true } } },
      });
      templateId = template.id;
      version = template.versions[0];
      templateVersionId = version.id;
    }

    const taskNumber = `SOP-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;

    return this.prisma.$transaction(async (tx) => {
      const execution = await tx.sopExecution.create({
        data: {
          taskNumber,
          templateId: templateId as string,
          templateVersionId: templateVersionId as string,
          title: dto.title || template.title,
          department: dto.department || template.department,
          category: dto.category || template.category,
          priority: dto.priority || template.priority || 'NORMAL',
          status: dto.assignedAgentId ? SopExecutionStatus.ASSIGNED : SopExecutionStatus.DRAFT,
          unitId: dto.unitId || template.unitId,
          assignedAgentId: dto.assignedAgentId,
          assignedRole: dto.assignedRole,
          dueDate: dto.dueDate ? new Date(dto.dueDate) : new Date(Date.now() + (template.escalationHours || 24) * 3600000),
          notes: dto.notes,
          customerId: dto.customerId,
          leadId: dto.leadId,
          ticketId: dto.ticketId,
          callSessionId: dto.callSessionId,
          metadata: dto.metadata,
          createdById: this.safeUuid(user?.userId || user?.sub || user?.id),
        },
      });

      // Initialize checklist responses for each step in this template version
      if (version.steps && version.steps.length > 0) {
        await tx.sopChecklistResponse.createMany({
          data: version.steps.map((step: any) => ({
            executionId: execution.id,
            stepId: step.id,
            isCompleted: false,
          })),
        });
      }

      // Log initial event
      await tx.sopWorkflowEvent.create({
        data: {
          executionId: execution.id,
          eventType: 'CREATED',
          fromDepartment: execution.department,
          toDepartment: execution.department,
          actorId: user?.userId || user?.sub || user?.id,
          actorEmail: user?.email,
          action: `Generated Task ${execution.taskNumber}: ${execution.title}`,
          details: {
            taskNumber: execution.taskNumber,
            assignedAgentId: execution.assignedAgentId,
            templateCode: template.code,
          },
        },
      });

      return execution;
    });
  }

  async updateExecution(id: string, dto: UpdateSopExecutionDto, user: any) {
    const execution = await this.prisma.sopExecution.findUnique({
      where: { id },
      include: {
        template: true,
        checklistResponses: { include: { step: true } },
      },
    });

    if (!execution) {
      throw new NotFoundException(`SOP Task Execution '${id}' not found`);
    }

    // Business Rule: Cannot mark COMPLETED if mandatory steps are incomplete!
    if (dto.status === SopExecutionStatus.COMPLETED) {
      const incompleteMandatory = execution.checklistResponses.filter(
        (r) => r.step?.isMandatory && !r.isCompleted,
      );
      if (incompleteMandatory.length > 0) {
        throw new BadRequestException(
          `Cannot complete task: ${incompleteMandatory.length} mandatory checklist item(s) are incomplete.`,
        );
      }

      // If approval is required by template and not yet approved, route to PENDING_APPROVAL
      if (execution.template.requiresApproval && execution.status !== SopExecutionStatus.PENDING_APPROVAL && !execution.approvedAt) {
        dto.status = SopExecutionStatus.PENDING_APPROVAL;
      }
    }

    const updated = await this.prisma.sopExecution.update({
      where: { id },
      data: {
        status: dto.status,
        assignedAgentId: dto.assignedAgentId,
        assignedRole: dto.assignedRole,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
        notes: dto.notes,
        blockedReason: dto.blockedReason,
        completionEvidence: dto.completionEvidence,
        metadata: dto.metadata,
        startedAt: dto.status === SopExecutionStatus.IN_PROGRESS && !execution.startedAt ? new Date() : undefined,
        completedAt: dto.status === SopExecutionStatus.COMPLETED ? new Date() : undefined,
      },
    });

    await this.prisma.sopWorkflowEvent.create({
      data: {
        executionId: id,
        eventType: dto.status ? 'STATUS_CHANGE' : 'TASK_UPDATED',
        fromDepartment: execution.department,
        actorId: user?.userId || user?.sub || user?.id,
        actorEmail: user?.email,
        action: `Updated task ${execution.taskNumber} status to ${dto.status || execution.status}`,
        details: { previousStatus: execution.status, newStatus: dto.status },
      },
    });

    return updated;
  }

  async completeStep(executionId: string, stepId: string, dto: CompleteStepDto, user: any) {
    const execution = await this.prisma.sopExecution.findUnique({
      where: { id: executionId },
      include: {
        template: true,
        checklistResponses: { include: { step: true } },
      },
    });

    if (!execution) throw new NotFoundException('Task execution not found');

    const step = await this.prisma.sopStep.findUnique({ where: { id: stepId } });
    if (!step) throw new NotFoundException('SOP Step not found');

    if (step.requiresNotes && dto.isCompleted && !dto.notes) {
      throw new BadRequestException(`Step '${step.title}' requires operational notes before completion.`);
    }

    if (step.requiresAttachment && dto.isCompleted && !dto.attachmentUrl) {
      throw new BadRequestException(`Step '${step.title}' requires document/photo attachment evidence.`);
    }

    const response = await this.prisma.sopChecklistResponse.upsert({
      where: {
        executionId_stepId: { executionId, stepId },
      },
      update: {
        isCompleted: dto.isCompleted,
        notes: dto.notes,
        attachmentUrl: dto.attachmentUrl,
        completedById: this.safeUuid(user?.userId || user?.sub || user?.id),
        completedAt: dto.isCompleted ? new Date() : null,
      },
      create: {
        executionId,
        stepId,
        isCompleted: dto.isCompleted,
        notes: dto.notes,
        attachmentUrl: dto.attachmentUrl,
        completedById: this.safeUuid(user?.userId || user?.sub || user?.id),
        completedAt: dto.isCompleted ? new Date() : null,
      },
    });

    // Check if task can be transitioned
    const allResponses = await this.prisma.sopChecklistResponse.findMany({
      where: { executionId },
      include: { step: true },
    });

    const allMandatoryDone = allResponses.every((r) => !r.step.isMandatory || r.isCompleted);

    let newStatus: SopExecutionStatus = execution.status;
    if (allMandatoryDone && execution.status !== SopExecutionStatus.COMPLETED) {
      if (execution.template.requiresApproval) {
        newStatus = SopExecutionStatus.PENDING_APPROVAL;
      } else {
        newStatus = SopExecutionStatus.COMPLETED;
      }

      await this.prisma.sopExecution.update({
        where: { id: executionId },
        data: {
          status: newStatus,
          completedAt: newStatus === SopExecutionStatus.COMPLETED ? new Date() : undefined,
        },
      });
    } else if (execution.status === SopExecutionStatus.ASSIGNED && dto.isCompleted) {
      newStatus = SopExecutionStatus.IN_PROGRESS;
      await this.prisma.sopExecution.update({
        where: { id: executionId },
        data: { status: newStatus, startedAt: new Date() },
      });
    }

    await this.prisma.sopWorkflowEvent.create({
      data: {
        executionId,
        eventType: 'STEP_COMPLETED',
        fromDepartment: execution.department,
        actorId: user?.userId || user?.sub || user?.id,
        actorEmail: user?.email,
        action: `Step '${step.title}' marked ${dto.isCompleted ? 'COMPLETED' : 'INCOMPLETE'}`,
        details: { stepId, stepTitle: step.title, isCompleted: dto.isCompleted },
      },
    });

    return { response, taskStatus: newStatus };
  }

  async submitForApproval(executionId: string, user: any) {
    const execution = await this.prisma.sopExecution.findUnique({
      where: { id: executionId },
      include: { checklistResponses: { include: { step: true } } },
    });
    if (!execution) throw new NotFoundException('Execution not found');

    const incompleteMandatory = execution.checklistResponses.filter(
      (r) => r.step?.isMandatory && !r.isCompleted,
    );
    if (incompleteMandatory.length > 0) {
      throw new BadRequestException(`Cannot submit for approval: ${incompleteMandatory.length} mandatory steps incomplete.`);
    }

    const updated = await this.prisma.sopExecution.update({
      where: { id: executionId },
      data: { status: SopExecutionStatus.PENDING_APPROVAL },
    });

    await this.prisma.sopApproval.create({
      data: {
        executionId,
        approverId: user?.userId || user?.sub || user?.id,
        status: SopApprovalStatus.PENDING,
      },
    });

    await this.prisma.sopWorkflowEvent.create({
      data: {
        executionId,
        eventType: 'SUBMITTED_FOR_APPROVAL',
        fromDepartment: execution.department,
        actorId: user?.userId || user?.sub || user?.id,
        actorEmail: user?.email,
        action: `Task ${execution.taskNumber} submitted for manager approval`,
      },
    });

    return updated;
  }

  async reviewApproval(executionId: string, dto: ReviewSopApprovalDto, user: any) {
    const execution = await this.prisma.sopExecution.findUnique({
      where: { id: executionId },
    });
    if (!execution) throw new NotFoundException('Execution not found');

    const approverId = user?.userId || user?.sub || user?.id;

    return this.prisma.$transaction(async (tx) => {
      await tx.sopApproval.create({
        data: {
          executionId,
          approverId,
          status: dto.status,
          comments: dto.comments,
          reviewedAt: new Date(),
        },
      });

      const isApproved = dto.status === SopApprovalStatus.APPROVED;
      const newStatus = isApproved ? SopExecutionStatus.COMPLETED : SopExecutionStatus.BLOCKED;

      const updated = await tx.sopExecution.update({
        where: { id: executionId },
        data: {
          status: newStatus,
          approvedById: isApproved ? approverId : null,
          approvedAt: isApproved ? new Date() : null,
          approvalNotes: dto.comments,
          completedAt: isApproved ? new Date() : null,
          blockedReason: !isApproved ? `Approval rejected: ${dto.comments}` : null,
        },
      });

      await tx.sopWorkflowEvent.create({
        data: {
          executionId,
          eventType: isApproved ? 'APPROVED' : 'REJECTED',
          fromDepartment: execution.department,
          actorId: approverId,
          actorEmail: user?.email,
          action: isApproved ? `Task ${execution.taskNumber} APPROVED` : `Task ${execution.taskNumber} REJECTED`,
          details: { comments: dto.comments },
        },
      });

      return updated;
    });
  }

  // ==========================================
  // CROSS-DEPARTMENT HANDOFFS
  // ==========================================

  async triggerHandoff(dto: SopHandoffDto, user: any) {
    const originExecution = await this.prisma.sopExecution.findUnique({
      where: { id: dto.executionId },
    });
    if (!originExecution) throw new NotFoundException('Origin task execution not found');

    // Create target department task
    const targetTask = await this.createExecution(
      {
        title: `Handoff: ${dto.action} (${originExecution.taskNumber})`,
        department: dto.toDepartment,
        category: 'Cross-Department Handoff',
        priority: originExecution.priority,
        unitId: originExecution.unitId || undefined,
        assignedAgentId: dto.targetAgentId,
        assignedRole: dto.targetRole,
        notes: dto.notes || `Received from ${originExecution.department}: ${originExecution.title}`,
        customerId: originExecution.customerId || undefined,
        leadId: originExecution.leadId || undefined,
        ticketId: originExecution.ticketId || undefined,
        callSessionId: originExecution.callSessionId || undefined,
        metadata: {
          originTaskNumber: originExecution.taskNumber,
          originDepartment: originExecution.department,
          handoffPayload: dto.metadata,
        },
      },
      user,
    );

    // Record bidirectional workflow audit
    await this.prisma.sopWorkflowEvent.create({
      data: {
        executionId: originExecution.id,
        eventType: 'HANDOFF_TRIGGERED',
        fromDepartment: originExecution.department,
        toDepartment: dto.toDepartment,
        actorId: user?.userId || user?.sub || user?.id,
        actorEmail: user?.email,
        action: `Handoff to ${dto.toDepartment}: ${dto.action}`,
        details: { targetTaskId: targetTask.id, targetTaskNumber: targetTask.taskNumber },
      },
    });

    return targetTask;
  }

  // ==========================================
  // SOP DOCUMENTS & ACKNOWLEDGEMENTS
  // ==========================================

  async getDocuments(query: SopQueryDto, user: any) {
    const unitFilter = this.resolveUnitFilter(query.unitId, user);
    const userId = user?.userId || user?.sub || user?.id;

    const docs = await this.prisma.sopDocument.findMany({
      where: {
        ...unitFilter,
        ...(query.department ? { department: query.department } : {}),
        status: 'ACTIVE',
      },
      orderBy: [{ department: 'asc' }, { documentNumber: 'asc' }],
      include: {
        acknowledgements: {
          where: { userId },
        },
      },
    });

    return docs.map((doc) => ({
      ...doc,
      isAcknowledgedByCurrentUser: doc.acknowledgements.length > 0,
      acknowledgedAt: doc.acknowledgements[0]?.acknowledgedAt || null,
    }));
  }

  async createDocument(dto: CreateSopDocumentDto, user: any) {
    const existing = await this.prisma.sopDocument.findUnique({
      where: { documentNumber: dto.documentNumber },
    });
    if (existing) {
      throw new BadRequestException(`Document number '${dto.documentNumber}' already exists`);
    }

    return this.prisma.sopDocument.create({
      data: {
        documentNumber: dto.documentNumber,
        title: dto.title,
        description: dto.description,
        department: dto.department,
        category: dto.category,
        version: dto.version || '1.0',
        fileUrl: dto.fileUrl,
        fileName: dto.fileName,
        fileSize: dto.fileSize,
        mimeType: dto.mimeType,
        content: dto.content,
        effectiveDate: dto.effectiveDate ? new Date(dto.effectiveDate) : new Date(),
        reviewDate: dto.reviewDate ? new Date(dto.reviewDate) : undefined,
        requiresAcknowledgement: dto.requiresAcknowledgement ?? true,
        unitId: dto.unitId,
        createdById: this.safeUuid(user?.userId || user?.sub || user?.id),
      },
    });
  }

  async acknowledgeDocument(documentId: string, user: any, ipAddress?: string, userAgent?: string) {
    const doc = await this.prisma.sopDocument.findUnique({ where: { id: documentId } });
    if (!doc) throw new NotFoundException('Document not found');

    const userId = user?.userId || user?.sub || user?.id;

    return this.prisma.sopAcknowledgement.create({
      data: {
        documentId,
        userId,
        unitId: doc.unitId,
        ipAddress,
        userAgent,
      },
    });
  }

  // ==========================================
  // SOP REPORTS & AUDIT TRAIL
  // ==========================================

  async getReports(query: SopQueryDto, user: any) {
    const unitFilter = this.resolveUnitFilter(query.unitId, user);
    const departmentFilter = query.department ? { department: query.department } : {};

    const baseWhere: Prisma.SopExecutionWhereInput = {
      ...unitFilter,
      ...departmentFilter,
    };

    const [
      totalTasks,
      completedTasks,
      overdueTasks,
      blockedTasks,
      auditEvents,
      departmentStats,
    ] = await Promise.all([
      this.prisma.sopExecution.count({ where: baseWhere }),
      this.prisma.sopExecution.count({ where: { ...baseWhere, status: SopExecutionStatus.COMPLETED } }),
      this.prisma.sopExecution.count({ where: { ...baseWhere, status: SopExecutionStatus.OVERDUE } }),
      this.prisma.sopExecution.count({ where: { ...baseWhere, status: SopExecutionStatus.BLOCKED } }),
      this.prisma.sopWorkflowEvent.findMany({
        orderBy: { createdAt: 'desc' },
        take: 30,
        include: {
          execution: {
            select: { id: true, taskNumber: true, title: true, department: true },
          },
        },
      }),
      this.prisma.sopExecution.groupBy({
        by: ['department', 'status'],
        where: baseWhere,
        _count: { id: true },
      }),
    ]);

    const departmentPerformance = ['HR', 'CCR', 'SALES', 'DATA_ENTRY'].map((dept) => {
      const deptStats = departmentStats.filter((s) => s.department === dept);
      const deptTotal = deptStats.reduce((acc, s) => acc + s._count.id, 0);
      const deptCompleted = deptStats.find((s) => s.status === SopExecutionStatus.COMPLETED)?._count.id || 0;
      const rate = deptTotal > 0 ? Math.round((deptCompleted / deptTotal) * 100) : 100;

      return {
        department: dept,
        total: deptTotal,
        completed: deptCompleted,
        completionRate: rate,
      };
    });

    return {
      summary: {
        totalTasks,
        completedTasks,
        overdueTasks,
        blockedTasks,
        overallCompletionRate: totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 100,
      },
      departmentPerformance,
      auditEvents,
    };
  }

  // ==========================================
  // SEED DEFAULT DEPARTMENTAL TEMPLATES
  // ==========================================

  async seedDefaultTemplates(user: any) {
    this.logger.log('Seeding default SOP templates and initial operational tasks...');
    let seededCount = 0;

    for (const item of SEED_SOP_TEMPLATES) {
      const existing = await this.prisma.sopTemplate.findUnique({
        where: { code: item.code },
      });

      if (!existing) {
        await this.createTemplate(item, user);
        seededCount++;
      }
    }

    // Ensure we have sample executions for each department if empty
    const executionCount = await this.prisma.sopExecution.count();
    if (executionCount === 0) {
      const allTemplates = await this.prisma.sopTemplate.findMany({
        include: { versions: { include: { steps: true } } },
      });

      const agents = await this.prisma.agent.findMany({
        where: { isDeleted: false },
        take: 5,
      });

      const leads = await this.prisma.lead.findMany({ take: 3 });
      const customers = await this.prisma.customer.findMany({ take: 3 });

      for (let i = 0; i < allTemplates.length; i++) {
        const tmpl = allTemplates[i];
        const assignedAgent = agents[i % agents.length];
        const lead = leads[i % leads.length];
        const customer = customers[i % customers.length];

        await this.createExecution(
          {
            templateId: tmpl.id,
            title: `${tmpl.title} - Operational Instance`,
            department: tmpl.department,
            category: tmpl.category,
            priority: tmpl.priority,
            assignedAgentId: assignedAgent?.id,
            customerId: customer?.id,
            leadId: lead?.id,
            notes: `Auto-generated operational SOP instance for ${tmpl.department} department.`,
          },
          user,
        );
      }
    }

    return { message: 'SOP templates successfully initialized', seededCount };
  }

  // ==========================================
  // UNIT ISOLATION HELPER
  // ==========================================

  private resolveUnitFilter(requestedUnitId?: string, user?: any): { unitId?: string } {
    // Super admin can filter by any unit or view global
    if (user?.role === 'SUPER_ADMIN') {
      return requestedUnitId ? { unitId: requestedUnitId } : {};
    }

    // If unitId is explicitly provided and user is authorized
    if (requestedUnitId) {
      return { unitId: requestedUnitId };
    }

    return {};
  }

  private safeUuid(id?: string): string | null {
    if (!id || typeof id !== 'string') return null;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    return isUuid ? id : null;
  }

  // ==========================================
  // PHASE 16: HR STAFF MANAGEMENT & RECRUITMENT PIPELINE
  // ==========================================

  async getStaffProfiles(query: StaffQueryDto, user: any) {
    const page = Number(query.page) || 1;
    const limit = Math.min(Number(query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (query.category) where.category = query.category;
    if (query.classification) where.classification = query.classification;
    if (query.verificationStatus) where.verificationStatus = query.verificationStatus;
    if (query.isAvailable !== undefined) where.isAvailable = query.isAvailable;
    if (query.unitId) where.unitId = query.unitId;

    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { phone: { contains: query.search } },
        { staffId: { contains: query.search, mode: 'insensitive' } },
        { city: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [total, items] = await Promise.all([
      (this.prisma as any).staffProfile.count({ where }),
      (this.prisma as any).staffProfile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getStaffProfileById(id: string, user: any) {
    const profile = await (this.prisma as any).staffProfile.findUnique({
      where: { id },
    });
    if (!profile) {
      throw new NotFoundException(`Staff profile ${id} not found`);
    }
    return profile;
  }

  async createStaffProfile(dto: CreateStaffProfileDto, user: any) {
    const existing = await (this.prisma as any).staffProfile.findFirst({
      where: { phone: dto.phone.trim() },
    });
    if (existing) {
      throw new BadRequestException(`A staff profile with phone ${dto.phone} already exists (${existing.staffId})`);
    }

    const currentYear = new Date().getFullYear();
    const count = await (this.prisma as any).staffProfile.count();
    const staffId = `STF-${currentYear}-${String(count + 1).padStart(4, '0')}`;

    const profile = await (this.prisma as any).staffProfile.create({
      data: {
        staffId,
        name: dto.name.trim(),
        phone: dto.phone.trim(),
        email: dto.email?.trim() || null,
        gender: dto.gender || null,
        category: dto.category,
        classification: dto.classification || 'NORMAL',
        verificationStatus: 'PENDING',
        qualifications: dto.qualifications || null,
        experienceYears: dto.experienceYears ? Number(dto.experienceYears) : null,
        city: dto.city || null,
        location: dto.location || null,
        preferredShift: dto.preferredShift || 'ANY',
        dailyRate: dto.dailyRate ? Number(dto.dailyRate) : null,
        monthlySalary: dto.monthlySalary ? Number(dto.monthlySalary) : null,
        source: dto.source || 'WALK_IN',
        emergencyContact: dto.emergencyContact || null,
        idProofType: dto.idProofType || null,
        idProofNumber: dto.idProofNumber || null,
        policeVerificationDone: dto.policeVerificationDone || false,
        medicalFitnessDone: dto.medicalFitnessDone || false,
        documents: dto.documents || [],
        unitId: this.safeUuid(dto.unitId),
        createdById: this.safeUuid(user?.userId || user?.id),
      },
    });

    this.logger.log(`Created StaffProfile ${staffId} for ${dto.name}`);
    return profile;
  }

  async updateStaffProfile(id: string, dto: UpdateStaffProfileDto, user: any) {
    const existing = await (this.prisma as any).staffProfile.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException(`Staff profile ${id} not found`);
    }

    const updated = await (this.prisma as any).staffProfile.update({
      where: { id },
      data: {
        ...(dto.name ? { name: dto.name.trim() } : {}),
        ...(dto.phone ? { phone: dto.phone.trim() } : {}),
        ...(dto.email !== undefined ? { email: dto.email } : {}),
        ...(dto.category ? { category: dto.category } : {}),
        ...(dto.classification ? { classification: dto.classification } : {}),
        ...(dto.verificationStatus ? { verificationStatus: dto.verificationStatus } : {}),
        ...(dto.qualifications !== undefined ? { qualifications: dto.qualifications } : {}),
        ...(dto.experienceYears !== undefined ? { experienceYears: Number(dto.experienceYears) } : {}),
        ...(dto.city !== undefined ? { city: dto.city } : {}),
        ...(dto.location !== undefined ? { location: dto.location } : {}),
        ...(dto.preferredShift !== undefined ? { preferredShift: dto.preferredShift } : {}),
        ...(dto.dailyRate !== undefined ? { dailyRate: Number(dto.dailyRate) } : {}),
        ...(dto.monthlySalary !== undefined ? { monthlySalary: Number(dto.monthlySalary) } : {}),
        ...(dto.isAvailable !== undefined ? { isAvailable: dto.isAvailable } : {}),
        ...(dto.currentAssignmentId !== undefined ? { currentAssignmentId: dto.currentAssignmentId } : {}),
        ...(dto.alternateAssignmentId !== undefined ? { alternateAssignmentId: dto.alternateAssignmentId } : {}),
        ...(dto.policeVerificationDone !== undefined ? { policeVerificationDone: dto.policeVerificationDone } : {}),
        ...(dto.medicalFitnessDone !== undefined ? { medicalFitnessDone: dto.medicalFitnessDone } : {}),
        ...(dto.documents ? { documents: dto.documents } : {}),
        ...(dto.threeDayFollowupDone !== undefined ? { threeDayFollowupDone: dto.threeDayFollowupDone } : {}),
        ...(dto.threeDayFollowupNotes !== undefined ? { threeDayFollowupNotes: dto.threeDayFollowupNotes } : {}),
      },
    });

    return updated;
  }

  async secondHrConfirm(id: string, user: any) {
    const profile = await (this.prisma as any).staffProfile.findUnique({ where: { id } });
    if (!profile) throw new NotFoundException(`Staff profile ${id} not found`);

    const updated = await (this.prisma as any).staffProfile.update({
      where: { id },
      data: {
        verificationStatus: 'SECOND_HR_CONFIRMED',
        secondHrVerifiedBy: user?.name || user?.email || 'HR Manager',
        secondHrVerifiedAt: new Date(),
        tlmHandoverAt: new Date(),
      },
    });

    this.logger.log(`Second-HR confirmation completed for staff ${profile.staffId} by ${user?.email}`);
    return updated;
  }

  async recordStaffThreeDayFollowup(id: string, followupData: { notes: string; successful: boolean }, user: any) {
    const profile = await (this.prisma as any).staffProfile.findUnique({ where: { id } });
    if (!profile) throw new NotFoundException(`Staff profile ${id} not found`);

    const updated = await (this.prisma as any).staffProfile.update({
      where: { id },
      data: {
        threeDayFollowupDone: true,
        threeDayFollowupDate: new Date(),
        threeDayFollowupNotes: followupData.notes,
      },
    });

    return updated;
  }

  async getStaffStockByCategory(unitId?: string) {
    const where: any = { isAvailable: true };
    if (unitId) where.unitId = unitId;

    const stock = await (this.prisma as any).staffProfile.groupBy({
      by: ['category', 'classification'],
      where,
      _count: { id: true },
    });

    return stock.map((s: any) => ({
      category: s.category,
      classification: s.classification,
      availableCount: s._count.id,
    }));
  }

  // ==========================================
  // PHASE 16: WANTED STAFF REQUIREMENTS
  // ==========================================

  async getStaffRequirements(status?: string, unitId?: string) {
    const where: any = {};
    if (status) where.status = status;
    if (unitId) where.unitId = unitId;

    return (this.prisma as any).staffRequirement.findMany({
      where,
      orderBy: [{ urgency: 'asc' }, { requiredByDate: 'asc' }],
    });
  }

  async createStaffRequirement(dto: CreateStaffRequirementDto, user: any) {
    const currentYear = new Date().getFullYear();
    const count = await (this.prisma as any).staffRequirement.count();
    const requirementCode = `REQ-${currentYear}-${String(count + 1).padStart(4, '0')}`;

    return (this.prisma as any).staffRequirement.create({
      data: {
        requirementCode,
        category: dto.category,
        qualificationRequired: dto.qualificationRequired || null,
        location: dto.location || null,
        unitId: this.safeUuid(dto.unitId),
        openPositions: dto.openPositions ? Number(dto.openPositions) : 1,
        fulfilledPositions: 0,
        urgency: dto.urgency || 'NORMAL',
        requiredByDate: new Date(dto.requiredByDate),
        status: 'OPEN',
        notes: dto.notes || null,
        createdById: this.safeUuid(user?.userId || user?.id),
      },
    });
  }

  async updateStaffRequirement(id: string, dto: UpdateStaffRequirementDto, user: any) {
    return (this.prisma as any).staffRequirement.update({
      where: { id },
      data: {
        ...(dto.fulfilledPositions !== undefined ? { fulfilledPositions: Number(dto.fulfilledPositions) } : {}),
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.notes ? { notes: dto.notes } : {}),
      },
    });
  }

  // ==========================================
  // PHASE 16: SALES PIPELINE WORKFLOW & TARGETS
  // ==========================================

  async transitionSalesStage(dto: TransitionSalesStageDto, user: any) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: dto.leadId },
    });
    if (!lead) throw new NotFoundException(`Lead ${dto.leadId} not found`);

    const stageRecord = await (this.prisma as any).salesPipelineStage.create({
      data: {
        leadId: dto.leadId,
        stage: dto.stage,
        previousStage: dto.previousStage || (lead as any).serviceInterest || null,
        actorId: this.safeUuid(user?.userId || user?.id) || lead.id,
        actorName: user?.name || user?.email || 'Sales Specialist',
        notes: dto.notes || null,
        tariffAmount: dto.tariffAmount ? Number(dto.tariffAmount) : null,
        officeServiceCharge: dto.officeServiceCharge ? Number(dto.officeServiceCharge) : null,
        paymentStatus: dto.paymentStatus || null,
        matchedStaffId: dto.matchedStaffId || null,
        alternateStaffId: dto.alternateStaffId || null,
        nextActionDate: dto.nextActionDate ? new Date(dto.nextActionDate) : null,
        metadata: dto.metadata || null,
      },
    });

    let newLeadStatus = lead.status;
    if (dto.stage === 'QUALIFIED') newLeadStatus = 'IN_PROGRESS' as any;
    if (dto.stage === 'BUSINESS_CLOSED') newLeadStatus = 'POSITIVE' as any;
    if (dto.stage === 'CLOSED_WON') newLeadStatus = 'CONVERTED' as any;

    await this.prisma.lead.update({
      where: { id: dto.leadId },
      data: { status: newLeadStatus },
    });

    this.logger.log(`Sales lead ${dto.leadId} transitioned to ${dto.stage} by ${user?.email}`);
    return stageRecord;
  }

  async getSalesPipelineHistory(leadId: string) {
    return (this.prisma as any).salesPipelineStage.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getSalesTargetStatus(agentId: string) {
    const monthlyTarget = 500000;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const stages = await (this.prisma as any).salesPipelineStage.findMany({
      where: {
        stage: { in: ['BUSINESS_CLOSED', 'CLOSED_WON', 'PAYMENT_COLLECTED'] },
        actorId: agentId,
        createdAt: { gte: startOfMonth },
      },
      select: { tariffAmount: true, officeServiceCharge: true },
    });

    const closedRevenue = stages.reduce((acc: number, s: any) => acc + (Number(s.tariffAmount) || 0), 0);
    const officeCharges = stages.reduce((acc: number, s: any) => acc + (Number(s.officeServiceCharge) || 0), 0);
    const achievementPercent = Math.min(Math.round((closedRevenue / monthlyTarget) * 100), 100);

    return {
      monthlyTarget,
      closedRevenue,
      officeCharges,
      achievementPercent,
      isTargetMet: closedRevenue >= monthlyTarget,
      pendingToTarget: Math.max(monthlyTarget - closedRevenue, 0),
    };
  }

  // ==========================================
  // PHASE 16: CCR COMPLAINTS & CUSTOMER CARE
  // ==========================================

  async createCcrComplaint(dto: CreateCcrComplaintDto, user: any) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: dto.customerId },
    });
    if (!customer) throw new NotFoundException(`Customer ${dto.customerId} not found`);

    const ticket = await this.prisma.ticket.create({
      data: {
        customerId: dto.customerId,
        category: dto.category || 'COMPLAINT',
        priority: dto.priority || 'HIGH',
        status: 'OPEN',
        severity: dto.severity || 'NORMAL',
        source: dto.source || 'PHONE',
        affectedStaffId: dto.affectedStaffId || null,
        investigationNotes: dto.investigationNotes || null,
        agentId: this.safeUuid(dto.agentId || user?.agentId || user?.id),
      } as any,
    });

    this.logger.log(`Created CCR Complaint Ticket ${ticket.id} for customer ${dto.customerId}`);
    return ticket;
  }

  async updateCcrComplaint(id: string, dto: UpdateCcrComplaintDto, user: any) {
    const existing = await this.prisma.ticket.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Ticket ${id} not found`);

    if (dto.status === 'CLOSED' && !dto.resolution) {
      throw new BadRequestException('A formal resolution summary is required to close a complaint ticket');
    }

    const dataToUpdate: any = {
      ...(dto.status ? { status: dto.status } : {}),
      ...(dto.resolution ? { resolution: dto.resolution } : {}),
      ...(dto.severity ? { severity: dto.severity } : {}),
      ...(dto.replacementStaffId ? { replacementStaffId: dto.replacementStaffId } : {}),
      ...(dto.investigationNotes ? { investigationNotes: dto.investigationNotes } : {}),
      ...(dto.managerApprovalStatus ? { managerApprovalStatus: dto.managerApprovalStatus } : {}),
      ...(dto.threeDayFollowupDate ? { threeDayFollowupDate: new Date(dto.threeDayFollowupDate) } : {}),
      ...(dto.threeDayFollowupNotes ? { threeDayFollowupNotes: dto.threeDayFollowupNotes } : {}),
      ...(dto.tenDayFollowupDate ? { tenDayFollowupDate: new Date(dto.tenDayFollowupDate) } : {}),
      ...(dto.tenDayFollowupNotes ? { tenDayFollowupNotes: dto.tenDayFollowupNotes } : {}),
      ...(dto.customerSatisfactionScore !== undefined ? { customerSatisfactionScore: Number(dto.customerSatisfactionScore) } : {}),
      ...(dto.testimonialNotes ? { testimonialNotes: dto.testimonialNotes } : {}),
      ...(dto.referralNotes ? { referralNotes: dto.referralNotes } : {}),
      ...(dto.status === 'CLOSED' ? { closedById: this.safeUuid(user?.userId || user?.id), closedAt: new Date() } : {}),
    };

    return this.prisma.ticket.update({
      where: { id },
      data: dataToUpdate,
    });
  }

  // ==========================================
  // PHASE 16: SOP DAILY REPORTS (PERSISTED METRICS)
  // ==========================================

  async submitDailyReport(dto: SubmitSopDailyReportDto, user: any) {
    const reportDate = new Date(dto.reportDate);
    const reporterId = this.safeUuid(user?.userId || user?.id) || user?.id;
    const reporterName = user?.name || user?.email || 'Operations Officer';

    const report = await (this.prisma as any).sopDailyReport.upsert({
      where: {
        department_reportDate_reporterId: {
          department: dto.department,
          reportDate,
          reporterId,
        },
      },
      update: {
        metrics: dto.metrics,
        status: 'SUBMITTED',
        unitId: this.safeUuid(dto.unitId),
      },
      create: {
        department: dto.department,
        reportDate,
        reporterId,
        reporterName,
        metrics: dto.metrics,
        status: 'SUBMITTED',
        unitId: this.safeUuid(dto.unitId),
      },
    });

    this.logger.log(`Submitted SOP Daily Report for ${dto.department} on ${dto.reportDate} by ${reporterName}`);
    return report;
  }

  async getDailyReports(department?: SopDepartment, dateStr?: string) {
    const where: any = {};
    if (department) where.department = department;
    if (dateStr) where.reportDate = new Date(dateStr);

    return (this.prisma as any).sopDailyReport.findMany({
      where,
      orderBy: { reportDate: 'desc' },
      take: 50,
    });
  }
}

