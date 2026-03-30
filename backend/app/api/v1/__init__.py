from fastapi import APIRouter
from app.api.v1 import projects, blueprints, analyses, estimates, reports, billing, compliance, materials, permits, contractor_profile, roofing, crm, photos

router = APIRouter()

router.include_router(projects.router, prefix="/projects", tags=["projects"])
router.include_router(blueprints.router, prefix="/blueprints", tags=["blueprints"])
router.include_router(analyses.router, prefix="/analyses", tags=["analyses"])
router.include_router(estimates.router, prefix="/estimates", tags=["estimates"])
router.include_router(reports.router, prefix="/reports", tags=["reports"])
router.include_router(billing.router, prefix="/billing", tags=["billing"])
router.include_router(compliance.router, prefix="/compliance", tags=["compliance"])
router.include_router(materials.router, prefix="/materials", tags=["materials"])
router.include_router(permits.router, prefix="/permits", tags=["permits"])
router.include_router(contractor_profile.router, prefix="/contractor-profile", tags=["contractor-profile"])
router.include_router(roofing.router, prefix="/roofing", tags=["roofing"])
router.include_router(crm.router, prefix="/crm", tags=["crm"])
router.include_router(photos.router, prefix="/photos", tags=["photos"])
