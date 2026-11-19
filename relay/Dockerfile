# AMIN CHAT relay — nothing to install, the relay uses only what ships with Node.
#   docker build -t amin-chat-relay relay/
#   docker run -d --restart unless-stopped -p 8080:8080 -e UPSTREAM=https://amin-chat.example.workers.dev -e RELAY_SECRET=... amin-chat-relay
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY relay.mjs ./
USER node
EXPOSE 8080
# Plain HTTP on 127.0.0.1: if you let the relay serve TLS itself (TLS_CERT_FILE), replace this check with one that speaks https.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/__relay/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "relay.mjs"]
