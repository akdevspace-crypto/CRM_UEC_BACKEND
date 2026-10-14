const { RoomServiceClient, SipClient } = require('livekit-server-sdk');
require('dotenv').config();

const roomService = new RoomServiceClient(
  process.env.LIVEKIT_API_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

const sipClient = new SipClient(
  process.env.LIVEKIT_API_URL,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

async function check() {
  console.log("Checking LiveKit Inbound Configuration and Rooms...");

  try {
    const trunks = await sipClient.listSipTrunk();
    console.log("SIP Trunks:", JSON.stringify(trunks, null, 2));

    const dispatchRules = await sipClient.listSipDispatchRule();
    console.log("Dispatch Rules:", JSON.stringify(dispatchRules, null, 2));

    const rooms = await roomService.listRooms();
    console.log("Active Rooms:", rooms.map(r => r.name));

    for (const room of rooms) {
      if (room.name.startsWith('call-')) {
        console.log(`\nInspecting Inbound Room: ${room.name}`);
        const participants = await roomService.listParticipants(room.name);
        console.log("Participants:");
        for (const p of participants) {
          console.log(`  - ${p.identity} (${p.kind === 2 ? 'SIP' : 'WebRTC'}) state=${p.state}`);
        }
      }
    }
  } catch (e) {
    console.error("Error:", e);
  }
}

check();
