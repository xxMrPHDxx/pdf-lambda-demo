.PHONY: test build build-lambda clean

test:
	go test ./...

build:
	go build ./...

# Produces Linux bootstrap binaries and zips for AWS Lambda (provided.al2023).
build-lambda:
	mkdir -p bin/pdfworker bin/zipper dist
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags lambda.norpc -trimpath -ldflags="-s -w" -o bin/pdfworker/bootstrap ./cmd/pdfworker
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags lambda.norpc -trimpath -ldflags="-s -w" -o bin/zipper/bootstrap ./cmd/zipper
	cd bin/pdfworker && zip -q -r ../../dist/pdfworker.zip bootstrap
	cd bin/zipper && zip -q -r ../../dist/zipper.zip bootstrap

clean:
	rm -rf bin dist
