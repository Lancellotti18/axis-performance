.PHONY: dev install build clean

dev:
	docker compose up --build

dev-frontend:
	cd frontend && npm run dev

dev-backend:
	cd backend && uvicorn app.main:app --reload --port 8000

dev-worker:
	cd backend && celery -A app.workers.celery_app worker --loglevel=info

install-frontend:
	cd frontend && npm install

install-backend:
	cd backend && pip install -r requirements.txt

build:
	docker compose -f docker-compose.prod.yml build

clean:
	docker compose down -v
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete 2>/dev/null || true
