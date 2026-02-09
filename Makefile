.PHONY: install
install:
	bun install

.PHONY: install_ci
install_ci:
	bun install --frozen-lockfile

.PHONY: typecheck
typecheck:
	bun run typecheck

.PHONY: lint_text
lint_text:
	bun run lint:text

.PHONY: before-commit
before-commit: lint_text typecheck
