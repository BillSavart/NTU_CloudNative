import json
import os
from pathlib import Path

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Seed baseline data for local and team environments."

    def add_arguments(self, parser):
        parser.add_argument(
            "--fixture",
            default="core/fixtures/initial_seed.json",
            help="Path to the seed fixture JSON file.",
        )
        parser.add_argument(
            "--create-admin",
            action="store_true",
            help="Create or update a superuser from fixture defaults.",
        )
        parser.add_argument(
            "--admin-password",
            default=os.getenv("SEED_ADMIN_PASSWORD", ""),
            help="Password for the seeded admin user.",
        )

    def handle(self, *args, **options):
        fixture_path = Path(options["fixture"])
        if not fixture_path.is_absolute():
            fixture_path = Path.cwd() / fixture_path

        if not fixture_path.exists():
            raise CommandError(f"Seed fixture not found: {fixture_path}")

        try:
            seed_payload = json.loads(fixture_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            raise CommandError(f"Invalid JSON in seed fixture: {error}") from error

        groups = seed_payload.get("groups", [])
        for group_name in groups:
            _, created = Group.objects.get_or_create(name=group_name)
            state = "created" if created else "exists"
            self.stdout.write(self.style.SUCCESS(f"Group {group_name}: {state}"))

        if options["create_admin"]:
            self._create_or_update_admin(seed_payload, options["admin_password"])
        else:
            self.stdout.write("Skip admin creation. Use --create-admin to enable it.")

        self.stdout.write(self.style.SUCCESS("Seed completed."))

    def _create_or_update_admin(self, seed_payload, admin_password):
        default_superuser = seed_payload.get("default_superuser")
        if not default_superuser:
            raise CommandError("default_superuser is missing in seed fixture.")

        if not admin_password:
            raise CommandError(
                "--admin-password is required when --create-admin is used. "
                "You can also set SEED_ADMIN_PASSWORD."
            )

        username = str(default_superuser.get("username", "")).strip()
        if not username:
            raise CommandError("default_superuser.username cannot be empty.")

        User = get_user_model()
        defaults = {
            "email": str(default_superuser.get("email", "")).strip(),
            "is_staff": bool(default_superuser.get("is_staff", True)),
            "is_superuser": bool(default_superuser.get("is_superuser", True)),
            "is_active": True,
        }

        user, created = User.objects.get_or_create(username=username, defaults=defaults)

        if not created:
            user.email = defaults["email"]
            user.is_staff = defaults["is_staff"]
            user.is_superuser = defaults["is_superuser"]
            user.is_active = defaults["is_active"]

        user.set_password(admin_password)
        user.save()

        state = "created" if created else "updated"
        self.stdout.write(self.style.SUCCESS(f"Admin user {username}: {state}"))
