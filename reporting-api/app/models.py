from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


sqlite_autoincrement_id = BigInteger().with_variant(Integer, "sqlite")


class Department(Base):
    __tablename__ = "departments"

    department_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    parent_department_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("departments.department_id"),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    parent: Mapped["Department | None"] = relationship(
        "Department",
        remote_side=[department_id],
    )


class Employee(Base):
    __tablename__ = "employees"

    employee_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    display_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    department_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("departments.department_id"),
        nullable=True,
        index=True,
    )
    manager_employee_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("employees.employee_id"),
        nullable=True,
        index=True,
    )
    last_known_state: Mapped[str] = mapped_column(String(16), default="UNKNOWN", nullable=False)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    department: Mapped[Department | None] = relationship("Department")
    manager: Mapped["Employee | None"] = relationship(
        "Employee",
        remote_side=[employee_id],
    )

    __table_args__ = (
        CheckConstraint(
            "last_known_state in ('UNKNOWN', 'IN', 'OUT')",
            name="ck_employees_last_known_state",
        ),
    )


class UserAccount(Base):
    __tablename__ = "user_accounts"

    user_id: Mapped[int] = mapped_column(sqlite_autoincrement_id, primary_key=True, autoincrement=True)
    username: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    password_reset_token_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    password_reset_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    password_reset_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="EMPLOYEE")
    employee_id: Mapped[str | None] = mapped_column(
        String(64),
        ForeignKey("employees.employee_id"),
        nullable=True,
        unique=True,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    employee: Mapped[Employee | None] = relationship("Employee")
    department_scopes: Mapped[list["UserDepartmentScope"]] = relationship(
        "UserDepartmentScope",
        back_populates="user",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        CheckConstraint(
            "role in ('EMPLOYEE', 'MANAGER', 'EXECUTIVE', 'ADMIN')",
            name="ck_user_accounts_role",
        ),
    )


class UserDepartmentScope(Base):
    __tablename__ = "user_department_scopes"

    id: Mapped[int] = mapped_column(sqlite_autoincrement_id, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        sqlite_autoincrement_id,
        ForeignKey("user_accounts.user_id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    department_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("departments.department_id"),
        nullable=False,
        index=True,
    )
    include_descendants: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    user: Mapped[UserAccount] = relationship("UserAccount", back_populates="department_scopes")
    department: Mapped[Department] = relationship("Department")

    __table_args__ = (
        UniqueConstraint("user_id", "department_id", name="uq_user_department_scopes_user_department"),
    )


class AccessEvent(Base):
    __tablename__ = "access_events"

    id: Mapped[int] = mapped_column(sqlite_autoincrement_id, primary_key=True, autoincrement=True)
    request_id: Mapped[str] = mapped_column(String(128), nullable=False)
    employee_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("employees.employee_id"),
        nullable=False,
        index=True,
    )
    gate_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    direction: Mapped[str] = mapped_column(String(8), nullable=False)
    decision: Mapped[str] = mapped_column(String(16), nullable=False)
    reason: Mapped[str] = mapped_column(String(64), nullable=False)
    previous_state: Mapped[str] = mapped_column(String(16), nullable=False)
    current_state: Mapped[str] = mapped_column(String(16), nullable=False)
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    remark: Mapped[str | None] = mapped_column(Text, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    employee: Mapped[Employee] = relationship("Employee")

    __table_args__ = (
        UniqueConstraint("request_id", name="uq_access_events_request_id"),
        CheckConstraint("direction in ('IN', 'OUT')", name="ck_access_events_direction"),
        CheckConstraint("decision in ('GRANTED', 'DENIED')", name="ck_access_events_decision"),
        CheckConstraint(
            "previous_state in ('UNKNOWN', 'IN', 'OUT')",
            name="ck_access_events_previous_state",
        ),
        CheckConstraint(
            "current_state in ('UNKNOWN', 'IN', 'OUT')",
            name="ck_access_events_current_state",
        ),
        Index("ix_access_events_occurred_at", "occurred_at"),
        Index("ix_access_events_employee_occurred", "employee_id", "occurred_at"),
        Index("ix_access_events_decision_occurred", "decision", "occurred_at"),
    )
