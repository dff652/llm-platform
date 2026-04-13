"""User CRUD schemas."""

from datetime import datetime

from pydantic import BaseModel, Field


class UserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=50)
    password: str = Field(min_length=6, max_length=128)
    display_name: str | None = None
    role: str = Field(default="user", pattern=r"^(admin|user)$")


class UserUpdate(BaseModel):
    display_name: str | None = None
    role: str | None = Field(default=None, pattern=r"^(admin|user)$")
    status: str | None = Field(default=None, pattern=r"^(active|disabled)$")


class UserResetPassword(BaseModel):
    new_password: str = Field(min_length=6, max_length=128)


class UserOut(BaseModel):
    id: int
    username: str
    display_name: str | None
    role: str
    status: str
    last_login_at: datetime | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class UserListResponse(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[UserOut]
