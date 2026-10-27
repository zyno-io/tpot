FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

RUN apk add --no-cache tini

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml tsconfig.base.json ./
COPY packages/server/package.json ./packages/server/
RUN corepack enable && yarn workspaces focus @zyno-io/tpot-server

COPY packages/server/tsconfig.json ./packages/server/
COPY packages/server/src/ ./packages/server/src/
RUN yarn workspace @zyno-io/tpot-server build

ENTRYPOINT [ "/sbin/tini", "--" ]
CMD [ "node", "packages/server/dist/index.js" ]

EXPOSE 3000
