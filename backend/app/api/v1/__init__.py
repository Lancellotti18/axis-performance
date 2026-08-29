from fastapi import APIRouter
from app.api.v1 import projects, blueprints, analyses, estimates, reports, compliance, materials, permits, contractor_profile, roofing, roofing_v2, exterior, training, crm, photos, model3d, axis, proposals, material_check, visualizer, renders, chat, instant_quote, roof_proposals, client_portal, appointments, notifications, prospecting, project_photos, scheduling, briefing

router = APIRouter()

# billing.py is deliberately NOT mounted. It was unfinished scaffolding that no
# frontend code called, and POST /billing/portal took a Stripe customer_id with
# no auth at all — anyone could mint a billing-portal URL for any customer. Its
# price IDs are also placeholders and its redirect URLs point at localhost, so
# there was nothing working to preserve. Re-mount it only once it has auth, real
# STRIPE_PRICE_* config, and a signature-verified webhook.

router.include_router(projects.router, prefix="/projects", tags=["projects"])
router.include_router(blueprints.router, prefix="/blueprints", tags=["blueprints"])
router.include_router(analyses.router, prefix="/analyses", tags=["analyses"])
router.include_router(estimates.router, prefix="/estimates", tags=["estimates"])
router.include_router(reports.router, prefix="/reports", tags=["reports"])
router.include_router(compliance.router, prefix="/compliance", tags=["compliance"])
router.include_router(materials.router, prefix="/materials", tags=["materials"])
router.include_router(permits.router, prefix="/permits", tags=["permits"])
router.include_router(contractor_profile.router, prefix="/contractor-profile", tags=["contractor-profile"])
router.include_router(roofing.router, prefix="/roofing", tags=["roofing"])
router.include_router(roofing_v2.router, prefix="/roofing/v2", tags=["roofing-v2"])
router.include_router(exterior.router, prefix="/exterior/v1", tags=["exterior"])
router.include_router(training.router, prefix="/training", tags=["training-data"])
router.include_router(crm.router, prefix="/crm", tags=["crm"])
router.include_router(photos.router, prefix="/photos", tags=["photos"])
router.include_router(model3d.router, prefix="/model3d", tags=["model3d"])
router.include_router(axis.router, prefix="/axis", tags=["axis"])
router.include_router(proposals.router, prefix="/proposals", tags=["proposals"])
router.include_router(material_check.router, prefix="/material-check", tags=["material-check"])
router.include_router(visualizer.router, prefix="/visualizer", tags=["visualizer"])
router.include_router(renders.router, prefix="/renders", tags=["renders"])
router.include_router(chat.router, prefix="/chat", tags=["chat"])
router.include_router(instant_quote.router, prefix="/instant-quote", tags=["instant-quote"])
router.include_router(roof_proposals.router, prefix="/roof-proposals", tags=["roof-proposals"])
router.include_router(client_portal.router, prefix="/client-portal", tags=["client-portal"])
router.include_router(appointments.router, prefix="/appointments", tags=["appointments"])
router.include_router(notifications.router, prefix="/notifications", tags=["notifications"])
router.include_router(prospecting.router, prefix="/prospecting", tags=["prospecting"])
router.include_router(project_photos.router, prefix="/project-photos", tags=["project-photos"])
router.include_router(briefing.router, prefix="/briefing", tags=["briefing"])
router.include_router(scheduling.router, prefix="/scheduling", tags=["scheduling"])
