.PHONY: install
install:
	bun install

.PHONY: install_ci
install_ci:
	bun install --frozen-lockfile

.PHONY: start
start: install
	mkdir -p data
	bun run start

.PHONY: dev
dev: install
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
