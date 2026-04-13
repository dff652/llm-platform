"""Model entity business logic."""

from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.model_entity import ModelEntity
from app.schemas.model_entity import ModelCreate, ModelUpdate


class ModelService:

    @staticmethod
    async def create(db: AsyncSession, data: ModelCreate) -> ModelEntity:
        model = ModelEntity(**data.model_dump())
        db.add(model)
        await db.flush()
        await db.refresh(model)
        return model

    @staticmethod
    async def get(db: AsyncSession, model_id: int) -> ModelEntity | None:
        return await db.get(ModelEntity, model_id)

    @staticmethod
    async def list_models(
        db: AsyncSession,
        page: int = 1,
        page_size: int = 20,
        family: str | None = None,
        status: str | None = None,
    ) -> tuple[list[ModelEntity], int]:
        query = select(ModelEntity)
        count_query = select(sa_func.count(ModelEntity.id))

        if family:
            query = query.where(ModelEntity.family == family)
            count_query = count_query.where(ModelEntity.family == family)
        if status:
            query = query.where(ModelEntity.status == status)
            count_query = count_query.where(ModelEntity.status == status)

        total = (await db.execute(count_query)).scalar() or 0
        offset = (page - 1) * page_size
        query = query.order_by(ModelEntity.updated_at.desc()).offset(offset).limit(page_size)
        result = await db.execute(query)
        return list(result.scalars().all()), total

    @staticmethod
    async def update(db: AsyncSession, model_id: int, data: ModelUpdate) -> ModelEntity | None:
        model = await db.get(ModelEntity, model_id)
        if not model:
            return None
        for key, value in data.model_dump(exclude_unset=True).items():
            setattr(model, key, value)
        await db.flush()
        await db.refresh(model)
        return model

    @staticmethod
    async def set_status(db: AsyncSession, model_id: int, status: str) -> ModelEntity | None:
        model = await db.get(ModelEntity, model_id)
        if not model:
            return None
        model.status = status
        await db.flush()
        await db.refresh(model)
        return model
