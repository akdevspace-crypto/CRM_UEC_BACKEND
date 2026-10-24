import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoomServiceClient, SipClient } from 'livekit-server-sdk';

@Injectable()
export class LivekitService implements OnModuleInit {
  public roomServiceClient: RoomServiceClient;
  public sipClient: SipClient;
  private readonly logger = new Logger(LivekitService.name);

  constructor(private configService: ConfigService) {}

  async removeParticipant(roomName: string, identity: string): Promise<boolean> {
    if (!this.roomServiceClient) return false;
    try {
      await this.roomServiceClient.removeParticipant(roomName, identity);
      this.logger.log(`[LIVEKIT] Successfully removed participant: ${identity} from room: ${roomName}`);
      return true;
    } catch (e: any) {
      this.logger.warn(`[LIVEKIT] Could not remove participant ${identity}: ${e.message}`);
      return false;
    }
  }

  async listParticipants(roomName: string): Promise<any[]> {
    if (!this.roomServiceClient) return [];
    try {
      return await this.roomServiceClient.listParticipants(roomName);
    } catch (e: any) {
      this.logger.warn(`[LIVEKIT] Could not list participants for ${roomName}: ${e.message}`);
      return [];
    }
  }

  onModuleInit() {
    const livekitApiUrl = this.configService.get<string>('LIVEKIT_API_URL');
    const livekitWsUrl = this.configService.get<string>('LIVEKIT_WS_URL');
    const apiKey = this.configService.get<string>('LIVEKIT_API_KEY');
    const apiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');

    this.logger.log(`LIVEKIT_API_URL present: ${!!livekitApiUrl}`);
    this.logger.log(`LIVEKIT_API_URL scheme: ${livekitApiUrl?.startsWith('https') ? 'https' : 'http'}`);
    this.logger.log(`LIVEKIT_WS_URL present: ${!!livekitWsUrl}`);
    this.logger.log(`LIVEKIT_SIP_HOST: ${this.configService.get<string>('LIVEKIT_SIP_HOST')}`);
    this.logger.log(`LIVEKIT_VOBIZ_OUTBOUND_TRUNK_ID: ${this.configService.get<string>('LIVEKIT_VOBIZ_OUTBOUND_TRUNK_ID')}`);
    this.logger.log(`LIVEKIT_VOBIZ_INBOUND_TRUNK_ID: ${this.configService.get<string>('LIVEKIT_VOBIZ_INBOUND_TRUNK_ID')}`);
    this.logger.log(`LIVEKIT_API_KEY present: ${!!apiKey}`);
    this.logger.log(`LIVEKIT_API_SECRET present: ${!!apiSecret}`);

    if (!livekitApiUrl || !apiKey || !apiSecret) {
      this.logger.warn('LiveKit configuration is missing in environment variables.');
      return;
    }

    this.roomServiceClient = new RoomServiceClient(
      livekitApiUrl,
      apiKey,
      apiSecret,
    );
    this.sipClient = new SipClient(livekitApiUrl, apiKey, apiSecret);
    this.logger.log('LiveKit RoomServiceClient and SipClient initialized.');
    this.ensureInboundDispatchRule().catch((err) => {
      this.logger.warn(`Failed to verify inbound SIP dispatch rule: ${err.message}`);
    });
  }

  async ensureInboundDispatchRule(): Promise<void> {
    if (!this.sipClient) return;
    try {
      const trunkId = this.configService.get<string>('LIVEKIT_VOBIZ_INBOUND_TRUNK_ID') || 'ST_QnCWUVduoZN5';
      const rules = await this.sipClient.listSipDispatchRule();
      const hasCalleeRule = rules.some(r => r.trunkIds?.includes(trunkId) && (r.rule as any)?.dispatchRuleCallee);
      if (!hasCalleeRule) {
        this.logger.log(`Configuring callee dispatch rule for inbound trunk ${trunkId}...`);
        await this.sipClient.createSipDispatchRule(
          {
            type: 'callee',
            roomPrefix: '',
            pin: '',
            randomize: false,
          },
          {
            name: 'Vobiz-Inbound',
            trunkIds: [trunkId],
            hidePhoneNumber: false,
          }
        );
        this.logger.log(`Successfully verified and applied callee dispatch rule for trunk ${trunkId}`);
      }
    } catch (e: any) {
      this.logger.warn(`Could not ensure inbound SIP dispatch rule: ${e.message}`);
    }
  }

  async createRoom(roomName: string) {
    if (!this.roomServiceClient) {
      this.logger.error('RoomServiceClient is not initialized.');
      throw new Error('LiveKit not configured');
    }

    try {
      this.logger.log(`Attempting to create LiveKit room: ${roomName}`);
      const room = await this.roomServiceClient.createRoom({
        name: roomName,
        emptyTimeout: 10 * 60, // 10 minutes timeout if empty
        maxParticipants: 10,
      });
      this.logger.log(`LiveKit room created successfully: ${room.name}`);
      return room;
    } catch (error) {
      this.logger.error(
        `Failed to create LiveKit room: ${error.message}`,
        error.stack,
      );
      throw error;
    }
  }

  async generateAgentToken(
    roomName: string,
    participantName: string,
  ): Promise<string> {
    const { AccessToken } = require('livekit-server-sdk');

    const livekitUrl = this.configService.get<string>('LIVEKIT_WS_URL') || this.configService.get<string>('LIVEKIT_API_URL');
    const apiKey = this.configService.get<string>('LIVEKIT_API_KEY');
    const apiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');

    if (!apiKey || !apiSecret) {
      throw new Error('LiveKit configuration missing');
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: `agent_${participantName.replace(/\s+/g, '_')}_${Date.now()}`,
      name: participantName,
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });
    return await at.toJwt();
  }

  async startRoomRecording(roomName: string): Promise<string> {
    const { EgressClient, EncodedFileType, EncodedFileOutput, S3Upload } = require('livekit-server-sdk');
    const livekitApiUrl = this.configService.get<string>('LIVEKIT_API_URL');
    const apiKey = this.configService.get<string>('LIVEKIT_API_KEY');
    const apiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');

    if (!livekitApiUrl || !apiKey || !apiSecret) {
      throw new Error('LiveKit configuration missing');
    }

    const egressClient = new EgressClient(livekitApiUrl, apiKey, apiSecret);
    
    const accessKey = process.env.EGRESS_S3_ACCESS_KEY;
    const secret = process.env.EGRESS_S3_SECRET;
    const region = process.env.EGRESS_S3_REGION;
    const bucket = process.env.EGRESS_S3_BUCKET;
    const endpoint = process.env.EGRESS_S3_ENDPOINT || (process.env.SUPABASE_URL ? `${process.env.SUPABASE_URL}/storage/v1/s3` : undefined);

    if (!accessKey || !secret || !region || !bucket) {
      this.logger.error(`[CALL-RECORDING] Missing EGRESS_S3 credentials`);
      throw new Error('EGRESS_S3 environment variables are missing');
    }

    const filepath = `recordings/${roomName}.mp4`;

    const fileOutput = new EncodedFileOutput({
      fileType: EncodedFileType.MP4,
      filepath: filepath,
      output: {
        case: 's3',
        value: new S3Upload({
          accessKey: accessKey,
          secret: secret,
          region: region,
          bucket: bucket,
          forcePathStyle: true,
          ...(endpoint ? { endpoint } : {})
        })
      }
    });
    
    this.logger.log(`[CALL-RECORDING] event=EGRESS_OUTPUT_CONFIG provider=s3 bucket=${bucket} region=${region} endpointConfigured=${!!endpoint} audioOnly=true filepath=${filepath}`);

    const info = await egressClient.startRoomCompositeEgress(
      roomName,
      { file: fileOutput },
      { audioOnly: true }
    );

    if (!info || !info.egressId) {
      throw new Error(`LiveKit Egress client returned empty egressId for room ${roomName}`);
    }

    return info.egressId;
  }

  async stopRoomRecording(egressId: string): Promise<void> {
    const { EgressClient } = require('livekit-server-sdk');
    const livekitApiUrl = this.configService.get<string>('LIVEKIT_API_URL');
    const apiKey = this.configService.get<string>('LIVEKIT_API_KEY');
    const apiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');

    if (!livekitApiUrl || !apiKey || !apiSecret) {
      throw new Error('LiveKit configuration missing');
    }

    const egressClient = new EgressClient(livekitApiUrl, apiKey, apiSecret);
    await egressClient.stopEgress(egressId);
  }

  async getRoomParticipants(roomName: string) {
    if (!this.roomServiceClient) return [];
    try {
      return await this.roomServiceClient.listParticipants(roomName);
    } catch (e) {
      return [];
    }
  }

  async getEgressInfo(egressId: string) {
    const { EgressClient } = require('livekit-server-sdk');
    const livekitApiUrl = this.configService.get<string>('LIVEKIT_API_URL');
    const apiKey = this.configService.get<string>('LIVEKIT_API_KEY');
    const apiSecret = this.configService.get<string>('LIVEKIT_API_SECRET');
    if (!livekitApiUrl || !apiKey || !apiSecret) {
      throw new Error('LiveKit configuration missing');
    }
    const egressClient = new EgressClient(livekitApiUrl, apiKey, apiSecret);
    const list = await egressClient.listEgress({ egressId });
    if (list && list.length > 0) {
      return list[0];
    }
    return null;
  }

  async hasPublishedTracks(roomName: string): Promise<boolean> {
    if (!this.roomServiceClient) return false;
    try {
      const participants =
        await this.roomServiceClient.listParticipants(roomName);
      // Check if any participant has published at least one track
      return participants.some((p) => p.tracks && p.tracks.length > 0);
    } catch (e) {
      // Room might not exist yet
      return false;
    }
  }

  async createSipParticipant(roomName: string, sipTrunkId: string, sipCallTo: string) {
    if (!this.sipClient) {
      throw new Error('LiveKit SipClient is not configured');
    }
    
    // Normalize destination to E.164 format if it's missing the + prefix. (Assuming India +91 for 10-digit numbers for this use-case based on instructions)
    let normalizedDestination = sipCallTo.replace(/\s+/g, '');
    if (normalizedDestination.length === 10) {
      normalizedDestination = '+91' + normalizedDestination;
    } else if (!normalizedDestination.startsWith('+')) {
      normalizedDestination = '+' + normalizedDestination;
    }

    this.logger.log(JSON.stringify({
      trunkId: sipTrunkId,
      destination: normalizedDestination,
      roomName: roomName,
      destinationIsE164: normalizedDestination.startsWith('+') && normalizedDestination.length >= 12,
      trunkIdIsExpected: sipTrunkId === process.env.LIVEKIT_VOBIZ_OUTBOUND_TRUNK_ID
    }, null, 2));

    this.logger.log(`Creating SIP Participant in room ${roomName} via trunk ${sipTrunkId} to ${normalizedDestination}`);
    
    const participantIdentity = `sip_${normalizedDestination.replace('+', '')}_${Date.now()}`;
    const callerId = process.env.VOBIZ_PHONE_NUMBER || '+918064267760';
    await this.sipClient.createSipParticipant(sipTrunkId, normalizedDestination, roomName, {
      participantIdentity,
      fromNumber: callerId,
      playDialtone: true,
      playRingtone: true,
    });
    return participantIdentity;
  }

  async findInboundSipRoom(callerNumber: string, maxAttempts = 10, delayMs = 1000): Promise<{ roomName: string, participantIdentity: string } | null> {
    if (!this.roomServiceClient) return null;
    
    // Normalize caller number to E.164 without plus for matching identity easily
    const normalizedCaller = callerNumber.replace(/\+/g, '').replace(/\s+/g, '');
    this.logger.log(`Polling for SIP room with participant matching ${normalizedCaller}...`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const rooms = await this.roomServiceClient.listRooms();
        for (const room of rooms) {
          if (!room.name.startsWith('call-') && !room.name.startsWith('call_')) continue;
          
          try {
            const participants = await this.roomServiceClient.listParticipants(room.name);
            const sipParticipant = participants.find(p => p.identity.startsWith('sip_') && p.identity.includes(normalizedCaller));
            
            if (sipParticipant) {
              this.logger.log(`Found SIP room ${room.name} with participant ${sipParticipant.identity} on attempt ${attempt}`);
              return { roomName: room.name, participantIdentity: sipParticipant.identity };
            }
          } catch (pErr) {
             // Ignore participant fetch errors for transient rooms
          }
        }
      } catch (err) {
        this.logger.warn(`Failed to list rooms on attempt ${attempt}: ${err.message}`);
      }
      
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
    
    this.logger.warn(`Failed to find SIP room for caller ${normalizedCaller} after ${maxAttempts} attempts`);
    return null;
  }

  async terminateLiveKitCall(roomName: string, callSid: string, sipParticipantIdentity?: string): Promise<string> {
    if (!this.roomServiceClient) return 'not_found';
    try {
      let terminationResult = 'not_found';
      let targetIdentity = sipParticipantIdentity;

      // Fallback if identity was not persisted
      if (!targetIdentity) {
        const participants = await this.roomServiceClient.listParticipants(roomName);
        const sipParticipant = participants.find(p => p.identity.startsWith('sip_'));
        if (sipParticipant) targetIdentity = sipParticipant.identity;
      }
      
      if (targetIdentity) {
        // Terminate the SIP participant
        await this.roomServiceClient.removeParticipant(roomName, targetIdentity);
        terminationResult = 'terminated';
        
        this.logger.log(`[CALL-LIFECYCLE] ` + JSON.stringify({
          event: 'sip_participant_removed',
          sessionID: callSid,
          roomName: roomName,
          participantIdentity: targetIdentity,
          source: 'backend_explicit_termination'
        }));
      }
      
      this.logger.log(JSON.stringify({
        callId: callSid,
        roomName: roomName,
        sipParticipantIdentity: targetIdentity || null,
        terminationResult: terminationResult,
        finalState: terminationResult === 'terminated' ? 'ended' : 'unknown'
      }, null, 2));

      return terminationResult;

    } catch (e) {
      // If room is already deleted or not found, it is considered terminated
      this.logger.log(JSON.stringify({
        callId: callSid,
        roomName: roomName,
        sipParticipantIdentity: sipParticipantIdentity || null,
        terminationResult: 'already_gone',
        finalState: 'ended'
      }, null, 2));
      return 'already_gone';
    }
  }
}





