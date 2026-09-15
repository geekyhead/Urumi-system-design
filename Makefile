SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

ROOT_DIR := $(shell pwd)
export PATH := $(ROOT_DIR)/.bin:$(PATH)

CLUSTER_NAME ?= store-platform
PLATFORM_HOST ?= platform.127.0.0.1.nip.io
export CLUSTER_NAME PLATFORM_HOST

.PHONY: help setup deploy test clean lint build status logs

help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

setup: ## Create the Kind cluster with Ingress NGINX
	./scripts/setup-cluster.sh

deploy: ## Build images, load them into Kind and install the platform chart
	./scripts/deploy-platform.sh

test: ## Run the end-to-end verification (create store, place order, delete store)
	./scripts/verify-e2e.sh

clean: ## Destroy the cluster and local build artefacts
	./scripts/teardown.sh

build: ## Compile backend and frontend locally (no cluster needed)
	cd platform/backend && npm ci && npm run build
	cd platform/frontend && npm ci && npm run build

lint: ## Static checks for charts, TypeScript and shell scripts
	helm lint charts/store -f charts/store/values-local.yaml --set store.id=lint0001 --set store.name=lint
	helm lint charts/store -f charts/store/values-prod.yaml --set store.id=lint0001 --set store.name=lint
	helm lint charts/platform
	cd platform/backend && npm run typecheck
	cd platform/frontend && npm run typecheck
	bash -n scripts/*.sh

status: ## Show platform and store namespaces
	kubectl get pods -n store-platform -o wide
	kubectl get ns -l platform.io/managed=true

logs: ## Tail orchestrator API logs
	kubectl logs -n store-platform deploy/store-platform-api -f
