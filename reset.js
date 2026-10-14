const { PrismaClient } = require('@prisma/client'); 
const prisma = new PrismaClient(); 
prisma.agent.updateMany({ data: { status: 'AVAILABLE', activeCalls: 0 } }).then(res => { 
  console.log('Reset agents:', res); 
  prisma.$disconnect(); 
});
