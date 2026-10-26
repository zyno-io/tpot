FROM node:24-alpine

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
