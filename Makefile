# pi-dmail release automation.
#
# Typical flow:   make release PATCH=patch
# Or stepwise:    make test && make dry-run && make bump PATCH=patch && make publish
#
# Publishing needs a granular access token with "bypass 2FA" (read+write on
# pi-dmail). Pass it via the environment so it never lands in a file at rest:
#
#   NPM_TOKEN=npm_xxx make publish
#
# If NPM_TOKEN is unset, publish falls back to your ~/.npmrc login — which
# works only if npm accepts it (2FA/OTP may still be required).

SHELL := /bin/bash

PKG   := pi-dmail
PATCH ?= patch                       # patch | minor | major (or an explicit x.y.z)

# Publish uses an ephemeral npm config carrying the token; removed after use.
.PHONY: publish
publish:
	@TMPCFG=$$(mktemp); trap 'rm -f "$$TMPCFG"' EXIT; \
	if [ -n "$$NPM_TOKEN" ]; then \
		printf '//registry.npmjs.org/:_authToken=%s\n' "$$NPM_TOKEN" > "$$TMPCFG"; \
		echo "publishing $(PKG) with NPM_TOKEN (ephemeral config)..."; \
		npm publish --userconfig "$$TMPCFG"; \
	else \
		echo "NPM_TOKEN unset — publishing with ~/.npmrc login..."; \
		npm publish; \
	fi

.PHONY: bump
bump:
	npm version $(PATCH)

.PHONY: dry-run
dry-run:
	npm pack --dry-run

.PHONY: test
test:
	npm test

# Bump, verify the tarball, test, then publish — in that order.
.PHONY: release
release: bump dry-run test publish
	@echo "released $(shell node -p "require('./package.json').version") → https://www.npmjs.com/package/$(PKG)"

.PHONY: status
status:
	@npm view $(PKG) name version time.modified dist.tarball 2>/dev/null || echo "$(PKG) not on npm yet"

.PHONY: clean
clean:
	rm -f $(PKG)-*.tgz

.DEFAULT_GOAL := dry-run
