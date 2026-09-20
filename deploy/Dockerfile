# syntax=docker/dockerfile:1

FROM golang:1.22-alpine AS build-server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ .
RUN CGO_ENABLED=0 go build -o /chute .

FROM node:22-alpine AS build-web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=build-server /chute /app/chute
COPY --from=build-web /web/dist /app/static
EXPOSE 8080
ENTRYPOINT ["/app/chute", "-addr", ":8080", "-static", "/app/static"]
