const mediasoup = require('mediasoup');
const ffmpegStatic = require('ffmpeg-static');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL || 'https://xciizdagxoagcsogdlsc.supabase.co', process.env.SUPABASE_SERVICE_ROLE_KEY);

let worker;
let router;

// Global structure to hold calls: { [callSid]: { router, producers: [], consumers: [], transports: [] } }
const activeRooms = new Map();

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2
  }
];

async function initMediasoup() {
  worker = await mediasoup.createWorker({
    logLevel: 'warn',
    rtcMinPort: 10000,
    rtcMaxPort: 10100,
  });

  worker.on('died', () => {
    console.error('Mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });

  router = await worker.createRouter({ mediaCodecs });
  console.log('✅ Mediasoup Worker and Global Router initialized.');
}

async function getRouterRtpCapabilities() {
  if (!router) await initMediasoup();
  return router.rtpCapabilities;
}

async function createWebRtcTransport() {
  if (!router) throw new Error('Router not initialized');
  
  // Auto-detect LAN IP for cross-device testing (Prioritize Wi-Fi/Ethernet over WSL/Hyper-V)
  const os = require('os');
  const networkInterfaces = os.networkInterfaces();
  let localIp = '127.0.0.1';
  
  for (const interfaceName of Object.keys(networkInterfaces)) {
    // Skip virtual adapters like WSL or Hyper-V
    if (interfaceName.toLowerCase().includes('veth') || interfaceName.toLowerCase().includes('wsl') || interfaceName.toLowerCase().includes('virtual')) {
      continue;
    }
    for (const iface of networkInterfaces[interfaceName]) {
      // Skip internal and non-IPv4 addresses
      if (!iface.internal && iface.family === 'IPv4') {
        localIp = iface.address;
        break;
      }
    }
  }
  
  // Hard override just in case it fails to detect the correct one
  if (localIp === '127.0.0.1' || localIp.startsWith('172.')) {
     // fallback attempt to find a 192.168.x.x
     for (const interfaceName of Object.keys(networkInterfaces)) {
        for (const iface of networkInterfaces[interfaceName]) {
           if (iface.family === 'IPv4' && iface.address.startsWith('192.168.')) {
               localIp = iface.address;
           }
        }
     }
  }

  const announcedIp = process.env.MEDIASOUP_ANNOUNCED_IP || localIp;
  const listenIp = process.env.MEDIASOUP_LISTEN_IP || '0.0.0.0';

  console.log(`[Mediasoup] Binding to IP: ${listenIp}, Announcing IP: ${announcedIp}`);

  const transport = await router.createWebRtcTransport({
    listenIps: [
      {
        ip: listenIp,
        announcedIp: announcedIp
      }
    ],
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
  });

  transport.on('dtlsstatechange', dtlsState => {
    if (dtlsState === 'closed' || dtlsState === 'failed') transport.close();
  });

  transport.on('routerclose', () => transport.close());

  return transport;
}

// ---------------------------------------------------------
// FFMPEG RECORDING PIPELINE
// ---------------------------------------------------------

const dgram = require('dgram');

function getAvailableUdpPort() {
  return new Promise((resolve, reject) => {
    const server = dgram.createSocket('udp4');
    server.on('error', reject);
    server.bind(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

const recordingProcesses = new Map(); // callSid -> ffmpeg process

async function startRecording(callSid, producer) {
  if (recordingProcesses.has(callSid)) return; // Already recording this room
  recordingProcesses.set(callSid, 'pending'); // Set pending to prevent race conditions

  const plainTransport = await router.createPlainTransport({
    listenIp: { ip: '127.0.0.1', announcedIp: null },
    rtcpMux: false,
    comedia: false
  });

  const ffmpegPort = await getAvailableUdpPort();
  const ffmpegRtcpPort = await getAvailableUdpPort();

  await plainTransport.connect({
    ip: '127.0.0.1',
    port: ffmpegPort,
    rtcpPort: ffmpegRtcpPort
  });

  const consumer = await plainTransport.consume({
    producerId: producer.id,
    rtpCapabilities: router.rtpCapabilities,
    paused: false,
  });

  const payloadType = consumer.rtpParameters.codecs[0].payloadType;

  // FFmpeg requires an SDP file to know how to ingest the RTP stream
  const sdpString = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=Mediasoup Audio Recording
c=IN IP4 127.0.0.1
t=0 0
m=audio ${ffmpegPort} RTP/AVP ${payloadType}
a=rtpmap:${payloadType} opus/48000/2
a=recvonly
`;

  const sdpPath = path.join(__dirname, `../../temp_${callSid}.sdp`);
  const outPath = path.join(__dirname, `../../recordings/`);
  if (!fs.existsSync(outPath)) fs.mkdirSync(outPath, { recursive: true });
  
  const finalFile = path.join(outPath, `${callSid}.webm`);
  fs.writeFileSync(sdpPath, sdpString);

  // Spawn ffmpeg
  const ffmpegArgs = [
    '-protocol_whitelist', 'file,rtp,udp',
    '-i', sdpPath,
    '-c:a', 'libopus',
    '-y',
    finalFile
  ];

  const process = spawn(ffmpegStatic, ffmpegArgs);
  
  process.stderr.on('data', (data) => {
    console.error(`[FFmpeg Error]: ${data.toString()}`);
  });

  process.on('error', (err) => {
    console.error(`[FFmpeg] Failed to start recording for call ${callSid}:`, err);
  });

  recordingProcesses.set(callSid, { process, consumer, plainTransport, finalFile, sdpPath });

  console.log(`[CALL-RECORDING] provider=legacy_mediasoup callId=${callSid}`);
  console.log(`🎙️ Started FFmpeg recording for call ${callSid} to ${finalFile}`);
}

async function stopRecordingAndUpload(callSid) {
  const rec = recordingProcesses.get(callSid);
  if (!rec) return null;
  
  recordingProcesses.delete(callSid);

  if (rec === 'pending') {
    return null; // The process didn't finish starting yet, skip upload
  }

  rec.consumer.close();
  rec.plainTransport.close();
  
  return new Promise((resolve) => {
    if (rec.process.stdin) {
      rec.process.stdin.write('q\n');
    } else {
      rec.process.kill('SIGINT');
    }
    
    rec.process.on('close', async () => {
      console.log(`🎙️ Stopped FFmpeg recording for call ${callSid}`);
      
      try {
        if (fs.existsSync(rec.sdpPath)) fs.unlinkSync(rec.sdpPath);
        
        if (!fs.existsSync(rec.finalFile)) {
          console.error(`[FFmpeg] Recording file was not created (likely no audio received): ${rec.finalFile}`);
          resolve(null);
          return;
        }

        // Upload to Supabase Storage
        const fileBuffer = fs.readFileSync(rec.finalFile);
        const fileName = `Call-Recording/${callSid}_${Date.now()}.webm`;
        
        const { data, error } = await supabase.storage
          .from('project-files')
          .upload(fileName, fileBuffer, {
            contentType: 'audio/webm',
          });
          
        if (error) throw error;
        
        const { data: publicData } = supabase.storage.from('project-files').getPublicUrl(fileName);
        fs.unlinkSync(rec.finalFile); // Cleanup local
        
        resolve(publicData.publicUrl);
      } catch (err) {
        console.error('Failed to upload recording:', err);
        resolve(null);
      }
    });
  });
}

module.exports = {
  initMediasoup,
  getRouterRtpCapabilities,
  createWebRtcTransport,
  startRecording,
  stopRecordingAndUpload,
  getRouter: () => router, // exported for signaling to manage activeRooms
};
