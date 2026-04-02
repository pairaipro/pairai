FROM node:24-slim
WORKDIR /app

# Install tsx globally for running TypeScript
RUN npm install -g tsx

# Copy bridge + channel (bridge imports from ../channel/lib.js)
COPY bridge/ bridge/
COPY channel/ channel/

# Install bridge dependencies
RUN cd bridge && npm install --production

# Install channel dependencies (needed for lib.js crypto imports)
RUN cd channel && npm install --production

USER node

# Run from /app so ../channel/lib.js resolves correctly.
# NODE_PATH ensures bridge/node_modules is in the module search path.
ENV NODE_PATH=/app/bridge/node_modules
ENTRYPOINT ["npx", "tsx", "bridge/bridge.ts", "serve"]
