from sqlalchemy import select

from app.database import SessionLocal
from app.models import UserAccount
from app.security import hash_password


def create_admin():
    with SessionLocal() as db:
        user = db.scalar(select(UserAccount).where(UserAccount.username == "admin"))
        if user is None:
            user = UserAccount(username="admin")
            db.add(user)
            db.flush()

        user.password_hash = hash_password("admin")
        user.is_active = True
        user.role = "ADMIN"
        db.commit()

    print("Created/updated admin user 'admin' with password 'admin'")


if __name__ == "__main__":
    create_admin()
