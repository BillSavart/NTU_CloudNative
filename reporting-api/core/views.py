import json

from django.contrib.auth import authenticate
from django.http import HttpRequest, JsonResponse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST


@require_GET
def health(request: HttpRequest) -> JsonResponse:
    return JsonResponse({"status": "ok", "service": "reporting-api"})


@ensure_csrf_cookie
@require_GET
def csrf_token(request: HttpRequest) -> JsonResponse:
    return JsonResponse({"message": "CSRF cookie set."})


@require_POST
def login_api(request: HttpRequest) -> JsonResponse:
    try:
        payload = json.loads(request.body.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"message": "Invalid JSON payload."}, status=400)

    employee_id = str(payload.get("employeeId", "")).strip()
    password = str(payload.get("password", ""))

    if not employee_id or not password:
        return JsonResponse({"message": "employeeId and password are required."}, status=400)

    user = authenticate(request, username=employee_id, password=password)
    if user is None:
        return JsonResponse({"message": "帳號或密碼錯誤。"}, status=401)

    return JsonResponse(
        {
            "message": "登入成功。",
            "user": {
                "username": user.username,
                "isStaff": user.is_staff,
            },
        }
    )