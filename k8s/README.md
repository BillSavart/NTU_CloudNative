# Kubernetes Deployment

This directory contains Kubernetes manifests for the full access-control demo stack. The default profile is tuned for a single 16 GB VM demo environment.

- Access API
- Frontend dashboard
- Swipe simulator
- Reporting API
- PostgreSQL
- Redis master, replicas, and Sentinel
- Kafka 3-node KRaft demo cluster
- Prometheus, Grafana, Loki, Tempo, Alloy, and Redis/PostgreSQL/Kafka exporters

The manifests target local demo clusters such as Docker Desktop Kubernetes, minikube, kind, or a lightweight single-node K3s VM. For production, replace the in-repo database, Redis, Kafka, and monitoring manifests with managed services or operators.

## Recommended Single-VM Runtime

For a 16 GB VM, K3s is the safest choice because the control plane is much lighter than a standard kubeadm cluster. Install K3s without the default Traefik ingress if you plan to use Nginx Ingress:

```bash
curl -sfL https://get.k3s.io | sh -s - --disable traefik
```

Install Nginx Ingress Controller:

```bash
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.0/deploy/static/provider/baremetal/deploy.yaml
```

Expose the ingress controller through NodePort. Point DNS records, or `/etc/hosts` during demo, to the VM public IP:

```text
<VM_PUBLIC_IP> access-control.local gate-api.local grafana.local prometheus.local
```

This keeps traffic inside your VM and avoids provisioning a paid cloud Load Balancer.

## Resource Profile

The manifests include conservative requests and limits for a 16 GB machine:

- Kafka: 1 GiB JVM heap per broker, 1.5 GiB container memory limit.
- Redis master: 256 MiB limit with `maxmemory`.
- Redis replicas: 128 MiB limit with `maxmemory`.
- Redis Sentinel: 96 MiB limit per Sentinel.
- Prometheus: 512 MiB limit, 15 second scrape interval, 6 hour local retention.
- Frontend, exporters, Access API, and Reporting API all have explicit CPU and memory limits.

If the VM becomes tight, reduce Kafka to one broker for demo only, or temporarily disable exporters before reducing application limits.

## Build Local Images

Build the project images before applying manifests to a local cluster:

```bash
docker build -t access-api:0.1.0 ./access-api
docker build -t reporting-api:0.1.0 ./reporting-api
docker build -t frontend:0.1.0 ./frontend
docker build -t simulator:0.1.0 ./simulator
```

For minikube or kind, load or build the images inside the cluster image runtime.

## Configure Secrets

Edit `01-config-secret.yaml` before applying:

```text
POSTGRES_PASSWORD
REDIS_PASSWORD
APP_SECRET_KEY
GRAFANA_ADMIN_PASSWORD
```

The default values are placeholders only.

## Deploy

Apply everything:

```bash
kubectl apply -k .
```

Run this command from the repository root. `kubectl apply -k .` uses Kustomize to package shared observability files into Kubernetes ConfigMaps, including the Grafana dashboard JSON, Prometheus alert rules, and k6 scripts. Use this path for cloud or Kubernetes demos.

Check rollout status:

```bash
kubectl -n access-control get pods
kubectl -n access-control get svc
```

## Local Access

The default services are `ClusterIP`; use Ingress for VM demo access. If your local Kubernetes does not have an ingress controller ready, use port-forwarding:

```bash
kubectl -n access-control port-forward svc/frontend 5173:80
kubectl -n access-control port-forward svc/simulator 5174:80
kubectl -n access-control port-forward svc/access-api 8080:80
kubectl -n access-control port-forward svc/reporting-api 8000:8000
kubectl -n access-control port-forward svc/prometheus 9090:9090
kubectl -n access-control port-forward svc/grafana 3000:3000
```

Open:

```text
Frontend:   http://localhost:5173
Simulator:  http://localhost:5174
Access API: http://localhost:8080/ping
Reporting:  http://localhost:8000/api/health/
Prometheus: http://localhost:9090
Grafana:    http://localhost:3000
```

With Nginx Ingress and hostnames configured:

```text
Frontend:   http://access-control.local
Access API: http://gate-api.local/ping
Prometheus: http://prometheus.local
Grafana:    http://grafana.local
```

## Run k6 In Kubernetes

The full-stack k6 load test can run inside the cluster, so the same traffic affects Prometheus, Grafana, Loki, and Tempo:

```bash
kubectl -n access-control delete job k6-full-stack --ignore-not-found
kubectl apply -f k8s/k6-full-stack-job.yaml
kubectl -n access-control logs -f job/k6-full-stack
```

Run `kubectl apply -k .` once before the job so the `k6-scripts` ConfigMap exists. Tune the load by editing `k8s/k6-full-stack-job.yaml` environment values such as `VUS`, `RAMP_UP`, `STEADY`, and `RAMP_DOWN`.

## Notes

- The frontend container serves the built React app through Nginx and proxies `/api` to `reporting-api:8000`.
- The Reporting API image installs `prometheus-client` by default so `/metrics` is available in Compose and Kubernetes.
- Grafana uses the same dashboard JSON in Docker Compose and Kubernetes through Kustomize.
- Prometheus uses the same alert rules in Docker Compose and Kubernetes through Kustomize.
- Alloy collects Kubernetes pod logs and receives OTLP traces, then forwards logs to Loki and traces to Tempo.
- The Kafka manifests intentionally mirror the existing Docker Compose 3-node demo topology. For production, prefer a Kafka operator.
