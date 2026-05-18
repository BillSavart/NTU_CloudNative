import secrets

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user
from app.models import Employee, UserAccount
from app.security import SESSION_COOKIE, create_session_token, verify_password
from app.serializers import serialize_user

router = APIRouter()


class LoginRequest(BaseModel):
    employeeId: str
    password: str


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

    token = create_session_token(user.user_id)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        samesite="lax",
        max_age=60 * 60 * 8,
    )
    return {
        "message": "登入成功",
        "token": token,
        "user": serialize_user(db, user),
    }


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
