.PHONY: dev
dev:
	npm run dev

.PHONY: test
test:
	npm test

# Page + server locally; radar.yaml comes from Outline if OUTLINE_* are set (e.g. in .env).
.PHONY: run
run:
	npm run build
	npm start

# Image name and platform. Override on the command line or in local/config.mk (git-ignored).
IMAGE ?= tech-radar
PLATFORM ?= linux/amd64
-include local/config.mk

TAG = $(shell date +"%Y%m%d-%H%M%S")

# Builds the image and pushes it to the registry in IMAGE.
.PHONY: docker-build
docker-build:
	docker buildx build \
	--platform $(PLATFORM) \
	-t $(IMAGE):$(TAG) -t $(IMAGE):latest \
	. --push
