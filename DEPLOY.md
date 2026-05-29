# Deployment (GCP single VM, Docker Compose)

Target: one **n4-standard-4** (4 vCPU / 16 GB) running the full stack via Docker
Compose. CI (`.github/workflows/ci.yml`) tests every push; CD
(`.github/workflows/cd.yml`) builds the four app images, pushes them to GHCR,
and deploys them onto the VM over SSH after CI passes.

```
push to main ──▶ CI (lint/build/test) ──success──▶ CD
                                                    ├─ build & push 4 images → ghcr.io/billsavart/ntu_cloudnative/*
                                                    └─ ssh VM → scripts/deploy.sh (git pull, docker compose pull + up -d)
```

App images come from GHCR; infra images (Postgres / Redis / Kafka / Prometheus
/ Grafana / Loki / Tempo / Alloy) are pulled from their upstream registries by
compose. Bind-mounted config (nginx, prometheus, grafana provisioning, etc.)
comes from the git checkout on the VM — that is why `deploy.sh` runs `git pull`.

---

## 1. One-time VM setup

```bash
# On the VM (Debian/Ubuntu):
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin git
sudo usermod -aG docker "$USER"   # re-login after this
docker compose version            # must be >= 2.24.4 (needed for !override/!reset)

# Clone the repo to the path you'll put in DEPLOY_PATH:
git clone https://github.com/BillSavart/NTU_CloudNative.git ~/NTU_CloudNative
cd ~/NTU_CloudNative

# Create the production .env (NOT committed). Use strong, unique secrets:
cp .env.example .env
#   POSTGRES_PASSWORD=<strong>
#   REDIS_PASSWORD=<strong>
#   GRAFANA_ADMIN_PASSWORD=<strong>
#   APP_SECRET_KEY=<long random>      # e.g. openssl rand -hex 32
#   DEMO_SEED_PASSWORD=<strong>
#   # optional, if you put the app behind a domain + HTTPS:
#   APP_COOKIE_SECURE=true
#   CORS_ORIGINS=https://your.domain
```

> The current repo `.env` uses the placeholder password `imlab306`. **Do not
> ship that** — set real secrets in the VM `.env` before the first deploy.

### Add 4 GB swap (recommended)

The full stack is memory-tight on 16 GB (3 Kafka brokers, 3 Redis + 3 Sentinel,
Postgres, the 4 apps, and Prometheus/Grafana/Loki/Tempo/Alloy). Swap prevents an
OOM-kill from cascading — cheaper than upgrading the machine:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### First boot

```bash
IMAGE_TAG=latest ./scripts/deploy.sh      # pulls :latest once it exists
# Seed demo users / data once (optional):
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T reporting-api python -m app.seed
```

---

## 2. GitHub repo secrets (Settings → Secrets and variables → Actions)

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | VM external IP or domain |
| `DEPLOY_USER` | SSH user (the one in the `docker` group) |
| `DEPLOY_SSH_KEY` | Private key whose public half is in the VM's `~/.ssh/authorized_keys` |
| `DEPLOY_PATH` | Repo path on the VM, e.g. `/home/<user>/NTU_CloudNative` |
| `DEPLOY_GHCR_TOKEN` | A PAT with **`read:packages`** so the VM can `docker login ghcr.io` and pull |

The build job pushes with the built-in `GITHUB_TOKEN` (no secret needed). The VM
pull needs its own token because `GITHUB_TOKEN` only lives inside the Actions
run. If you make the GHCR packages public you can drop `DEPLOY_GHCR_TOKEN`.

Manual deploy any time: **Actions → CD → Run workflow** (workflow_dispatch).

---

## 3. GCP firewall (open only what's public)

Only the frontend (80/443), Grafana (3000), and SSH (22) need to be reachable.
Everything else binds to `127.0.0.1` in `docker-compose.prod.yml`, but keep the
firewall tight as defense-in-depth:

```
Allow: tcp:22 (SSH, ideally from your IP only), tcp:80, tcp:443, tcp:3000
Deny everything else (default).
```

Do **not** open 5432/6379/9092/9090 — DB, Redis, Kafka, Prometheus must stay private.

---

## 4. 💰 Cost checklist (do these before/around deploy)

The VM itself is ~90% of the bill, so the levers are mostly about *when it runs*
and *how big its disk/IP are* — not the app.

1. **Stop the VM when idle — biggest saver.** A stopped n4 costs only its disk
   (~a few $/mo); running 24/7 is ~$140–180/mo. For a course demo, start it for
   the presentation/dev session and `gcloud compute instances stop` afterwards.
   You can automate with an instance schedule.
2. **Use an *ephemeral* external IP, not a reserved static one.** A reserved
   static IP is billed while the VM is **stopped** (and when unattached). Ephemeral
   IPs are free while attached and released on stop. Only reserve a static IP if
   you need stable DNS.
3. **Keep the Hyperdisk small.** n4 requires Hyperdisk Balanced (no cheap
   pd-standard). ~50 GB at baseline IOPS/throughput is plenty for these images +
   volumes — don't over-provision IOPS, you pay per provisioned IOPS/MBps.
4. **Disable the Google Cloud Ops Agent / Cloud Logging ingestion.** You already
   run your own Prometheus/Grafana/Loki; shipping container logs to Cloud Logging
   adds metered cost for zero benefit here.
5. **Run k6 load tests *on the VM* (internal), never against the external IP.**
   Internet egress is metered; loopback/internal traffic is free.
6. **Pick a cost-reasonable region close to you** (e.g. `asia-east1`, Taiwan) to
   keep latency low without paying premium-region rates.
7. **Long-term only:** a 1-year committed-use discount (~37%) pays off *only* if
   the VM truly runs 24/7. For an on/off demo, on-demand + stop-when-idle wins.
8. Delete old VM snapshots/images and prune unused Docker images on the VM
   (`deploy.sh` already runs `docker image prune -f`).

### Repo-side changes already handled for prod

`docker-compose.prod.yml` (layered over `docker-compose.yml`) takes care of:
`APP_DEBUG=false` / `APP_ENV=production`, `restart: unless-stopped` on every
service, internal services bound to `127.0.0.1`, Kafka broker heap capped at
512 MB each (~1.5 GB saved vs. the 1 GB default × 3), and app images pulled from
GHCR instead of built on the VM.
