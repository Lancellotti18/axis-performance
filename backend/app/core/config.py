from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    ENVIRONMENT: str = "development"
    SECRET_KEY: str = "changeme-min-32-chars-secret-key"
    ALLOWED_ORIGINS: str = "http://localhost:3000"

    SUPABASE_URL: str = ""
    SUPABASE_SERVICE_ROLE_KEY: str = ""

    REDIS_URL: str = "redis://redis:6379/0"

    S3_BUCKET_NAME: str = "buildai-blueprints"
    S3_REGION: str = "auto"
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    S3_ENDPOINT_URL: str = ""

    ANTHROPIC_API_KEY: str = ""
    TAVILY_API_KEY: str = ""
    GOOGLE_SOLAR_API_KEY: str = ""
    STRIPE_SECRET_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""

    @property
    def allowed_origins_list(self) -> list[str]:
        return [o.strip() for o in self.ALLOWED_ORIGINS.split(",") if o.strip()]

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
