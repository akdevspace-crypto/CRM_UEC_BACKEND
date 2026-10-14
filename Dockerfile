# Build Stage
FROM node:18-alpine AS builder

WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Generate Prisma Client (if prisma schema is moved here in future, else it uses the shared one)
# RUN npx prisma generate

# Build NestJS application
RUN npm run build

# Production Stage
FROM node:18-alpine

WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist
COPY --from=builder /usr/src/app/package*.json ./

# The command will be overridden by docker-compose for specific microservices
CMD ["npm", "run", "start:prod"]
