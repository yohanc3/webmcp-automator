SHELL := /bin/sh

BROWSER ?= /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
GO_CACHE ?= $(CURDIR)/workspace/.cache/go-build

.PHONY: run test test-server test-node test-extension test-actor test-documentation check

run:
	cd server && GOCACHE="$(GO_CACHE)" go run ./cmd/server

test: test-server test-node test-extension test-actor test-documentation

test-server:
	cd server && GOCACHE="$(GO_CACHE)" go test ./...

test-node:
	node --test \
		extension/actor/bootstrap.test.cjs \
		extension/coordinator/tests/*.test.cjs \
		extension/integration/*.test.cjs \
		extension/source/bootstrap.test.js

test-extension:
	@test -x "$(BROWSER)" || { \
		echo "Chrome or Chromium was not found at $(BROWSER)."; \
		echo "Run make test-extension BROWSER=/path/to/browser to select it."; \
		exit 1; \
	}
	@profile="$$(mktemp -d)"; \
	output_file="$$(mktemp)"; \
	"$(BROWSER)" \
		--headless=new \
		--allow-file-access-from-files \
		--disable-background-networking \
		--disable-gpu \
		--no-first-run \
		--virtual-time-budget=1000 \
		--user-data-dir="$$profile" \
		--dump-dom "file://$(CURDIR)/extension/tests/index.html" \
		> "$$output_file" 2>/dev/null & \
	browser_pid=$$!; \
	attempt=0; \
	while test $$attempt -lt 100 \
		&& ! grep -Eq 'data-status="(passed|failed)"' "$$output_file"; do \
		if ! kill -0 "$$browser_pid" 2>/dev/null; then break; fi; \
		sleep 0.1; \
		attempt=$$((attempt + 1)); \
	done; \
	if kill -0 "$$browser_pid" 2>/dev/null; then kill "$$browser_pid" 2>/dev/null; fi; \
	wait "$$browser_pid" 2>/dev/null || true; \
	rm -rf "$$profile"; \
	if ! grep -q 'data-status="passed"' "$$output_file"; then \
		sed -n '1,200p' "$$output_file"; \
		rm -f "$$output_file"; \
		exit 1; \
	fi; \
	rm -f "$$output_file"; \
	echo "extension tests passed"

test-actor:
	@test -x "$(BROWSER)" || { \
		echo "Chrome or Chromium was not found at $(BROWSER)."; \
		echo "Run make test-actor BROWSER=/path/to/browser to select it."; \
		exit 1; \
	}
	@server_log="$$(mktemp)"; \
	profile="$$(mktemp -d)"; \
	output_file="$$(mktemp)"; \
	WEBMCP_ACTOR_TEST_PORT=0 python3 extension/actor/tests/serve.py > "$$server_log" 2>&1 & \
	server_pid=$$!; \
	attempt=0; \
	while test $$attempt -lt 50 \
		&& ! grep -q '^Actor tests: ' "$$server_log"; do \
		if ! kill -0 "$$server_pid" 2>/dev/null; then break; fi; \
		sleep 0.1; \
		attempt=$$((attempt + 1)); \
	done; \
	if ! kill -0 "$$server_pid" 2>/dev/null; then \
		cat "$$server_log"; \
		rm -rf "$$profile"; \
		rm -f "$$output_file" "$$server_log"; \
		exit 1; \
	fi; \
	actor_url="$$(sed -n 's/^Actor tests: //p' "$$server_log" | head -1)"; \
	if ! curl --silent --fail "$$actor_url" >/dev/null; then \
		cat "$$server_log"; \
		kill "$$server_pid" 2>/dev/null || true; \
		rm -rf "$$profile"; \
		rm -f "$$output_file" "$$server_log"; \
		exit 1; \
	fi; \
	"$(BROWSER)" \
		--headless=new \
		--disable-background-networking \
		--disable-gpu \
		--no-first-run \
		--virtual-time-budget=60000 \
		--user-data-dir="$$profile" \
		--dump-dom "$$actor_url" \
		> "$$output_file" 2>/dev/null & \
	browser_pid=$$!; \
	attempt=0; \
	while test $$attempt -lt 100 \
		&& ! grep -Eq 'data-status="(passed|failed)"' "$$output_file"; do \
		if ! kill -0 "$$browser_pid" 2>/dev/null; then break; fi; \
		sleep 0.1; \
		attempt=$$((attempt + 1)); \
	done; \
	if kill -0 "$$browser_pid" 2>/dev/null; then kill "$$browser_pid" 2>/dev/null; fi; \
	wait "$$browser_pid" 2>/dev/null || true; \
	kill "$$server_pid" 2>/dev/null || true; \
	wait "$$server_pid" 2>/dev/null || true; \
	rm -rf "$$profile"; \
	if ! grep -q 'data-status="passed"' "$$output_file"; then \
		sed -n '1,240p' "$$output_file"; \
		cat "$$server_log"; \
		rm -f "$$output_file" "$$server_log"; \
		exit 1; \
	fi; \
	rm -f "$$output_file" "$$server_log"; \
	echo "actor tests passed"

test-documentation:
	@while IFS= read -r path; do \
		test -e "$$path" || { echo "missing documented path: $$path"; exit 1; }; \
	done < documentation/tests/required-paths.txt
	@echo "documentation tests passed"

check: test
	cd server && GOCACHE="$(GO_CACHE)" go vet ./...
