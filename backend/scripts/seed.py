"""Seed script: create initial admin user and API keys.

Usage:
    cd backend
    python3 scripts/seed.py
"""

import asyncio
import json
import os
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.database import async_session, Base, engine  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.models.user import User  # noqa: E402
import app.models  # noqa: E402, F401
from sqlalchemy import select  # noqa: E402

ADMIN_USERNAME = os.environ.get("SEED_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD = os.environ.get("SEED_ADMIN_PASSWORD", "admin123")
SEED_API_KEY_COUNT = int(os.environ.get("SEED_API_KEY_COUNT", "3"))


async def seed():
    # Create all tables
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async with async_session() as db:
        # Seed admin user
        result = await db.execute(
            select(User).where(User.username == ADMIN_USERNAME)
        )
        existing = result.scalar_one_or_none()

        if existing:
            print(f"Admin user '{ADMIN_USERNAME}' already exists (id={existing.id})")
        else:
            admin = User(
                username=ADMIN_USERNAME,
                password_hash=hash_password(ADMIN_PASSWORD),
                display_name="Admin",
                role="admin",
                status="active",
            )
            db.add(admin)
            print(f"Created admin user: {ADMIN_USERNAME} / {ADMIN_PASSWORD}")
            print("!! Please change the default password after first login !!")

        await db.commit()

    # Generate API keys
    await seed_api_keys()


async def seed_api_keys():
    """Generate API keys for external system integration."""
    import bcrypt
    from app.models.api_key import ApiKey

    api_keys_file = Path(__file__).resolve().parent.parent / "data" / "api_keys.json"

    async with async_session() as db:
        result = await db.execute(select(ApiKey))
        existing = result.scalars().all()
        if existing:
            print(f"API keys already exist ({len(existing)} keys), skipping")
            return

        result = await db.execute(select(User).where(User.username == ADMIN_USERNAME))
        admin = result.scalar_one_or_none()
        if not admin:
            print("Admin user not found, skipping API key generation")
            return

        generated_keys = []
        for i in range(SEED_API_KEY_COUNT):
            raw_key = f"ak-{secrets.token_hex(16)}"
            prefix = raw_key[:10]
            key_hash = bcrypt.hashpw(raw_key.encode(), bcrypt.gensalt()).decode()

            api_key = ApiKey(
                name=f"default-key-{i+1:02d}",
                key_prefix=prefix,
                key_hash=key_hash,
                user_id=admin.id,
                is_active=True,
            )
            db.add(api_key)
            generated_keys.append({
                "name": api_key.name,
                "key": raw_key,
                "prefix": prefix,
            })

        await db.commit()

    api_keys_file.parent.mkdir(parents=True, exist_ok=True)
    with open(api_keys_file, "w") as f:
        json.dump(generated_keys, f, indent=2, ensure_ascii=False)

    print(f"\nGenerated {len(generated_keys)} API keys:")
    for k in generated_keys:
        print(f"  {k['name']}: {k['key']}")
    print(f"\nFull list saved to: {api_keys_file}")


if __name__ == "__main__":
    asyncio.run(seed())
