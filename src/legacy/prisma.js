const { PrismaClient } = require('@prisma/client');

function getPrisma() {
  if (!global.__prismaInstance) {
    global.__prismaInstance = new PrismaClient({
      log: ['warn', 'error'],
    });
  }
  return global.__prismaInstance;
}

module.exports = new Proxy({}, {
  get(target, prop) {
    const instance = getPrisma();
    const value = instance[prop];
    if (typeof value === 'function') {
      return value.bind(instance);
    }
    return value;
  }
});

