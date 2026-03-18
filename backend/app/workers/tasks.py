from app.workers.celery_app import celery_app
from app.core.supabase import get_supabase
from app.services.ai_pipeline import run_analysis_pipeline
import logging

logger = logging.getLogger(__name__)


@celery_app.task(bind=True, max_retries=3)
def analyze_blueprint(self, blueprint_id: str):
    """Main analysis task — runs the full AI pipeline on a blueprint."""
    db = get_supabase()
    try:
        # Mark as processing
        db.table("blueprints").update({"status": "processing"}).eq("id", blueprint_id).execute()

        # Run full pipeline
        result = run_analysis_pipeline(blueprint_id)

        # Mark complete
        db.table("blueprints").update({"status": "complete"}).eq("id", blueprint_id).execute()

        return {"blueprint_id": blueprint_id, "analysis_id": result["analysis_id"]}

    except Exception as exc:
        logger.error(f"Analysis failed for blueprint {blueprint_id}: {exc}")
        db.table("blueprints").update({"status": "failed"}).eq("id", blueprint_id).execute()
        raise self.retry(exc=exc, countdown=60)
