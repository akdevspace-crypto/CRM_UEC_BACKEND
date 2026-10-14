import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Redis } from 'ioredis';

@Injectable()
export class InstagramProfileEnrichmentService {
  private readonly logger = new Logger(InstagramProfileEnrichmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  async enrichProfile(
    customerId: string,
    platformUserId: string,
  ): Promise<any> {
    this.logger.log(
      `Enriching Instagram profile for Customer ${customerId} (Platform UID: ${platformUserId})`,
    );
    const cacheKey = `ig_profile:${platformUserId}`;

    // 1. Check Redis Cache
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.log(`Found cached profile for IGSID ${platformUserId}`);
        const profile = JSON.parse(cached);
        await this.updateCustomerIdentity(customerId, platformUserId, profile);
        return profile;
      }
    } catch (err) {
      this.logger.warn(`Redis cache read failed: ${err.message}`);
    }

    // 2. Fetch from Meta Graph API
    let accessToken =
      process.env.META_PAGE_ACCESS_TOKEN ||
      process.env.META_ACCESS_TOKEN ||
      process.env.ACCESS_TOKEN ||
      'IGAAOguCTltA9BZAGF1eWE4cEt1dGRRNGJSX1pNOE5ZATHJwaUxpZAG91YV9PTkd0c0NUTlJmQ2M2WjlGNURuN2ZA4Y25LeE5WejNFQ0haTmJhQW9DU0pOVGExRmREUkJ0VUlJbTJrSk00RDY0OGNHbmZAxbkhPaF9BX0x2ZAE8xZAUhqbwZDZD';

    // Fallback to WHATSAPP_TOKEN if the active token is a legacy/deprecated Instagram Basic Display token starting with 'IG'
    if (accessToken.startsWith('IG') && process.env.WHATSAPP_TOKEN) {
      this.logger.log(
        'Detected legacy IG token prefix. Falling back to WHATSAPP_TOKEN for Facebook Graph API request.',
      );
      accessToken = process.env.WHATSAPP_TOKEN;
    }

    const fields = 'username,profile_pic';
    const url = `https://graph.facebook.com/v22.0/${platformUserId}?fields=${fields}&access_token=${accessToken}`;

    try {
      this.logger.log(`Instagram Enrichment Request URL: ${url}`);
      const response = await fetch(url);
      const data = await response.json();

      this.logger.log(`Instagram Enrichment Response: ${JSON.stringify(data)}`);

      if (!response.ok || data.error) {
        const errorMsg = data.error?.message || 'Meta API error';
        this.logger.error(
          `Meta Graph API failure: ${errorMsg}. Error Code: ${data.error?.code}, Type: ${data.error?.type}`,
        );
        console.log('META PROFILE ERROR:', data.error || errorMsg);

        // DEV/DEMO FALLBACK: Generate a realistic mock profile if Meta API fails (e.g. due to expired tokens)
        this.logger.warn(
          `Using fallback mock profile for ${platformUserId} due to Meta API error.`,
        );
        const mockProfile = {
          username: `Instagram Contact`,
          profilePictureUrl: ``,
          id: platformUserId,
          enrichmentFailed: true,
        };

        // Cache in Redis for 24 hours
        try {
          await this.redis.set(
            cacheKey,
            JSON.stringify(mockProfile),
            'EX',
            24 * 60 * 60,
          );
        } catch (cacheErr) {
          this.logger.warn(
            `Failed to write to Redis cache: ${cacheErr.message}`,
          );
        }

        // Update Database
        await this.updateCustomerIdentity(
          customerId,
          platformUserId,
          mockProfile,
        );
        return mockProfile;
      }

      if (!data.username) {
        this.logger.error(
          `Missing username error: Meta API did not return a username for user ${platformUserId}`,
        );
        console.log('META PROFILE ERROR:', 'Missing username in response');
        throw new Error('Meta API returned empty username');
      }

      console.log('META PROFILE RESPONSE:', data);

      const profile = {
        username: data.username,
        profilePictureUrl: data.profile_pic || '',
        id: data.id,
        enrichmentFailed: false,
      };

      // 3. Cache in Redis for 24 hours
      try {
        await this.redis.set(
          cacheKey,
          JSON.stringify(profile),
          'EX',
          24 * 60 * 60,
        );
      } catch (cacheErr) {
        this.logger.warn(`Failed to write to Redis cache: ${cacheErr.message}`);
      }

      // 4. Update Database
      await this.updateCustomerIdentity(customerId, platformUserId, profile);
      return profile;
    } catch (err) {
      this.logger.error(`Failed to enrich Instagram profile: ${err.message}`);
      throw err; // Rethrow to let BullMQ trigger retry
    }
  }

  private async updateCustomerIdentity(
    customerId: string,
    platformUserId: string,
    profile: {
      username: string;
      profilePictureUrl: string;
      id: string;
      enrichmentFailed?: boolean;
    },
  ) {
    const handle =
      profile.username === 'Instagram Contact'
        ? 'Instagram Contact'
        : `@${profile.username}`;

    // Normalize data and update Customer table
    await this.prisma.customer.update({
      where: { id: customerId },
      data: {
        name: handle,
        instagramUsername: handle,
        instagramProfilePic: profile.profilePictureUrl,
        profileEnriched: !profile.enrichmentFailed,
        lastProfileSync: new Date(),
      },
    });

    // Create or update PlatformIdentity record
    const existingIdentity = await this.prisma.platformIdentity.findFirst({
      where: { customerId, platform: 'INSTAGRAM', platformUserId },
    });

    if (existingIdentity) {
      await this.prisma.platformIdentity.update({
        where: { id: existingIdentity.id },
        data: {
          username: handle,
          profilePicture: profile.profilePictureUrl,
          updatedAt: new Date(),
        },
      });
    } else {
      await this.prisma.platformIdentity.create({
        data: {
          customerId,
          platform: 'INSTAGRAM',
          platformUserId,
          username: handle,
          profilePicture: profile.profilePictureUrl,
        },
      });
    }

    // 5. Publish realtime updates via Redis Pub/Sub
    try {
      const payload = {
        type: 'instagram_profile_updated',
        data: {
          customerId,
          instagramUsername: handle,
          instagramProfilePic: profile.profilePictureUrl,
          name: handle,
          enrichmentFailed: profile.enrichmentFailed || false,
        },
      };
      await this.redis.publish('omnichannel_events', JSON.stringify(payload));
      this.logger.log(
        `Published profile update event to Redis Pub/Sub for customer ${customerId}`,
      );
    } catch (pubErr) {
      this.logger.warn(`Redis publish failed: ${pubErr.message}`);
    }
  }
}
