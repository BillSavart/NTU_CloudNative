from django.contrib import admin
from django.contrib.admin.sites import NotRegistered
from django.contrib.auth.admin import UserAdmin
from django.contrib.auth.models import User


class CustomUserAdmin(UserAdmin):
    list_display = (
        "username",
        "email",
        "first_name",
        "last_name",
        "is_staff",
        "is_superuser",
        "is_active",
        "last_login",
        "date_joined",
    )
    list_filter = ("is_staff", "is_superuser", "is_active", "groups")
    search_fields = ("username", "email", "first_name", "last_name")
    ordering = ("-date_joined",)


try:
    admin.site.unregister(User)
except NotRegistered:
    pass

admin.site.register(User, CustomUserAdmin)

admin.site.site_header = "出勤管理系統後台"
admin.site.site_title = "Attendance Admin"
admin.site.index_title = "系統管理"
