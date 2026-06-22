SHELL := /bin/bash

.DEFAULT_GOAL := help

.PHONY: help check restore mcp plugins settings status

help: ## Show available targets
	@grep -E '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'

check: ## Verify claude CLI is present
	@./restore.sh check

mcp: ## Recreate mcp-proxy (user scope)
	@./restore.sh mcp

plugins: ## Add marketplaces + install/enable plugins
	@./restore.sh plugins

settings: ## Merge portable settings.json
	@./restore.sh settings

restore: ## mcp-proxy + plugins + settings, then show status
	@./restore.sh all

status: ## Show current MCP servers and plugins
	@./restore.sh status
