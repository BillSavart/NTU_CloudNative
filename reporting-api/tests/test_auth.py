import unittest

from fastapi import HTTPException, Response
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.dependencies import get_current_user
from app.models import Base, Employee, UserAccount
from app.routers.auth import LoginRequest, login
from app.security import SESSION_COOKIE, hash_password


class AuthTestCase(unittest.TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:")
        Base.metadata.create_all(engine)
        self.SessionLocal = sessionmaker(bind=engine)
        with self.SessionLocal() as db:
            db.add(Employee(employee_id="MGR001", display_name="Manager", last_known_state="UNKNOWN"))
            db.add(
                UserAccount(
                    user_id=1,
                    username="manager",
                    role="MANAGER",
                    employee_id="MGR001",
                    password_hash=hash_password("demo123", salt=b"0123456789abcdef"),
                    is_active=True,
                )
            )
            db.add(
                UserAccount(
                    user_id=2,
                    username="inactive",
                    role="EMPLOYEE",
                    password_hash=hash_password("demo123", salt=b"abcdef0123456789"),
                    is_active=False,
                )
            )
            db.commit()

    def test_login_success_returns_token_cookie_and_user(self) -> None:
        with self.SessionLocal() as db:
            response = Response()
            body = login(LoginRequest(employeeId="manager", password="demo123"), response, db)

        self.assertEqual(body["message"], "登入成功")
        self.assertIn("token", body)
        self.assertEqual(body["user"]["username"], "manager")
        self.assertIn(SESSION_COOKIE, response.headers["set-cookie"])

    def test_login_rejects_wrong_password_and_inactive_user(self) -> None:
        with self.SessionLocal() as db:
            with self.assertRaises(HTTPException) as wrong_password:
                login(LoginRequest(employeeId="manager", password="wrong"), Response(), db)
            with self.assertRaises(HTTPException) as inactive_user:
                login(LoginRequest(employeeId="inactive", password="demo123"), Response(), db)

        self.assertEqual(wrong_password.exception.status_code, 401)
        self.assertEqual(inactive_user.exception.status_code, 401)

    def test_get_current_user_requires_valid_token(self) -> None:
        with self.SessionLocal() as db:
            with self.assertRaises(HTTPException) as missing_token:
                get_current_user(db=db, session_cookie=None, authorization=None)
            with self.assertRaises(HTTPException) as bad_token:
                get_current_user(db=db, session_cookie="tampered", authorization=None)

        self.assertEqual(missing_token.exception.status_code, 401)
        self.assertEqual(bad_token.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
