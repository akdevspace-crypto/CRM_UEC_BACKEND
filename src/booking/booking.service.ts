import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { AppointmentStatus, BookingSource } from '@prisma/client';
import { NotificationService } from '../notification/notification.service';

@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
  ) {}

  private generateBookingId(): string {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rnd = Math.floor(100000 + Math.random() * 900000);
    return `BK-${dateStr}-${rnd}`;
  }

  private validateBookingRequest(dto: CreateAppointmentDto) {
    if (!dto.customerId && !dto.leadId) {
      throw new BadRequestException('Either customerId or leadId must be provided to create a booking.');
    }
  }

  async getAllAppointments() {
    return this.prisma.appointment.findMany({
      include: {
        doctor: true,
        customer: true,
        lead: true,
      },
      orderBy: { startTime: 'desc' },
      take: 100,
    });
  }

  /**
   * Check doctor/slot availability
   */
  async checkAvailability(doctorId: string, date: string, duration: number) {
    const startOfDay = new Date(date);
    startOfDay.setUTCHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setUTCHours(23, 59, 59, 999);

    const existingAppointments = await this.prisma.appointment.findMany({
      where: {
        doctorId,
        startTime: {
          gte: startOfDay,
          lte: endOfDay,
        },
        status: {
          notIn: ['CANCELLED', 'RESCHEDULED'],
        },
      },
      orderBy: {
        startTime: 'asc',
      },
    });

    // Configurable working hours (will be replaced by Time Control Center later)
    const workingHoursStart = 9;
    const workingHoursEnd = 17;

    const availableSlots = [];
    const requestedDate = new Date(date);
    
    for (let hour = workingHoursStart; hour < workingHoursEnd; hour++) {
      for (let min = 0; min < 60; min += duration) {
        const slotStart = new Date(requestedDate);
        slotStart.setUTCHours(hour, min, 0, 0);
        
        const slotEnd = new Date(slotStart);
        slotEnd.setUTCMinutes(slotEnd.getUTCMinutes() + duration);

        const isConflict = existingAppointments.some((appt) => {
          return (
            (slotStart >= appt.startTime && slotStart < appt.endTime) ||
            (slotEnd > appt.startTime && slotEnd <= appt.endTime) ||
            (slotStart <= appt.startTime && slotEnd >= appt.endTime)
          );
        });

        if (!isConflict && slotStart > new Date()) {
          availableSlots.push({
            start: slotStart.toISOString(),
            end: slotEnd.toISOString(),
          });
        }
      }
    }

    return availableSlots;
  }

  /**
   * Get next valid available slot if requested slot is full
   */
  async getNextAvailableSlot(doctorId: string, date: string, preferredStartTime: string, duration: number) {
    const slots = await this.checkAvailability(doctorId, date, duration);
    const prefDate = new Date(preferredStartTime);
    
    const nextSlot = slots.find(s => new Date(s.start) >= prefDate);
    if (nextSlot) return nextSlot;
    
    if (slots.length > 0) return slots[0];
    
    return null;
  }

  /**
   * Fetch calendar range for week view
   */
  async getCalendar(startDate: string, endDate: string) {
    const start = new Date(startDate);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setUTCHours(23, 59, 59, 999);

    return this.prisma.appointment.findMany({
      where: {
        startTime: { gte: start, lte: end },
        status: { notIn: ['CANCELLED'] }
      },
      orderBy: { startTime: 'asc' },
      include: { 
        customer: true, 
        lead: true, 
        doctor: true 
      }
    });
  }

  /**
   * Unified create booking engine
   */
  async createAppointment(dto: CreateAppointmentDto) {
    this.validateBookingRequest(dto);

    const {
      customerId,
      leadId,
      callSessionId,
      doctorId,
      assignedAgentId,
      title,
      treatment,
      date,
      startTime,
      duration,
      timezone,
      bookingSource,
      notes,
    } = dto;

    const start = new Date(startTime);
    const end = new Date(start.getTime() + duration * 60000);
    const dateObj = new Date(date);

    const agentIdForCalendar = doctorId || assignedAgentId;
    if (!agentIdForCalendar) {
      throw new BadRequestException('Either doctorId or assignedAgentId must be provided');
    }

    // 1. Transactional booking to prevent double booking
    const appointment = await this.prisma.$transaction(async (tx) => {
      let calendar = await tx.calendar.findFirst({
        where: { agentId: agentIdForCalendar },
      });

      if (!calendar) {
        calendar = await tx.calendar.create({
          data: { agentId: agentIdForCalendar },
        });
      }

      // Final availability & conflict validation
      const conflicts = await tx.appointment.findMany({
        where: {
          doctorId,
          status: {
            notIn: ['CANCELLED', 'RESCHEDULED'],
          },
          OR: [
            { startTime: { lte: start }, endTime: { gt: start } },
            { startTime: { lt: end }, endTime: { gte: end } },
            { startTime: { gte: start }, endTime: { lte: end } },
          ],
        },
      });

      if (conflicts.length > 0) {
        throw new ConflictException('SLOT_UNAVAILABLE');
      }

      const bookingId = this.generateBookingId();

      return tx.appointment.create({
        data: {
          bookingId,
          calendarId: calendar.id,
          customerId,
          leadId,
          callSessionId,
          doctorId,
          assignedAgentId,
          title,
          treatment,
          date: dateObj,
          startTime: start,
          endTime: end,
          duration,
          timezone: timezone || 'UTC',
          status: AppointmentStatus.CONFIRMED,
          bookingSource: (bookingSource as BookingSource) || BookingSource.CRM,
          notes,
        },
        include: {
          customer: true,
          lead: true,
          doctor: true,
        },
      });
    });

    // 2. Trigger Automation/Notification (Fire and forget)
    if (appointment.customerId) {
      try {
        await this.notificationService.sendAppointmentNotification({
          type: 'APPOINTMENT_CREATED',
          channel: 'WHATSAPP',
          customerId: appointment.customerId,
          content: `Your appointment (${appointment.bookingId}) is confirmed for ${dateObj.toLocaleDateString()} at ${start.toLocaleTimeString()}.`,
        });
      } catch (e) {
        console.error('Failed to send appointment notification', e);
      }
    }

    return {
      success: true,
      bookingId: appointment.bookingId,
      appointmentId: appointment.id,
      patientId: appointment.customerId || null,
      leadId: appointment.leadId || null,
      date: appointment.date.toISOString().split('T')[0],
      startTime: appointment.startTime.toISOString(),
      endTime: appointment.endTime.toISOString(),
      status: appointment.status
    };
  }

  /**
   * Reschedule an appointment
   */
  async rescheduleAppointment(
    id: string,
    newStartTime: string,
    duration: number,
    reason?: string,
  ) {
    return await this.prisma.$transaction(async (tx) => {
      const existing = await tx.appointment.findUnique({
        where: { id },
      });

      if (!existing) {
        throw new NotFoundException('APPOINTMENT_NOT_FOUND');
      }

      if (existing.status === 'CANCELLED' || existing.status === 'COMPLETED') {
        throw new BadRequestException('INVALID_STATUS_TRANSITION');
      }

      const start = new Date(newStartTime);
      const end = new Date(start.getTime() + duration * 60000);
      const doctorId = existing.doctorId;

      const conflicts = await tx.appointment.findMany({
        where: {
          doctorId,
          id: { not: id },
          status: { notIn: ['CANCELLED', 'RESCHEDULED'] },
          OR: [
            { startTime: { lte: start }, endTime: { gt: start } },
            { startTime: { lt: end }, endTime: { gte: end } },
            { startTime: { gte: start }, endTime: { lte: end } },
          ],
        },
      });

      if (conflicts.length > 0) {
        throw new ConflictException('SLOT_UNAVAILABLE');
      }

      return tx.appointment.update({
        where: { id },
        data: {
          startTime: start,
          endTime: end,
          duration,
          date: start,
          status: AppointmentStatus.RESCHEDULED,
          rescheduleReason: reason,
        },
      });
    });
  }

  /**
   * Cancel an appointment
   */
  async cancelAppointment(id: string, reason?: string) {
    const existing = await this.prisma.appointment.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('APPOINTMENT_NOT_FOUND');
    }

    if (existing.status === 'CANCELLED' || existing.status === 'COMPLETED') {
      throw new BadRequestException('INVALID_STATUS_TRANSITION');
    }

    return await this.prisma.appointment.update({
      where: { id },
      data: {
        status: AppointmentStatus.CANCELLED,
        cancellationReason: reason,
      },
    });
  }

  /**
   * Change appointment status
   */
  async updateStatus(id: string, status: AppointmentStatus) {
    const existing = await this.prisma.appointment.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('APPOINTMENT_NOT_FOUND');
    }

    return await this.prisma.appointment.update({
      where: { id },
      data: { status },
    });
  }

  async getUpcomingAppointments(customerId: string) {
    return await this.prisma.appointment.findMany({
      where: {
        customerId,
        startTime: { gte: new Date() },
        status: { notIn: ['CANCELLED'] },
      },
      orderBy: { startTime: 'asc' },
    });
  }

  async getDoctorSchedule(doctorId: string, date: string) {
    const startOfDay = new Date(date);
    startOfDay.setUTCHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setUTCHours(23, 59, 59, 999);

    return await this.prisma.appointment.findMany({
      where: {
        doctorId,
        startTime: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      orderBy: { startTime: 'asc' },
      include: {
        customer: true,
        lead: true,
      },
    });
  }
}
