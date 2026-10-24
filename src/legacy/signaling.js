const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redis.on('error', (err) => {
  console.error('[Redis Signaling] Error:', err.message);
});

const jwt = require('jsonwebtoken');

// Helper to interact with Redis for agents
const redisKey = (id) => `agent:${id}`;

function setupSignaling(io) {
  io.on('connection', (socket) => {
    console.log(`Agent connected: ${socket.id}`);

    // Note: Agent authentication, multi-socket presence tracking, and status broadcasts
    // are authoritatively handled by TelephonyGateway (NestJS). Removing competing duplicate
    // listeners here prevents duplicate agent_status_change events and competing signaling paths.


    // WebRTC Signaling
    socket.on('initiateCall', async (data) => {
      console.log(`Agent ${socket.id} is initiating call to agent ${data.targetAgentId}`);
      
      const keys = await redis.keys('agent:*');
      let callerName = data.customerName || 'Agent';
      
      // Try to find the caller's name from redis
      const callerStr = await redis.get(redisKey(socket.id));
      if (callerStr) {
        callerName = JSON.parse(callerStr).name;
      }

      for (const key of keys) {
        const agentStr = await redis.get(key);
        if (agentStr) {
          const agent = JSON.parse(agentStr);
          if (agent.agentId === data.targetAgentId && agent.status === 'AVAILABLE') {
             io.to(agent.socketId).emit('incomingCall', {
               callSid: data.callSid,
               customerName: callerName,
               phone: 'Internal Directory Call',
               category: 'Internal',
               isCaller: false
             });
             // Removed break statement so that if there are zombie keys from a server crash, 
             // the system still continues the loop to find and ring the agent's actual active socket!
          }
        }
      }
    });

    socket.on('acceptCall', async (data) => {
      console.log(`Agent ${socket.id} accepted call ${data.callSid}`);
      
      const agentStr = await redis.get(redisKey(socket.id));
      let agentId = null;
      if (agentStr) {
        const agent = JSON.parse(agentStr);
        agentId = agent.agentId;
        agent.status = 'BUSY';
        await redis.set(redisKey(socket.id), JSON.stringify(agent));
        io.emit('agent_status_change', { agentId, status: 'BUSY' });
      }

      // Notify other agents or queue that call is taken
      io.emit('agentAssigned', { callSid: data.callSid, agentId });
      io.emit('queueUpdated', { count: -1 });
      io.emit('callAccepted', data);
    });

    socket.on('rejectCall', async (data) => {
      console.log(`Agent ${socket.id} rejected call ${data.callSid}`);
      io.emit('callRejected', data);
    });

    // ==========================================
    // PURE WEBRTC SIGNALING (Peer-to-Peer)
    // ==========================================
    socket.on('webrtc_join', ({ callSid }) => {
      console.log(`[Pure WebRTC] Socket ${socket.id} joined room webrtc_${callSid}`);
      socket.join(`webrtc_${callSid}`);
      socket.to(`webrtc_${callSid}`).emit('webrtc_peer_joined', { socketId: socket.id, callSid });
    });

    socket.on('webrtc_offer', ({ callSid, sdp, targetSocketId }) => {
      console.log(`[Pure WebRTC] Relaying SDP Offer for call ${callSid} from ${socket.id}`);
      if (targetSocketId) {
        io.to(targetSocketId).emit('webrtc_offer', { from: socket.id, callSid, sdp });
      } else {
        socket.to(`webrtc_${callSid}`).emit('webrtc_offer', { from: socket.id, callSid, sdp });
      }
    });

    socket.on('webrtc_answer', ({ callSid, sdp, targetSocketId }) => {
      console.log(`[Pure WebRTC] Relaying SDP Answer for call ${callSid} from ${socket.id}`);
      if (targetSocketId) {
        io.to(targetSocketId).emit('webrtc_answer', { from: socket.id, callSid, sdp });
      } else {
        socket.to(`webrtc_${callSid}`).emit('webrtc_answer', { from: socket.id, callSid, sdp });
      }
    });

    socket.on('webrtc_ice_candidate', ({ callSid, candidate, targetSocketId }) => {
      if (targetSocketId) {
        io.to(targetSocketId).emit('webrtc_ice_candidate', { from: socket.id, callSid, candidate });
      } else {
        socket.to(`webrtc_${callSid}`).emit('webrtc_ice_candidate', { from: socket.id, callSid, candidate });
      }
    });

    socket.on('webrtc_leave', ({ callSid }) => {
      socket.leave(`webrtc_${callSid}`);
      socket.to(`webrtc_${callSid}`).emit('webrtc_peer_left', { socketId: socket.id, callSid });
    });

    // ==========================================
    // LEGACY WEBRTC COMPATIBILITY STUBS
    // ==========================================
    const { getRouterRtpCapabilities, createWebRtcTransport, startRecording, stopRecordingAndUpload, getRouter } = require('./mediasoup');
    const prisma = require('./prisma');

    socket.on('getRouterRtpCapabilities', async (data, callback) => {
      try {
        const capabilities = await getRouterRtpCapabilities();
        callback({ capabilities });
      } catch (err) {
        callback({ error: err.message });
      }
    });

    socket.on('createWebRtcTransport', async (data, callback) => {
      try {
        const transport = await createWebRtcTransport();
        
        // Store transport in a global state if needed, but for simplicity, 
        // we can attach it to the socket object temporarily
        if (!socket.transports) socket.transports = new Map();
        socket.transports.set(transport.id, transport);

        callback({
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters
          }
        });
      } catch (err) {
        callback({ error: err.message });
      }
    });

    socket.on('connectWebRtcTransport', async ({ transportId, dtlsParameters }, callback) => {
      try {
        const transport = socket.transports.get(transportId);
        if (!transport) throw new Error(`Transport ${transportId} not found`);
        await transport.connect({ dtlsParameters });
        callback({ connected: true });
      } catch (err) {
        callback({ error: err.message });
      }
    });

    socket.on('produce', async ({ transportId, kind, rtpParameters, callSid }, callback) => {
      try {
        const transport = socket.transports.get(transportId);
        if (!transport) throw new Error(`Transport ${transportId} not found`);
        const producer = await transport.produce({ kind, rtpParameters });
        
        if (!socket.producers) socket.producers = new Map();
        socket.producers.set(producer.id, producer);

        // Start recording as soon as someone produces audio
        if (kind === 'audio') {
          await startRecording(callSid, producer);
        }

        // Notify other peer in the room that a new producer is available
        socket.broadcast.emit('newProducer', { producerId: producer.id, callSid });

        callback({ id: producer.id });
      } catch (err) {
        callback({ error: err.message });
      }
    });

    socket.on('consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
      try {
        const router = getRouter();
        if (!router.canConsume({ producerId, rtpCapabilities })) {
          throw new Error('Cannot consume');
        }
        const transport = socket.transports.get(transportId);
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: false,
        });

        if (!socket.consumers) socket.consumers = new Map();
        socket.consumers.set(consumer.id, consumer);

        callback({
          params: {
            id: consumer.id,
            producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
          }
        });
      } catch (err) {
        callback({ error: err.message });
      }
    });

    socket.on('endCall', async (data) => {
      // Ignore LiveKit calls in the legacy handler to prevent race conditions
      if (data.callSid && (data.callSid.startsWith('call_outbound') || data.callSid.startsWith('call_inbound'))) {
        return;
      }
      console.log(`Call ended: ${data.callSid}`);
      
      try {
        // Stop recording and upload
        const recordingUrl = await stopRecordingAndUpload(data.callSid);
        
        // Run AI Summary for all external calls (Inbound & Outbound) if recording is available
        const isInternal = data.category === 'Internal';
        const isOutbound = data.category === 'Outbound';
        let aiSummaryResult = null;
        
        // If not internal and recording exists, run AI summarization on the audio
        if (!isInternal && recordingUrl) {
          const { generateCallSummaryFromAudio } = require('./ai');
          aiSummaryResult = await generateCallSummaryFromAudio(recordingUrl, isOutbound);
          if (aiSummaryResult && !aiSummaryResult.summary.startsWith('Failed to generate')) {
            console.log(`[AI Summary] Successfully generated for call ${data.callSid}:`, aiSummaryResult.summary);
          } else {
            console.log(`[AI Summary] Failed for call ${data.callSid}`);
          }
        } else if (!isInternal) {
          console.log(`[AI Summary] Skipped for ${data.callSid} - no recording URL available.`);
        }

        // Ensure CallLog exists for WebRTC calls
        let callLog = await prisma.callLog.findFirst({ where: { vobizCallSid: data.callSid } });

        if (!callLog && data.phone) {
          // Find or create customer (for Internal it creates a mock customer)
          let customer = await prisma.customer.findFirst({ where: { phone: data.phone } });
          if (!customer) {
             customer = await prisma.customer.create({ data: { name: data.customerName || 'WebRTC Caller', phone: data.phone }});
          }
          // Create the call log manually
          callLog = await prisma.callLog.create({
            data: {
              customerId: customer.id,
              agentId: data.agentId || null,
              vobizCallSid: data.callSid,
              status: 'IN_PROGRESS',
              direction: isOutbound ? 'OUTBOUND' : 'INBOUND'
            }
          });
        }

        // Update Prisma CallSession or CallLog
        const updatedLog = await prisma.callLog.updateMany({
          where: { vobizCallSid: data.callSid },
          data: {
            status: 'ENDED',
            duration: data.duration || 0,
            recordingUrl: recordingUrl || null,
            direction: isOutbound ? 'OUTBOUND' : 'INBOUND'
          }
        });

        if (aiSummaryResult) {
          const callLog = await prisma.callLog.findFirst({ where: { vobizCallSid: data.callSid }});
          if (callLog && callLog.customerId) {
            await prisma.customerNote.create({
              data: {
                content: `[Call: ${data.callSid}] AI Call Summary: ${JSON.stringify(aiSummaryResult)}`,
                customerId: callLog.customerId,
                agentId: callLog.agentId || null
              }
            });
          }
        }
      } catch (err) {
        console.error("Critical error during endCall processing:", err);
      } finally {
        io.emit('callEnded', data);
      }
    });

    // Disconnect cleanup: Managed authoritatively by TelephonyGateway.handleDisconnect
    // to preserve multi-socket presence and prevent duplicate OFFLINE broadcasts.

  });
}

module.exports = { setupSignaling };
