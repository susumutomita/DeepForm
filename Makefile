.PHONY: install
install:
	npm install

.PHONY: install_ci
install_ci:
	npm ci

.PHONY: start
start: install
	mkdir -p data
	npx tsx src/index.ts

.PHONY: dev
dev: install
	mkdir -p data
	npx tsx --watch src/index.ts

.PHONY: lint
lint:
	npx biome check src/

.PHONY: lint_text
lint_text:
	npx textlint README.md README.ja.md || true

.PHONY: typecheck
typecheck:
	npx tsc --noEmit

.PHONY: test
test:
	npx vitest run

.PHONY: build
build:
	cd frontend && npx vite build

.PHONY: before-commit
before-commit: lint typecheck test build
