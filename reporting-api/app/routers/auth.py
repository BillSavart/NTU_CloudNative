import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user
from app.models import Employee, UserAccount
from app.repositories import TAIPEI
from app.security import (
    REMEMBER_ME_TOKEN_TTL_SECONDS,
    SESSION_COOKIE,
    TOKEN_TTL_SECONDS,
    create_password_reset_token,
    create_session_token,
    hash_password,
    hash_reset_token,
    verify_password,
)
from app.serializers import serialize_user

router = APIRouter()


class LoginRequest(BaseModel):
    employeeId: str
    password: str
    rememberMe: bool = False


class PasswordResetRequest(BaseModel):
    loginId: str
    email: str


class PasswordResetConfirmRequest(BaseModel):
    token: str
    password: str


def _local_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=TAIPEI)
    return value.astimezone(TAIPEI)


@router.get("/csrf/")
def csrf(response: Response) -> dict[str, str]:
    token = secrets.token_urlsafe(24)
    response.set_cookie("csrftoken", token, samesite="lax")
    return {"csrfToken": token}


@router.post("/login/")
def legacy_login(payload: LoginRequest, response: Response, db: Session = Depends(get_db)) -> dict[str, object]:
    return login(payload, response, db)


@router.post("/auth/login")
def login(payload: LoginRequest, response: Response, db: Session = Depends(get_db)) -> dict[str, object]:
    login_id = payload.employeeId.strip()
    user = db.scalar(
        select(UserAccount)
        .outerjoin(Employee, UserAccount.employee_id == Employee.employee_id)
        .where(
            or_(
                UserAccount.username == login_id,
                UserAccount.employee_id == login_id,
                Employee.employee_id == login_id,
            )
        )
    )
    if user is None or not user.is_active or not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid credentials",
        )

    ttl_seconds = REMEMBER_ME_TOKEN_TTL_SECONDS if payload.rememberMe else TOKEN_TTL_SECONDS
    token = create_session_token(user.user_id, ttl_seconds=ttl_seconds)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        max_age=ttl_seconds,
    )
    return {
        "message": "登入成功",
        "token": token,
        "user": serialize_user(db, user),
    }


@router.post("/auth/password-reset/request")
def request_password_reset(payload: PasswordResetRequest, db: Session = Depends(get_db)) -> dict[str, str]:
    login_id = payload.loginId.strip()
    email = payload.email.strip().lower()
    user = db.scalar(
        select(UserAccount)
        .outerjoin(Employee, UserAccount.employee_id == Employee.employee_id)
        .where(
            UserAccount.is_active.is_(True),
            or_(
                UserAccount.username == login_id,
                UserAccount.employee_id == login_id,
                Employee.employee_id == login_id,
            ),
        )
    )
    if user is None:
        return {"message": f"如果登入帳號存在，系統會寄送一次性重設密碼連結到 {email}。"}

    token = create_password_reset_token()
    user.password_reset_token_hash = hash_reset_token(token)
    user.password_reset_expires_at = datetime.now(TAIPEI) + timedelta(minutes=30)
    user.password_reset_used_at = None
    db.commit()
    return {
        "message": f"已寄送一次性重設密碼連結到 {email}，30 分鐘內有效。",
        "resetLink": f"/reset-password?token={token}",
        "sentTo": email,
    }


@router.post("/auth/password-reset/confirm")
def confirm_password_reset(payload: PasswordResetConfirmRequest, db: Session = Depends(get_db)) -> dict[str, str]:
    password = payload.password.strip()
    if len(password) < 6:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="password must be at least 6 characters")

    token_hash = hash_reset_token(payload.token.strip())
    user = db.scalar(select(UserAccount).where(UserAccount.password_reset_token_hash == token_hash))
    now = datetime.now(TAIPEI)
    if (
        user is None
        or not user.is_active
        or user.password_reset_used_at is not None
        or user.password_reset_expires_at is None
        or _local_datetime(user.password_reset_expires_at) < now
    ):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="reset link is invalid or expired")

    user.password_hash = hash_password(password)
    user.password_reset_used_at = now
    user.password_reset_token_hash = None
    user.password_reset_expires_at = None
    db.commit()
    return {"message": "密碼已更新，請使用新密碼登入。"}


@router.get("/auth/me")
def me(
    current_user: UserAccount = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, object]:
    return {"user": serialize_user(db, current_user)}


@router.post("/auth/logout")
def logout(response: Response) -> dict[str, str]:
    response.delete_cookie(SESSION_COOKIE)
    return {"message": "已登出"}
