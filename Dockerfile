FROM node:26-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV PORT=8787
EXPOSE 8787

CMD ["npm", "run", "server:start"]
