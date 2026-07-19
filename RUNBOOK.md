# CMM707 Cloud Computing Coursework — Deployment Runbook

**Author:** Dinithi Hewawasam
**Last updated:** 19 July 2026
**Purpose:** Step-by-step, reproducible instructions to deploy the "New Event" frontend
and supporting infrastructure on a self-managed k3s Kubernetes cluster on AWS EC2.

---

## Prerequisites

- AWS account with an IAM user (not root) holding `AdministratorAccess`
- AWS CLI v2 installed and configured (`aws configure`)
- WSL2 (Ubuntu) or native Linux terminal
- Docker and kubectl available on the target EC2 instance

---

## Section 1 — AWS Account & Security Setup

### 1.1 Create a scoped IAM user (do this once, in AWS Console)
- IAM → Users → Add User → `cloud-engineer-admin`
- Attach policy: `AdministratorAccess`
- Enable MFA on both root and this IAM user

### 1.2 Configure a billing alarm (AWS Console)
- Billing → Budgets → Create Budget → set monthly threshold (e.g. $20) with email alert

### 1.3 Install & configure AWS CLI (local machine, inside WSL2 Ubuntu)
```bash
curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"
sudo apt install -y unzip
unzip awscliv2.zip
sudo ./aws/install
aws configure
# Enter: Access Key ID, Secret Access Key, region (eu-west-1), output format (json)
```

### 1.4 Verify authentication (never share this output's keys — only this command's result is safe to share)
```bash
aws sts get-caller-identity
```
**Expected output:** JSON showing your IAM user ARN (not root), e.g.
```json
{
    "UserId": "AIDARSPL5ZDYVESFNS2QU",
    "Account": "108405836017",
    "Arn": "arn:aws:iam::108405836017:user/cloud-engineer-admin"
}
```

---

## Section 2 — Kubernetes Cluster Provisioning (k3s on EC2)

### 2.1 Create SSH key pair
```bash
aws ec2 create-key-pair --key-name cw-k8s-key --query 'KeyMaterial' --output text > cw-k8s-key.pem
chmod 400 cw-k8s-key.pem
```

### 2.2 Create security group
```bash
aws ec2 create-security-group \
  --group-name cw-k8s-sg \
  --description "Security group for CMM707 k3s cluster"
# Note the returned GroupId, e.g. sg-01457e1a4f626593f
```

### 2.3 Open required ports (replace SG_ID with your actual group id)
```bash
SG_ID=sg-01457e1a4f626593f

aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 22 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 80 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 443 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 6443 --cidr 0.0.0.0/0
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 30080 --cidr 0.0.0.0/0
```
> **Security note (for report LO1/LSEPI discussion):** `0.0.0.0/0` opens these ports to
> the entire internet. This is a coursework simplification; production deployments
> should restrict SSH (22) to specific trusted IP ranges.

### 2.4 Find a valid AMI for your region
```bash
aws ec2 describe-images \
  --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
            "Name=state,Values=available" \
  --query "sort_by(Images, &CreationDate)[-1].[ImageId,Name]" \
  --output text
```

### 2.5 Launch the EC2 instance
```bash
aws ec2 run-instances \
  --image-id <AMI_ID_FROM_STEP_2.4> \
  --instance-type t3.small \
  --key-name cw-k8s-key \
  --security-groups cw-k8s-sg \
  --count 1 \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=cw-k8s-node}]'
```

### 2.6 Get the public IP
```bash
aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=cw-k8s-node" \
  --query "Reservations[].Instances[].PublicIpAddress" \
  --output text
```

### 2.7 SSH in and install k3s
```bash
ssh -i cw-k8s-key.pem ubuntu@<PUBLIC_IP>

# Once inside the instance:
curl -sfL https://get.k3s.io | sh -
```

### 2.8 Fix kubectl permissions (run inside EC2, once)
```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown $USER:$USER ~/.kube/config
chmod 600 ~/.kube/config
echo 'export KUBECONFIG=~/.kube/config' >> ~/.bashrc
source ~/.bashrc
```

### 2.9 Verify cluster
```bash
kubectl get nodes
# Expected: one node, STATUS=Ready, ROLES=control-plane
```

---
## Q1 - Deployment of the Frontend
## Section 3 — Frontend Containerisation & Deployment

### 3.1 Transfer the "New Event" template to EC2
```bash
# Download the HTML Template onto the EC2 Instance:
wget https://templatemo.com/download/templatemo_486_new_event -O new-event.zip

# On EC2:
sudo apt install -y unzip
unzip tm-486-new-event.zip -d new-event
cd new-event/templatemo_486_new_event  
```

### 3.2 Install Docker (on EC2)
```bash
sudo apt update
sudo apt install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
newgrp docker
```

### 3.3 Create the Dockerfile
```bash
cat > Dockerfile << 'EOF'
FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
EOF
```

### 3.4 Build the image
```bash
docker build -t new-event-frontend:v1 .
```

### 3.5 Import the image into k3s's containerd
```bash
docker save new-event-frontend:v1 | sudo k3s ctr images import -
sudo k3s ctr images list | grep new-event   # verify import succeeded
```

### 3.6 Write the Deployment manifest
```bash
cd ~/new-event
cat > frontend-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend-deployment
spec:
  replicas: 2
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      containers:
        - name: frontend
          image: new-event-frontend:v1
          imagePullPolicy: Never
          ports:
            - containerPort: 80
EOF
```

### 3.7 Write the Service manifest
```bash
cat > frontend-service.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: frontend-service
spec:
  type: NodePort
  selector:
    app: frontend
  ports:
    - port: 80
      targetPort: 80
      nodePort: 30080
EOF
```

### 3.8 Apply manifests
```bash
kubectl apply -f frontend-deployment.yaml
kubectl apply -f frontend-service.yaml
```

### 3.9 Verify deployment
```bash
kubectl get pods
kubectl get svc
```
**Expected:** 2/2 pods `Running`; service `frontend-service` shows `80:30080/TCP`

### 3.10 Test in browser
```
http://<PUBLIC_IP>:30080
```
**Expected:** "New Event" landing page renders.

---

## Section 4 — Pausing Work (cost control)

### 4.1 Stop the instance when not in use (run on LOCAL machine)
```bash
aws ec2 stop-instances --instance-ids <INSTANCE_ID>
```

### 4.2 Resume work later
```bash
aws ec2 start-instances --instance-ids <INSTANCE_ID>

# Get the NEW public IP (it changes on every stop/start without an Elastic IP)
aws ec2 describe-instances --instance-ids <INSTANCE_ID> \
  --query "Reservations[].Instances[].PublicIpAddress" --output text

ssh -i cw-k8s-key.pem ubuntu@<NEW_PUBLIC_IP>
kubectl get pods   # should already show Running after boot
```
## Q2 - Microservices Design
### Step 5.1 Project Folder Structure
```bash
mkdir -p ~/microservices/event-service
mkdir -p ~/microservices/program-service
mkdir -p ~/microservices/registration-service
cd ~/microservices
sudo apt install tree
```

```bash
# Download Python
sudo apt update
sudo apt install -y python3 python3-pip python3-venv
python3 --version
```
### Step 5.2 — Event Service
```bash
cd ~/microservices/event-service
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn
```

#### python3 -m venv venv — creates an isolated Python environment specific to this service, so its dependencies don't clash with the Program or Registration services later (each will get its own venv).
####  source venv/bin/activate — switches your terminal into that isolated environment (you'll see (venv) appear in your prompt).
#### fastapi — the web framework itself.
####  uvicorn — the actual server that runs your FastAPI app (FastAPI defines the API logic; uvicorn is what makes it listen on a network port).

### Write the Event Service code

```bash
nano main.py
```
```bash
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from datetime import datetime

app = FastAPI(title="Event Service")

# --- Data model (matches your brief's required fields) ---
class Event(BaseModel):
    event_id: str
    title: str
    venue: str
    date_time: datetime
    ticket_price: float
    capacity: int
    seats_available: int

# --- Temporary in-memory "database" (replaced with real RDS in Step 6) ---
events_db: dict[str, Event] = {}

@app.get("/")
def root():
    return {"service": "Event Service", "status": "running"}

@app.post("/events", response_model=Event)
def create_event(event: Event):
    if event.event_id in events_db:
        raise HTTPException(status_code=400, detail="Event ID already exists")
    events_db[event.event_id] = event
    return event

@app.get("/events", response_model=list[Event])
def list_events():
    return list(events_db.values())

@app.get("/events/{event_id}", response_model=Event)
def get_event(event_id: str):
    if event_id not in events_db:
        raise HTTPException(status_code=404, detail="Event not found")
    return events_db[event_id]

@app.put("/events/{event_id}", response_model=Event)
def update_event(event_id: str, updated: Event):
    if event_id not in events_db:
        raise HTTPException(status_code=404, detail="Event not found")
    events_db[event_id] = updated
    return updated

@app.delete("/events/{event_id}")
def delete_event(event_id: str):
    if event_id not in events_db:
        raise HTTPException(status_code=404, detail="Event not found")
    del events_db[event_id]
    return {"message": "Event deleted"}
```

### Step 5.3 — Program Service

### Set up the service folder

```bash
cd ~/microservices/program-service
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn
```
Write the Program Service code
```bash
nano main.py
```

```bash
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Program Service")

# --- Data model (matches your brief: Day, Track, Session, Speaker Name, Times) ---
class Session(BaseModel):
    session_id: str
    day: str
    track: str
    session_name: str
    speaker_name: str
    start_time: str
    end_time: str

# --- Temporary in-memory "database" (replaced with real RDS in Step 6) ---
sessions_db: dict[str, Session] = {}

@app.get("/")
def root():
    return {"service": "Program Service", "status": "running"}

@app.post("/sessions", response_model=Session)
def create_session(session: Session):
    if session.session_id in sessions_db:
        raise HTTPException(status_code=400, detail="Session ID already exists")
    sessions_db[session.session_id] = session
    return session

@app.get("/sessions", response_model=list[Session])
def list_sessions():
    return list(sessions_db.values())

@app.get("/sessions/track/{track}", response_model=list[Session])
def get_sessions_by_track(track: str):
    results = [s for s in sessions_db.values() if s.track.lower() == track.lower()]
    if not results:
        raise HTTPException(status_code=404, detail="No sessions found for this track")
    return results

@app.get("/sessions/{session_id}", response_model=Session)
def get_session(session_id: str):
    if session_id not in sessions_db:
        raise HTTPException(status_code=404, detail="Session not found")
    return sessions_db[session_id]

@app.put("/sessions/{session_id}", response_model=Session)
def update_session(session_id: str, updated: Session):
    if session_id not in sessions_db:
        raise HTTPException(status_code=404, detail="Session not found")
    sessions_db[session_id] = updated
    return updated

@app.delete("/sessions/{session_id}")
def delete_session(session_id: str):
    if session_id not in sessions_db:
        raise HTTPException(status_code=404, detail="Session not found")
    del sessions_db[session_id]
    return {"message": "Session deleted"}
```
Test

```bash
uvicorn main:app --host 0.0.0.0 --port 8002 --reload
```

Check Health
```bash
curl http://localhost:8002/

curl -X POST http://localhost:8002/sessions \
  -H "Content-Type: application/json" \
  -d '{"session_id":"SESS001","day":"Day 1","track":"Cloud Computing","session_name":"Intro to Kubernetes","speaker_name":"Jane Doe","start_time":"09:00","end_time":"10:00"}'

curl http://localhost:8002/sessions/track/Cloud%20Computing
```
### Step 5.4 — Registration Service

```bash
cd ~/microservices/registration-service
python3 -m venv venv
source venv/bin/activate
pip install fastapi uvicorn
```
Write the Registration Service code
```bash
nano main.py
```

```bash
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, EmailStr
from datetime import datetime
import uuid

app = FastAPI(title="Registration Service")

# --- Data model (matches your brief: Registration ID, Event ID, Name, Email, Ticket Count, Timestamp) ---
class RegistrationRequest(BaseModel):
    event_id: str
    name: str
    email: EmailStr
    ticket_count: int

class Registration(RegistrationRequest):
    registration_id: str
    timestamp: datetime

# --- Temporary in-memory "databases" (replaced with real RDS in Step 6) ---
registrations_db: dict[str, Registration] = {}

# Temporary local mirror of seat counts, simulating what would normally
# come from the Event Service / shared database once Step 6 wires them together.
event_seats: dict[str, int] = {
    "EVT001": 8  # matches the event we created earlier via Event Service
}

LOW_SEATS_THRESHOLD = 10

@app.get("/")
def root():
    return {"service": "Registration Service", "status": "running"}

@app.post("/registrations", response_model=Registration)
def create_registration(reg: RegistrationRequest):
    if reg.event_id not in event_seats:
        raise HTTPException(status_code=404, detail="Event not found")

    remaining = event_seats[reg.event_id]
    if reg.ticket_count > remaining:
        raise HTTPException(status_code=400, detail="Not enough seats available")

    # Deduct seats
    event_seats[reg.event_id] -= reg.ticket_count

    registration = Registration(
        registration_id=str(uuid.uuid4()),
        timestamp=datetime.utcnow(),
        **reg.dict()
    )
    registrations_db[registration.registration_id] = registration

    # --- This is the check your brief requires (Solution Requirement 2) ---
    if event_seats[reg.event_id] < LOW_SEATS_THRESHOLD:
        trigger_low_seats_alert(reg.event_id, event_seats[reg.event_id])

    return registration

@app.get("/registrations", response_model=list[Registration])
def list_registrations():
    return list(registrations_db.values())

@app.get("/registrations/{registration_id}", response_model=Registration)
def get_registration(registration_id: str):
    if registration_id not in registrations_db:
        raise HTTPException(status_code=404, detail="Registration not found")
    return registrations_db[registration_id]

def trigger_low_seats_alert(event_id: str, seats_left: int):
    """
    Placeholder for the serverless trigger (Step 7).
    In production, this will invoke an AWS Lambda function via boto3,
    which will then send an SES email or write an S3 notification object.
    """
    print(f"[ALERT] Event {event_id} has only {seats_left} seats left — triggering notification.")
```

Install one extra dependency this service needs:


```bash
pip install "pydantic[email]"
```
Test


```bash
uvicorn main:app --host 0.0.0.0 --port 8003 --reload
```

```bash
curl http://localhost:8003/

curl -X POST http://localhost:8003/registrations \
  -H "Content-Type: application/json" \
  -d '{"event_id":"EVT001","name":"John Silva","email":"john@example.com","ticket_count":2}'

```

### 5.5 Test each service locally before containerising
```bash
uvicorn main:app --host 0.0.0.0 --port <port> --reload
```
In a second terminal:
```bash
curl http://localhost:<port>/
curl -X POST http://localhost:<port>/<resource> -H "Content-Type: application/json" -d '{...}'
```
**Expected:** health check returns `{"service": "...", "status": "running"}`; POST requests return the created resource with generated IDs/timestamps where applicable.


### 5.6 Critical check before generating requirements.txt
```bash
which pip
```
**Must show** a path inside this service's own `venv` (e.g. `/home/ubuntu/microservices/event-service/venv/bin/pip`).
If it shows a system path instead, the venv is not active — re-run `source venv/bin/activate` before continuing.
 
```bash
pip freeze | grep -iE "fastapi|uvicorn|pydantic|email" > requirements.txt
cat requirements.txt
wc -l requirements.txt
```
**Must show 4+ populated lines.** An empty `requirements.txt` will build "successfully" in Docker but produce a broken image (`uvicorn: executable file not found in $PATH` at runtime) — this was encountered and fixed during this build; see Troubleshooting Log below.
 
### 5.7 Write the Dockerfile
```bash
cat > Dockerfile << 'EOF'
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
EXPOSE <port>
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "<port>"]
EOF
```
 
### 5.8 Build and import into k3s
```bash
docker build -t <service>:v1 .
docker save <service>:v1 | sudo k3s ctr images import -
sudo k3s ctr images list | grep <service>
```
 
### 5.9 Write Kubernetes manifests
```bash
mkdir -p ~/k8s-manifests
cd ~/k8s-manifests
```
Deployment (2 replicas, `imagePullPolicy: Never`, since image is local to the node):
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: <service>
spec:
  replicas: 2
  selector:
    matchLabels:
      app: <service>
  template:
    metadata:
      labels:
        app: <service>
    spec:
      containers:
        - name: <service>
          image: <service>:v1
          imagePullPolicy: Never
          ports:
            - containerPort: <port>
```
Service (ClusterIP — internal only; brief does not mandate external/frontend integration for these services):
```yaml
apiVersion: v1
kind: Service
metadata:
  name: <service>
spec:
  type: ClusterIP
  selector:
    app: <service>
  ports:
    - port: <port>
      targetPort: <port>
```
 
### 5.10 Apply all manifests
```bash
kubectl apply -f ~/k8s-manifests/
```
 
### 5.11 Verify all pods healthy
```bash
kubectl get pods
kubectl get svc
```
**Expected:** 8/8 pods `Running` total (2 frontend + 2 event-service + 2 program-service + 2 registration-service).
Services `event-service`, `program-service`, `registration-service` listed as type `ClusterIP`.
 
### 5.12 Verify internal service-to-service connectivity
```bash
kubectl run test-curl --image=curlimages/curl -it --rm --restart=Never -- curl http://event-service:8001/
kubectl run test-curl --image=curlimages/curl -it --rm --restart=Never -- curl http://program-service:8002/
kubectl run test-curl --image=curlimages/curl -it --rm --restart=Never -- curl http://registration-service:8003/
```
**Expected:** each returns its health-check JSON, confirming Kubernetes' internal DNS-based service discovery works correctly (services reachable by name, not just by pod IP).
 
---
 

> **TODO (future step):** Allocate an Elastic IP so the public IP stops changing —
> planned before CI/CD stage / viva demo.

---

## Change Log

| Date | Change |
|---|---|
| 19 Jul 2026 | Initial runbook: account setup, k3s cluster, frontend deployed and verified |
