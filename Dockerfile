# Node2Shell / CVE-2026-111497 is fixed in Node 24.22.1.
FROM node:24.22.1-alpine

WORKDIR /app

COPY .node-version ./
RUN node -e "const expected = require('node:fs').readFileSync('.node-version', 'utf8').trim(); if (process.versions.node !== expected) throw new Error('Unexpected Node runtime: ' + process.version); console.log('Verified Node runtime:', process.version)"

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

EXPOSE 8080

CMD ["node", "dist/server.js"]
