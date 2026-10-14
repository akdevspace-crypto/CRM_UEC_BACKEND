import { Injectable, Logger } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingSource } from '@prisma/client';

@Injectable()
export class BookingAIToolsService {
  private readonly logger = new Logger(BookingAIToolsService.name);

  constructor(private readonly bookingService: BookingService) {}

  getAITools() {
    return [
      {
        name: 'check_availability',
        description: 'Check available appointment slots for a given date and doctor.',
        parameters: {
          type: 'object',
          properties: {
            doctorId: { type: 'string' },
            date: { type: 'string', description: 'YYYY-MM-DD format' },
            duration: { type: 'number', description: 'Duration in minutes (default 30)' },
          },
          required: ['doctorId', 'date'],
        },
      },
      {
        name: 'book_appointment',
        description: 'Book a new appointment after confirming availability.',
        parameters: {
          type: 'object',
          properties: {
            customerId: { type: 'string', description: 'The patient ID' },
            doctorId: { type: 'string', description: 'The doctor ID' },
            title: { type: 'string', description: 'Title or brief description of the appointment' },
            treatment: { type: 'string', description: 'The treatment requested' },
            date: { type: 'string', description: 'YYYY-MM-DD format' },
            startTime: { type: 'string', description: 'ISO 8601 UTC string' },
            duration: { type: 'number', description: 'Duration in minutes' },
          },
          required: ['customerId', 'doctorId', 'title', 'date', 'startTime', 'duration'],
        },
      },
      {
        name: 'cancel_appointment',
        description: 'Cancel an existing appointment.',
        parameters: {
          type: 'object',
          properties: {
            appointmentId: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['appointmentId'],
        },
      },
      {
        name: 'reschedule_appointment',
        description: 'Reschedule an existing appointment to a new time slot.',
        parameters: {
          type: 'object',
          properties: {
            appointmentId: { type: 'string' },
            newStartTime: { type: 'string', description: 'ISO 8601 UTC string' },
            duration: { type: 'number' },
            reason: { type: 'string' },
          },
          required: ['appointmentId', 'newStartTime', 'duration'],
        },
      },
    ];
  }

  async executeTool(toolName: string, args: any) {
    this.logger.log(`Executing AI Tool: ${toolName}`, args);
    try {
      switch (toolName) {
        case 'check_availability':
          const slots = await this.bookingService.checkAvailability(
            args.doctorId,
            args.date,
            args.duration || 30,
          );
          return { success: true, availableSlots: slots };

        case 'book_appointment':
          const appointment = await this.bookingService.createAppointment({
            ...args,
            bookingSource: BookingSource.AI_AGENT,
          });
          return { success: true, appointmentId: appointment.appointmentId, status: appointment.status };

        case 'cancel_appointment':
          const cancelled = await this.bookingService.cancelAppointment(args.appointmentId, args.reason);
          return { success: true, status: cancelled.status };

        case 'reschedule_appointment':
          const rescheduled = await this.bookingService.rescheduleAppointment(
            args.appointmentId,
            args.newStartTime,
            args.duration,
            args.reason,
          );
          return { success: true, status: rescheduled.status };

        default:
          return { success: false, error: 'Unknown tool name' };
      }
    } catch (error) {
      this.logger.error(`Error executing AI tool ${toolName}`, error);
      return { success: false, error: error.message };
    }
  }
}
