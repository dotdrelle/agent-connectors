FROM node:22-alpine

# wikiLLM OAuth application, baked at build time. The values are never stored in
# the repository: they come from the gitignored `.env.build.local` next to this
# Dockerfile, which both `build-and-push.sh` and `wiki-workspace agents up`
# load before invoking the build. Both values belong to the distributed
# Desktop/public OAuth client; neither is a security boundary. The supported
# build entrypoints validate both values before invoking Docker (doing that in
# a RUN instruction would expand them into BuildKit logs).
ARG WIKILLM_GOOGLE_OAUTH_CLIENT_ID
ARG WIKILLM_GOOGLE_OAUTH_CLIENT_SECRET
ENV WIKILLM_GOOGLE_OAUTH_CLIENT_ID=${WIKILLM_GOOGLE_OAUTH_CLIENT_ID}
ENV WIKILLM_GOOGLE_OAUTH_CLIENT_SECRET=${WIKILLM_GOOGLE_OAUTH_CLIENT_SECRET}

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node

ENV CONNECTORS_PORT=3338
EXPOSE 3338

CMD ["npm", "start"]
