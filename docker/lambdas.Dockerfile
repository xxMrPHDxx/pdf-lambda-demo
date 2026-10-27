FROM golang:1.25-alpine AS build
WORKDIR /src
RUN apk add --no-cache ca-certificates
COPY lambdas/go.mod lambdas/go.sum ./
RUN go mod download
COPY lambdas/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/devrunner ./cmd/devrunner

FROM alpine:3.21
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/devrunner /usr/local/bin/devrunner
ENTRYPOINT ["devrunner"]
