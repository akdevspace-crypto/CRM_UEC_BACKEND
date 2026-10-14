const { RoomServiceClient } = require('livekit-server-sdk');
require('dotenv').config();

const roomService = new RoomServiceClient(
  process.env.LIVEKIT_API_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

async function check() {
  console.log("Monitoring LiveKit for Inbound Rooms...");
  let seenRooms = new Set();
  
  setInterval(async () => {
    try {
      const rooms = await roomService.listRooms();
      for (const room of rooms) {
        if (!seenRooms.has(room.name) && room.name.startsWith('call-')) {
          seenRooms.add(room.name);
          console.log(`\n[INBOUND-CALL] livekit_sip_invite = RECEIVED (Evidence: Room created)`);
          console.log(`[INBOUND-CALL] dispatch_matched | roomName=${room.name}`);
          
          const participants = await roomService.listParticipants(room.name);
          let hasSip = false;
          let agentIdentity = null;
          let sipIdentity = null;
          for (const p of participants) {
            if (p.kind === 2 || p.identity.startsWith('sip_')) {
              hasSip = true;
              sipIdentity = p.identity;
            } else if (p.identity.includes('agent')) {
              agentIdentity = p.identity;
            }
          }
          
          if (hasSip) {
            console.log(`[INBOUND-CALL] sip_participant_joined | identity=${sipIdentity}`);
          }
          
          if (agentIdentity) {
            console.log(`[INBOUND-CALL] agent_joined | roomName=${room.name} identity=${agentIdentity}`);
          } else {
            console.log(`[INBOUND-CALL] agent_dispatch_start | roomName=${room.name} waiting for agent...`);
          }
        }
      }
    } catch (e) {}
  }, 2000);
}

check();
