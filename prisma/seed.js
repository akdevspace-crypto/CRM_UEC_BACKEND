const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding conversation history...');

  // 1. Create a mock customer
  const customer1 = await prisma.customer.create({
    data: {
      name: 'Alice Smith',
      phone: '+14155552671',
      email: 'alice.smith@example.com'
    }
  });

  const customer2 = await prisma.customer.create({
    data: {
      name: 'Bob Jones',
      phone: '+14155559988',
      email: 'bob.jones@example.com'
    }
  });

  // 2. Create Voice Conversation
  const voiceConv = await prisma.conversation.create({
    data: {
      customerId: customer1.id,
      channel: 'VOICE',
      priority: 'NORMAL',
      status: 'OPEN',
      unreadCount: 0
    }
  });

  // Voice Messages (Transcripts/Summaries)
  await prisma.message.create({
    data: {
      conversationId: voiceConv.id,
      senderType: 'SYSTEM',
      content: 'Call started via FreeSWITCH IVR. Department: appointments',
      status: 'DELIVERED'
    }
  });

  await prisma.message.create({
    data: {
      conversationId: voiceConv.id,
      senderType: 'CUSTOMER',
      content: 'Yes, I would like to schedule a home care appointment for next Tuesday.',
      status: 'DELIVERED'
    }
  });

  await prisma.message.create({
    data: {
      conversationId: voiceConv.id,
      senderType: 'AGENT',
      content: 'Absolutely, I have booked that for you. Is there anything else?',
      status: 'DELIVERED'
    }
  });

  // 3. Create Email Conversation
  const emailConv = await prisma.conversation.create({
    data: {
      customerId: customer2.id,
      channel: 'EMAIL',
      priority: 'HIGH',
      status: 'OPEN',
      unreadCount: 1
    }
  });

  await prisma.message.create({
    data: {
      conversationId: emailConv.id,
      senderType: 'CUSTOMER',
      content: 'Urgent: My care coordinator did not arrive today. Please advise.',
      status: 'DELIVERED'
    }
  });

  // 4. Create WhatsApp Conversation
  const waConv = await prisma.conversation.create({
    data: {
      customerId: customer1.id,
      channel: 'WHATSAPP',
      priority: 'NORMAL',
      status: 'RESOLVED',
      unreadCount: 0
    }
  });

  await prisma.message.create({
    data: {
      conversationId: waConv.id,
      senderType: 'CUSTOMER',
      content: 'Can you send me the billing statement?',
      status: 'DELIVERED'
    }
  });

  await prisma.message.create({
    data: {
      conversationId: waConv.id,
      senderType: 'AGENT',
      content: 'I have emailed you the billing statement. Have a great day!',
      status: 'DELIVERED'
    }
  });

  console.log('Successfully seeded database with conversation history!');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
