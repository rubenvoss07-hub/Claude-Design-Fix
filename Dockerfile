# Container image for Cursor Control. Works on Fly.io, Railway, Cloud Run,
# a VPS, or anywhere that runs Docker.
FROM node:22-alpine

WORKDIR /app

# Install production dependencies first (better layer caching).
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# The server honours $PORT (defaults to 3000). Most hosts set $PORT for you.
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
