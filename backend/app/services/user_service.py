"""User management business logic."""

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.models.user import User
from app.schemas.user import UserCreate, UserUpdate


async def create_user(db: AsyncSession, data: UserCreate) -> User:
    user = User(
        username=data.username,
        password_hash=hash_password(data.password),
        display_name=data.display_name or data.username,
        role=data.role,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


async def get_user(db: AsyncSession, user_id: int) -> User | None:
    result = await db.execute(select(User).where(User.id == user_id))
    return result.scalar_one_or_none()


async def get_user_by_username(db: AsyncSession, username: str) -> User | None:
    result = await db.execute(select(User).where(User.username == username))
    return result.scalar_one_or_none()


async def list_users(
    db: AsyncSession,
    page: int = 1,
    page_size: int = 20,
    role: str | None = None,
    keyword: str | None = None,
) -> tuple[list[User], int]:
    query = select(User)
    count_query = select(func.count()).select_from(User)

    if role:
        query = query.where(User.role == role)
        count_query = count_query.where(User.role == role)
    if keyword:
        like = f"%{keyword}%"
        query = query.where(
            (User.username.ilike(like)) | (User.display_name.ilike(like))
        )
        count_query = count_query.where(
            (User.username.ilike(like)) | (User.display_name.ilike(like))
        )

    total_result = await db.execute(count_query)
    total = total_result.scalar() or 0

    query = query.order_by(User.created_at.desc())
    query = query.offset((page - 1) * page_size).limit(page_size)
    result = await db.execute(query)
    users = list(result.scalars().all())

    return users, total


async def update_user(db: AsyncSession, user_id: int, data: UserUpdate) -> User | None:
    user = await get_user(db, user_id)
    if user is None:
        return None

    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(user, key, value)

    await db.commit()
    await db.refresh(user)
    return user


async def reset_password(db: AsyncSession, user_id: int, new_password: str) -> bool:
    user = await get_user(db, user_id)
    if user is None:
        return False

    user.password_hash = hash_password(new_password)
    await db.commit()
    return True


async def delete_user(db: AsyncSession, user_id: int) -> bool:
    user = await get_user(db, user_id)
    if user is None:
        return False

    await db.delete(user)
    await db.commit()
    return True
