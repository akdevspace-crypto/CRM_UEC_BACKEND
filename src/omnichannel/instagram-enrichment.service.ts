import { Injectable, Inject, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Redis } from 'ioredis';
import { isGenericName } from './name-resolution.util';

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
    const cleanId = String(platformUserId).replace(/^ig_/, '');
    const cacheKey = `ig_profile:${cleanId}`;
    const fallbackLabel = `Instagram User (${cleanId.slice(-4)})`;

    // 1. Check Redis Cache
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        this.logger.log(`Found cached profile for IGSID ${cleanId}`);
        const profile = JSON.parse(cached);
        await this.updateCustomerIdentity(customerId, cleanId, profile);
        return profile;
      }
    } catch (err: any) {
      this.logger.warn(`Redis cache read failed: ${err.message}`);
    }

    // 2. Fetch from Meta Graph API
    let accessToken =
      process.env.META_PAGE_ACCESS_TOKEN ||
      process.env.META_ACCESS_TOKEN ||
      process.env.ACCESS_TOKEN;

    // Fallback to WHATSAPP_TOKEN if the active token is a legacy IG token
    if (accessToken && accessToken.startsWith('IG') && process.env.WHATSAPP_TOKEN) {
      this.logger.log(
        'Detected legacy IG token prefix. Falling back to WHATSAPP_TOKEN for Facebook Graph API request.',
      );
      accessToken = process.env.WHATSAPP_TOKEN;
    }

    if (!accessToken) {
      this.logger.warn(
        `Meta Access Token not configured. Using fallback profile for ${cleanId}.`,
      );
      const fallbackProfile = {
        name: fallbackLabel,
        username: null,
        profilePictureUrl: '',
        id: cleanId,
        enrichmentFailed: true,
      };
      await this.updateCustomerIdentity(customerId, cleanId, fallbackProfile);
      return fallbackProfile;
    }

    const fields = 'name,username,profile_pic';
    const url = `https://graph.facebook.com/v22.0/${cleanId}?fields=${fields}&access_token=${accessToken}`;

    try {
      this.logger.log(`Instagram Enrichment Request URL: ${url}`);
      const response = await fetch(url);
      const data = await response.json();

      if (!response.ok || data.error) {
        const errorMsg = data.error?.message || 'Meta API error';
        const errorCode = data.error?.code || 'META_API_ERROR';
        this.logger.error(
          `Meta Graph API failure: ${errorMsg}. Error Code: ${errorCode}, Type: ${data.error?.type}`,
        );

        const fallbackProfile = {
          name: fallbackLabel,
          username: null,
          profilePictureUrl: '',
          id: cleanId,
          enrichmentFailed: true,
        };

        // Cache short TTL (60s) to avoid hammering expired tokens, never 24h for failed calls
        try {
          await this.redis.set(cacheKey, JSON.stringify(fallbackProfile), 'EX', 60);
        } catch (_) {}

        await this.updateCustomerIdentity(customerId, cleanId, fallbackProfile);
        return fallbackProfile;
      }

      const verifiedName = data.name || (data.username ? `@${data.username.replace(/^@/, '')}` : fallbackLabel);
      const username = data.username ? `@${data.username.replace(/^@/, '')}` : null;

      const profile = {
        name: verifiedName,
        username,
        profilePictureUrl: data.profile_pic || '',
        id: data.id || cleanId,
        enrichmentFailed: false,
      };

      // 3. Cache valid profile in Redis for 24 hours
      try {
        await this.redis.set(
          cacheKey,
          JSON.stringify(profile),
          'EX',
          24 * 60 * 60,
        );
      } catch (cacheErr: any) {
        this.logger.warn(`Failed to write to Redis cache: ${cacheErr.message}`);
      }

      // 4. Update Database
      await this.updateCustomerIdentity(customerId, cleanId, profile);
      return profile;
    } catch (err: any) {
      this.logger.error(`Failed to enrich Instagram profile: ${err.message}`);
      const fallbackProfile = {
        name: fallbackLabel,
        username: null,
        profilePictureUrl: '',
        id: cleanId,
        enrichmentFailed: true,
      };
      await this.updateCustomerIdentity(customerId, cleanId, fallbackProfile);
      return fallbackProfile;
    }
  }

  private async updateCustomerIdentity(
    customerId: string,
    platformUserId: string,
    profile: {
      name?: string;
      username?: string | null;
      profilePictureUrl?: string;
      id: string;
      enrichmentFailed?: boolean;
    },
  ) {
    const existingCustomer = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });

    if (!existingCustomer) return;

    // Do NOT overwrite a verified customer name with a fallback or generic name
    let targetName = existingCustomer.name;
    if (isGenericName(existingCustomer.name) || !existingCustomer.name) {
      targetName = profile.name || (profile.username ? profile.username : `Instagram User (${platformUserId.slice(-4)})`);
    }

    // Normalize handle
    const handle = profile.username && !isGenericName(profile.username)
      ? `@${profile.username.replace(/^@/, '')}`
      : (existingCustomer.instagramUsername && !isGenericName(existingCustomer.instagramUsername)
          ? existingCustomer.instagramUsername
          : null);

    // Update Customer table
    await this.prisma.customer.update({
      where: { id: customerId },
      data: {
        name: targetName,
        instagramUsername: handle,
        instagramProfilePic: profile.profilePictureUrl || existingCustomer.instagramProfilePic,
        profileEnriched: !profile.enrichmentFailed,
        enrichmentFailed: Boolean(profile.enrichmentFailed),
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
          profilePicture: profile.profilePictureUrl || existingIdentity.profilePicture,
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
          profilePicture: profile.profilePictureUrl || null,
        },
      });
    }

    // Publish realtime updates via Redis Pub/Sub
    try {
      const payload = {
        type: 'instagram_profile_updated',
        data: {
          customerId,
          instagramUsername: handle,
          instagramProfilePic: profile.profilePictureUrl || existingCustomer.instagramProfilePic,
          name: targetName,
          enrichmentFailed: profile.enrichmentFailed || false,
        },
      };
      await this.redis.publish('omnichannel_events', JSON.stringify(payload));
      this.logger.log(
        `Published profile update event to Redis Pub/Sub for customer ${customerId}`,
      );
    } catch (pubErr: any) {
      this.logger.warn(`Redis publish failed: ${pubErr.message}`);
    }
  }
}
