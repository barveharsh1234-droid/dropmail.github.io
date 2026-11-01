FROM node:20-alpine
WORKDIR /app

# Install production dependencies only.
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy the app code.
COPY . .

# Defaults for cloud deployment. Override with `docker run -e ...` or your platform's env settings.
ENV HOST=0.0.0.0 \
    PORT=3000 \
    NODE_ENV=production
# AUTH_PASSWORD and SESSION_SECRET MUST be set at runtime.

# Persist the .data directory (inbox credentials) as a volume.
VOLUME ["/app/.data"]

EXPOSE 3000
CMD ["node", "server.js"]
