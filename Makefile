.DEFAULT_GOAL := help

.PHONY: help
help:
	@echo "Usage: make <target>"
	@echo ""
	@echo "Targets:"
	@echo "  install         Install dependencies (backend + frontend)"
	@echo "  clean           Remove build artifacts"
	@echo "  build           Build frontend (Vite)"
	@echo "  start           Install, build, and start server"
	@echo "  dev             Start dev server (hot reload)"
	@echo "  lint            Run Biome linter"
	@echo "  lint_text       Run textlint"
	@echo "  typecheck       Run TypeScript type check"
	@echo "  test            Run tests"
	@echo "  before-commit   Run lint + lint_text + typecheck + test"

.PHONY: install
install:
	bun install
	cd frontend && bun install

.PHONY: install_ci
install_ci:
	bun install --frozen-lockfile

.PHONY: clean
clean:
	bunx rimraf public_dist frontend/dist public

.PHONY: build
build: install
	cd frontend && bun run build

.PHONY: start
start: install build
	mkdir -p data
	bun run start

.PHONY: dev
dev: install build
	mkdir -p data
	bun run dev

.PHONY: lint
lint:
	bun run lint

.PHONY: lint_text
lint_text:
	bun run lint:text

.PHONY: typecheck
typecheck:
	bun run typecheck

.PHONY: test
test:
	bun run test

.PHONY: before-commit
before-commit: lint lint_text typecheck test
