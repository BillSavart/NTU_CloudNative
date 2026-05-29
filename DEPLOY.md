# Deployment (GCP single VM, Docker Compose + HTTPS)

Target: one **n4-standard-4** (4 vCPU / 16 GB) running the full stack via Docker
Compose, fronted by Caddy for automatic HTTPS on `tsmc-dpac.systems`.

- **CI** (`.github/workflows/ci.yml`) tests every push/PR.
- **CD** (`.github/workflows/cd.yml`) — after CI succeeds on `main` — builds the
  four app images, pushes them to GHCR, then SSHes into the VM and redeploys.

```
push/merge to main ─▶ CI ─success─▶ CD
                                     ├─ build & push 4 images → ghcr.io/billsavart/ntu_cloudnative/*
                                     └─ ssh VM → scripts/deploy.sh (git pull, compose pull, up -d)
```

App images come from GHCR; infra images (Postgres / Redis / Kafka / Prometheus /
Grafana / Loki / Tempo / Alloy / Caddy) are pulled from upstream by compose.
Bind-mounted config comes from the git checkout on the VM — that's why
`deploy.sh` runs `git reset --hard origin/main` first.

## Compose layers

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | base (local dev: builds images, exposes all ports) |
| `docker-compose.prod.yml` | prod override: GHCR images, `restart: unless-stopped`, internal services bound to `127.0.0.1`, debug off, Kafka heap capped |
| `docker-compose.https.yml` | Caddy TLS edge; removes public ports from frontend/simulator/grafana/prometheus so Caddy is the only entry. Added automatically when `ENABLE_HTTPS=true`. |

Public surface once deployed (only Caddy holds host ports — 80/443):

| URL | Service | Auth |
| --- | --- | --- |
| `tsmc-dpac.systems` | frontend app | app login |
| `sim.tsmc-dpac.systems` | swipe-card demo | none |
| `grafana.tsmc-dpac.systems` | Grafana | Grafana login (`GRAFANA_ADMIN_*`) |
| `prometheus.tsmc-dpac.systems` | Prometheus | Caddy basic auth (`PROM_USER`/`PROM_HASH`) |

> ⚠️ **Ordering:** finish Phase 0 (secrets + VM + DNS) **before** you merge.
> Merging triggers CD immediately; if the VM/secrets/DNS aren't ready that run
> fails (the code is fine, you just re-run CD later).

---

## Phase 0 — one-time prep (before merging)

### 0-1. GCP: static IP + firewall
HTTPS needs a stable IP (DNS + certs break if it changes on stop/start).
```bash
gcloud compute addresses create tsmc-dpac-ip \
  --addresses <CURRENT_VM_EXTERNAL_IP> --region <REGION>
gcloud compute firewall-rules create allow-web --allow tcp:80,tcp:443 --network default
```
Do **not** open 3000/9090/5432/6379/9092 — those are internal / behind Caddy.

### 0-2. DNS (name.com): four A records → the static IP
| Type | Host | Value |
| --- | --- | --- |
| A | `@` | `<STATIC_IP>` |
| A | `sim` | `<STATIC_IP>` |
| A | `grafana` | `<STATIC_IP>` |
| A | `prometheus` | `<STATIC_IP>` |

Verify they resolve before deploying:
```bash
dig +short tsmc-dpac.systems sim.tsmc-dpac.systems grafana.tsmc-dpac.systems prometheus.tsmc-dpac.systems
```

### 0-3. VM: install Docker / Compose / git
```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker "$USER"     # then log out + back in
docker compose version              # must be >= 2.24.4 (for !override / !reset)
```

### 0-4. VM: clone the repo
```bash
cd ~ && git clone https://github.com/BillSavart/NTU_CloudNative.git
cd NTU_CloudNative && pwd            # this path is DEPLOY_PATH, e.g. /home/<user>/NTU_CloudNative
```

### 0-5. VM: generate the Prometheus basic-auth hash
```bash
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'YOUR_PROM_PASSWORD'
# copy the $2a$14$.... output
```

### 0-6. VM: create the production `.env`
```bash
cp .env.example .env && nano .env
```
Set strong, unique secrets (do **not** keep `imlab306`):
```bash
POSTGRES_PASSWORD=<strong>
REDIS_PASSWORD=<strong>
GRAFANA_ADMIN_PASSWORD=<strong>
DEMO_SEED_PASSWORD=<demo login password>
APP_SECRET_KEY=<openssl rand -hex 32>

ENABLE_HTTPS=true
DOMAIN=tsmc-dpac.systems
SIMULATOR_DOMAIN=sim.tsmc-dpac.systems
GRAFANA_DOMAIN=grafana.tsmc-dpac.systems
PROMETHEUS_DOMAIN=prometheus.tsmc-dpac.systems
PROM_USER=admin
PROM_HASH='$2a$14$....'              # single-quote it: bcrypt hashes contain $
APP_COOKIE_SECURE=true
CORS_ORIGINS=https://tsmc-dpac.systems
```
> `.env` is gitignored; `deploy.sh`'s `git reset --hard` won't touch it.

### 0-7. VM: add 4 GB swap (avoids OOM on 16 GB)
```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### 0-8. CD SSH key (run on your laptop)
```bash
ssh-keygen -t ed25519 -C "github-actions-cd" -f ~/cd_deploy_key -N ""
ssh-copy-id -i ~/cd_deploy_key.pub <DEPLOY_USER>@<STATIC_IP>
ssh -i ~/cd_deploy_key <DEPLOY_USER>@<STATIC_IP> "docker ps && echo OK"
```
> If the key gets wiped, your VM has GCP OS Login on — add the key via instance
> metadata, or disable OS Login on that VM.

### 0-9. GitHub: GHCR pull token
Settings → Developer settings → Personal access tokens → **Tokens (classic)** →
Generate, scope **`read:packages`** → copy it.

### 0-10. GitHub: repo Actions secrets
Repo → Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | static IP (or `tsmc-dpac.systems`) |
| `DEPLOY_USER` | SSH user (in the `docker` group) |
| `DEPLOY_SSH_KEY` | full contents of `~/cd_deploy_key` (private key) |
| `DEPLOY_PATH` | repo path from 0-4 |
| `DEPLOY_GHCR_TOKEN` | the `read:packages` PAT from 0-9 |

---

## Phase 1 — merge → automatic deploy

1. Merge the PR into `main`.
2. **Actions** tab: CI runs, then CD (`build-push` → `deploy`) runs on success.
   `deploy.sh` sees `ENABLE_HTTPS=true` and brings up the Caddy edge; Caddy then
   fetches the four Let's Encrypt certs automatically.
3. Seed demo users/data once:
   ```bash
   cd ~/NTU_CloudNative
   docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.https.yml \
     exec -T reporting-api python -m app.seed
   ```
   (reporting-api auto-runs Alembic migrations on startup — no manual migrate.)

Manual deploy any time: **Actions → CD → Run workflow**.

---

## Phase 2 — verify

```bash
cd ~/NTU_CloudNative
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.https.yml"
$COMPOSE ps                       # all running
$COMPOSE logs caddy | grep -i certificate   # certs obtained
```
- `https://tsmc-dpac.systems` — app (padlock)
- `https://sim.tsmc-dpac.systems` — swipe demo
- `https://grafana.tsmc-dpac.systems` — Grafana login
- `https://prometheus.tsmc-dpac.systems` — basic-auth prompt (`PROM_USER` / password)

> Certs need DNS live + ports 80/443 reachable. If a cert fails, fix DNS and
> `restart caddy`. Certs persist in the `caddydata` volume across redeploys.

---

## Phase 3 — boot auto-deploy (for an on/off VM)

The VM is normally powered off to save cost, so a teammate may push to `main`
while it's down. What happens:

| VM state on push | `build-push` | `deploy` | Result |
| --- | --- | --- | --- |
| **on** | ✅ images → GHCR | ✅ SSH deploy + health check | live, updated |
| **off** | ✅ images → GHCR | ⏭️ skipped (clear summary, job stays green) | images ready, deploys on next boot |

A genuine deploy failure on a *reachable* VM still fails **red** (deploy.sh
health-gates the result), so green vs red stays trustworthy.

### Install the boot-deploy unit (one-time)
Makes "start the VM" == "deploy the latest image from GHCR":
```bash
cd ~/NTU_CloudNative
# Edit User= and the two paths in the unit to your VM user, then:
sed "s/CHANGE_ME_DEPLOY_USER/$USER/g" infra/systemd/ntu-deploy.service | sudo tee /etc/systemd/system/ntu-deploy.service
sudo systemctl daemon-reload
sudo systemctl enable ntu-deploy.service
```
> Needs Docker already logged in to GHCR (the first CD run did that; creds
> persist in `~/.docker/config.json`) or the GHCR packages set to public.

### Confirm what's actually live (any time)
```bash
cat ~/NTU_CloudNative/DEPLOYED_VERSION      # commit + image_tag + deploy timestamp
journalctl -u ntu-deploy.service -b         # this boot's auto-deploy log
```
`DEPLOYED_VERSION` is rewritten on every successful, health-checked deploy —
compare its `commit:` with the latest SHA on GitHub to confirm you're current.

---

## 💰 Cost checklist

The VM is ~90% of the bill, so the levers are *when it runs* and *disk/IP size*.

1. **Stop the VM when idle — biggest saver.** Stopped = disk only (a few $/mo);
   running 24/7 ≈ $140–180/mo.
   `gcloud compute instances stop <VM> --zone <zone>` (data volumes survive).
2. **Static IP is required for the domain/HTTPS.** It bills a little while the VM
   is stopped, but DNS + certs need a stable IP — accept this small cost.
3. **Keep the Hyperdisk small** (n4 needs Hyperdisk Balanced; ~50 GB at baseline
   IOPS is plenty — don't over-provision IOPS/MBps).
4. **Disable the Google Cloud Ops Agent / Cloud Logging** — you already run
   Prometheus/Grafana/Loki; double-shipping logs is metered for no benefit.
5. **Run k6 load tests on the VM (internal), never against the public domain** —
   internet egress is metered.
6. **Committed-use discount only pays off at true 24/7.** For an on/off demo,
   on-demand + stop-when-idle wins.
7. Prune old snapshots/images (`deploy.sh` already runs `docker image prune -f`).

### Handled in code for prod

`docker-compose.prod.yml` + `docker-compose.https.yml`: `APP_DEBUG=false`,
`restart: unless-stopped` everywhere, internal services on `127.0.0.1` / no host
port, only Caddy public (80/443), Kafka heap capped at 512 MB/broker, and the
four app images pulled from GHCR instead of built on the VM.
