import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { InstagramProfileEnrichmentService } from './instagram-enrichment.service';

@Processor('instagram-enrichment')
export class InstagramEnrichmentProcessor extends WorkerHost {
  private readonly logger = new Logger(InstagramEnrichmentProcessor.name);

  constructor(
    private readonly enrichmentService: InstagramProfileEnrichmentService,
  ) {
    super();
  }

  async process(job: Job<any, any, string>): Promise<any> {
    const { customerId, platformUserId } = job.data;
    this.logger.log(
      `Processing instagram-enrichment job ${job.id} (Customer: ${customerId}, IGSID: ${platformUserId})`,
    );

    try {
      const profile = await this.enrichmentService.enrichProfile(
        customerId,
        platformUserId,
      );
      return { success: true, username: profile.username };
    } catch (err) {
      this.logger.error(`Job ${job.id} failed: ${err.message}`);
      throw err; // Let BullMQ handle retry backoff
    }
  }
}
