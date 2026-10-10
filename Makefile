.PHONY: up down db psql logs

up: ## Build and start the whole stack
	docker compose up --build

down: ## Stop everything and drop the database volume
	docker compose down -v

db: ## Start only Postgres (to run the API or tests on the host)
	docker compose up -d --wait postgres

psql: ## Open a psql shell on the main database
	docker compose exec postgres psql -U crm -d crm

logs: ## Follow logs of all services
	docker compose logs -f
