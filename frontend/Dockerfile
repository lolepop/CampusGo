FROM node:26-alpine AS deps
WORKDIR /app

# only rebuild if deps change
COPY package.json package-lock.json* ./
RUN npm ci --include=optional

# dev env
FROM deps AS development
WORKDIR /app
# COPY . .

EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]

# TODO: production deployment; build and deploy in nginx