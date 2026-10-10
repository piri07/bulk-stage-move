.PHONY: up down db migrate test psql logs

up: ## Build and start the whole stack
	docker compose up --build

down: ## Stop everything and drop the database volume
	docker compose down -v

db: ## Start only Postgres (to run the API or tests on the host)
	docker compose up -d --wait postgres

migrate: ## Apply pending SQL migrations
	docker compose run --rm migrate

test: ## Run the test suite in a container against a throwaway crm_test database
	docker compose run --rm --build test

psql: ## Open a psql shell on the main database
	docker compose exec postgres psql -U crm -d crm

logs: ## Follow logs of all services
	docker compose logs -f
