.PHONY: help up down db migrate seed seed-full test bench bench-kill-resume psql logs

help: ## List the targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'

up: ## Build and start the whole stack
	docker compose up --build

down: ## Stop everything and drop the database volume
	docker compose down -v

db: ## Start only Postgres (to run the API or tests on the host)
	docker compose up -d --wait postgres

migrate: ## Apply pending SQL migrations
	docker compose run --rm migrate

seed: ## Seed the small dataset (skips workspaces that already exist)
	docker compose run --rm seed

seed-full: ## Wipe and seed the full dataset: 500k deals + 5 small workspaces
	docker compose run --rm seed node dist/scripts/seed.js --full --reset

test: ## Run the test suite in a container against a throwaway crm_test database
	docker compose run --rm --build test

bench: ## Every benchmark, each from a fresh seed (~6 min); raw output to bench/results/
	./scripts/bench.sh

bench-kill-resume: ## Kill the worker at 30,000 of 50,000, resume, and prove the result
	./scripts/bench-kill-resume.sh

psql: ## Open a psql shell on the main database
	docker compose exec postgres psql -U crm -d crm

logs: ## Follow logs of all services
	docker compose logs -f
