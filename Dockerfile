# Track Node 26 updates; npm's strict engine check enforces the security floor.
FROM node:26-alpine

WORKDIR /app

COPY package*.json .npmrc ./

RUN node --version && npm ci

COPY . .

RUN npm run build

EXPOSE 8080

CMD ["node", "dist/server.js"]
