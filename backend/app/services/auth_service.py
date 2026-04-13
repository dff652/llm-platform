"""Authentication business logic."""

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import create_access_token, hash_password, verify_password
from app.models.user import User


async def authenticate(db: AsyncSession, username: str, password: str) -> User | None:
    """Validate credentials and return user, or None if invalid."""
    result = await db.execute(
        select(User).where(User.username == username, User.status == "active")
    )
    user = result.scalar_one_or_none()
    if user is None or not verify_password(password, user.password_hash):
        return None

    # Update last login time
    user.last_login_at = datetime.now(timezone.utc)
    await db.commit()
    return user


def generate_token(user: User) -> str:
    return create_access_token(user.id, user.username, user.role)


async def change_password(
    db: AsyncSession, user_id: int, old_password: str, new_password: str
) -> bool:
    """Change user's own password. Returns False if old password is wrong."""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(old_password, user.password_hash):
        return False

    user.password_hash = hash_password(new_password)
    await db.commit()
    return True
