FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY assets ./assets

EXPOSE 3000
CMD ["node", "--max-old-space-size=160", "src/index.js"]
