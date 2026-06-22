FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund
COPY . .
EXPOSE 5173
# Vite dev server (host 0.0.0.0); proxies /api to the backend via VITE_PROXY_TARGET.
CMD ["npm", "run", "dev"]
