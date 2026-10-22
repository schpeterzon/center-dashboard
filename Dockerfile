# Self-hosting: docker build -t center-dashboard . && docker run -p 8080:80 center-dashboard
FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN node tools/build.mjs && node tools/check.mjs

FROM nginx:1.27-alpine
COPY --from=build /app/dist/ /usr/share/nginx/html/
EXPOSE 80
