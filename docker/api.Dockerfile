FROM node:22-alpine AS build
WORKDIR /app
COPY apps/api/package.json ./
RUN npm install --no-audit --no-fund
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/nest-cli.json ./
COPY apps/api/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY apps/api/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/main.js"]
