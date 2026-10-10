# One image serves every role (api, migrate, seed, test); the compose service picks the
# command. Dev dependencies stay in so the same image can run the test suite.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/main.js"]
