# The deployment of this frontend application alongside a set of backend microservices and an analytics infrastructure. — Deployment Runbook

**Author:** Dinithi Hewawasam



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
Test it locally

```bash
uvicorn main:app --host 0.0.0.0 --port 8001 --reload
```

```bash
curl http://localhost:8001/
curl -X POST http://localhost:8001/events \
  -H "Content-Type: application/json" \
  -d '{"event_id":"EVT001","title":"Cloud Summit","venue":"Main Hall","date_time":"2026-08-01T09:00:00","ticket_price":25.0,"capacity":100,"seats_available":8}'
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

### Q3 - Saving Transactional Data 


### 6.1 Create the RDS PostgreSQL instance
Create the RDS instance with the required engine version and instance class.
```bash
aws rds create-db-instance --db-instance-identifier cw-event-db --db-instance-class db.t3.micro --engine postgres --engine-version 16.9 --master-username cwadmin --master-user-password '<password>' --allocated-storage 20 --publicly-accessible --backup-retention-period 0
```

### 6.2 Retrieve the endpoint and restrict access
Get the endpoint and security group, then restrict inbound access to the microservices' security group.
```bash
aws rds describe-db-instances --db-instance-identifier cw-event-db --query "DBInstances[0].Endpoint.Address" --output text

aws rds describe-db-instances --db-instance-identifier cw-event-db --query "DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId" --output text

aws ec2 authorize-security-group-ingress --group-id <RDS_SG_ID> --protocol tcp --port 5432 --source-group sg-01457e1a4f626593f
```

### 6.3 Install database drivers (per service)
Install SQLAlchemy and the PostgreSQL driver in each service's virtual environment, then freeze requirements.
```bash
cd ~/microservices/<service>
source venv/bin/activate
pip install sqlalchemy psycopg2-binary
pip freeze | grep -iE "fastapi|uvicorn|pydantic|sqlalchemy|psycopg2" > requirements.txt
```

### 6.4 Database connection module — database.py
Identical connection pattern used across all three services, reading connection details from environment variables.
```python
import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

DB_USER = os.getenv("DB_USER", "cwadmin")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_HOST = os.getenv("DB_HOST", "")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "postgres")

DATABASE_URL = f"postgresql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}?sslmode=require"

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
```

### 6.5 SQLAlchemy models

#### Event Service — models.py
```python
from sqlalchemy import Column, String, Float, Integer, DateTime
from database import Base

class EventDB(Base):
    __tablename__ = "events"
    event_id = Column(String, primary_key=True, index=True)
    title = Column(String, nullable=False)
    venue = Column(String, nullable=False)
    date_time = Column(DateTime, nullable=False)
    ticket_price = Column(Float, nullable=False)
    capacity = Column(Integer, nullable=False)
    seats_available = Column(Integer, nullable=False)
```

#### Program Service — models.py
```python
from sqlalchemy import Column, String
from database import Base

class SessionDB(Base):
    __tablename__ = "sessions"
    session_id = Column(String, primary_key=True, index=True)
    day = Column(String, nullable=False)
    track = Column(String, nullable=False)
    session_name = Column(String, nullable=False)
    speaker_name = Column(String, nullable=False)
    start_time = Column(String, nullable=False)
    end_time = Column(String, nullable=False)
```

#### Registration Service — models.py
```python
from sqlalchemy import Column, String, Integer, DateTime
from database import Base

class RegistrationDB(Base):
    __tablename__ = "registrations"
    registration_id = Column(String, primary_key=True, index=True)
    event_id = Column(String, nullable=False)
    name = Column(String, nullable=False)
    email = Column(String, nullable=False)
    ticket_count = Column(Integer, nullable=False)
    timestamp = Column(DateTime, nullable=False)

class EventDB(Base):
    __tablename__ = "events"
    event_id = Column(String, primary_key=True, index=True)
    title = Column(String)
    venue = Column(String)
    date_time = Column(DateTime)
    ticket_price = Column(Integer)
    capacity = Column(Integer)
    seats_available = Column(Integer)
```

### 6.6 Application logic — main.py

#### Event Service
```python
from fastapi import FastAPI, HTTPException, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from datetime import datetime

from database import engine, get_db, Base
from models import EventDB

Base.metadata.create_all(bind=engine)
app = FastAPI(title="Event Service")

class Event(BaseModel):
    event_id: str
    title: str
    venue: str
    date_time: datetime
    ticket_price: float
    capacity: int
    seats_available: int
    class Config:
        from_attributes = True

@app.get("/")
def root():
    return {"service": "Event Service", "status": "running"}

@app.post("/events", response_model=Event)
def create_event(event: Event, db: Session = Depends(get_db)):
    existing = db.query(EventDB).filter(EventDB.event_id == event.event_id).first()
    if existing:
        raise HTTPException(status_code=400, detail="Event ID already exists")
    db_event = EventDB(**event.dict())
    db.add(db_event)
    db.commit()
    db.refresh(db_event)
    return db_event

@app.get("/events", response_model=list[Event])
def list_events(db: Session = Depends(get_db)):
    return db.query(EventDB).all()

@app.get("/events/{event_id}", response_model=Event)
def get_event(event_id: str, db: Session = Depends(get_db)):
    event = db.query(EventDB).filter(EventDB.event_id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return event

@app.put("/events/{event_id}", response_model=Event)
def update_event(event_id: str, updated: Event, db: Session = Depends(get_db)):
    event = db.query(EventDB).filter(EventDB.event_id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    for key, value in updated.dict().items():
        setattr(event, key, value)
    db.commit()
    db.refresh(event)
    return event

@app.delete("/events/{event_id}")
def delete_event(event_id: str, db: Session = Depends(get_db)):
    event = db.query(EventDB).filter(EventDB.event_id == event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    db.delete(event)
    db.commit()
    return {"message": "Event deleted"}
```

#### Program Service
```python
from fastapi import FastAPI, HTTPException, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel

from database import engine, get_db, Base
from models import SessionDB

Base.metadata.create_all(bind=engine)
app = FastAPI(title="Program Service")

class SessionModel(BaseModel):
    session_id: str
    day: str
    track: str
    session_name: str
    speaker_name: str
    start_time: str
    end_time: str
    class Config:
        from_attributes = True

@app.get("/")
def root():
    return {"service": "Program Service", "status": "running"}

@app.post("/sessions", response_model=SessionModel)
def create_session(session: SessionModel, db: Session = Depends(get_db)):
    existing = db.query(SessionDB).filter(SessionDB.session_id == session.session_id).first()
    if existing:
        raise HTTPException(status_code=400, detail="Session ID already exists")
    db_session = SessionDB(**session.dict())
    db.add(db_session)
    db.commit()
    db.refresh(db_session)
    return db_session

@app.get("/sessions", response_model=list[SessionModel])
def list_sessions(db: Session = Depends(get_db)):
    return db.query(SessionDB).all()

@app.get("/sessions/track/{track}", response_model=list[SessionModel])
def get_sessions_by_track(track: str, db: Session = Depends(get_db)):
    results = db.query(SessionDB).filter(SessionDB.track.ilike(track)).all()
    if not results:
        raise HTTPException(status_code=404, detail="No sessions found for this track")
    return results

@app.get("/sessions/{session_id}", response_model=SessionModel)
def get_session(session_id: str, db: Session = Depends(get_db)):
    session = db.query(SessionDB).filter(SessionDB.session_id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session

@app.put("/sessions/{session_id}", response_model=SessionModel)
def update_session(session_id: str, updated: SessionModel, db: Session = Depends(get_db)):
    session = db.query(SessionDB).filter(SessionDB.session_id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    for key, value in updated.dict().items():
        setattr(session, key, value)
    db.commit()
    db.refresh(session)
    return session

@app.delete("/sessions/{session_id}")
def delete_session(session_id: str, db: Session = Depends(get_db)):
    session = db.query(SessionDB).filter(SessionDB.session_id == session_id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    db.delete(session)
    db.commit()
    return {"message": "Session deleted"}
```

#### Registration Service
```python
from fastapi import FastAPI, HTTPException, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr
from datetime import datetime
import uuid

from database import engine, get_db, Base
from models import RegistrationDB, EventDB

Base.metadata.create_all(bind=engine)
app = FastAPI(title="Registration Service")
LOW_SEATS_THRESHOLD = 10

class RegistrationRequest(BaseModel):
    event_id: str
    name: str
    email: EmailStr
    ticket_count: int

class Registration(RegistrationRequest):
    registration_id: str
    timestamp: datetime
    class Config:
        from_attributes = True

@app.get("/")
def root():
    return {"service": "Registration Service", "status": "running"}

@app.post("/registrations", response_model=Registration)
def create_registration(reg: RegistrationRequest, db: Session = Depends(get_db)):
    event = db.query(EventDB).filter(EventDB.event_id == reg.event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    if reg.ticket_count > event.seats_available:
        raise HTTPException(status_code=400, detail="Not enough seats available")

    event.seats_available -= reg.ticket_count

    registration = RegistrationDB(
        registration_id=str(uuid.uuid4()),
        timestamp=datetime.utcnow(),
        **reg.dict()
    )
    db.add(registration)
    db.commit()
    db.refresh(registration)
    db.refresh(event)

    if event.seats_available < LOW_SEATS_THRESHOLD:
        trigger_low_seats_alert(event.event_id, event.seats_available)

    return registration

@app.get("/registrations", response_model=list[Registration])
def list_registrations(db: Session = Depends(get_db)):
    return db.query(RegistrationDB).all()

@app.get("/registrations/{registration_id}", response_model=Registration)
def get_registration(registration_id: str, db: Session = Depends(get_db)):
    reg = db.query(RegistrationDB).filter(RegistrationDB.registration_id == registration_id).first()
    if not reg:
        raise HTTPException(status_code=404, detail="Registration not found")
    return reg

def trigger_low_seats_alert(event_id: str, seats_left: int):
    print(f"[ALERT] Event {event_id} has only {seats_left} seats left - triggering notification.")
```

### 6.7 Run and verify persistence (per service, in tmux)
Start each service in its own tmux session with the DB environment variables set, then verify it's running.
```bash
tmux new -s <service>
cd ~/microservices/<service>
export DB_USER=cwadmin
export DB_PASSWORD='<password>'
export DB_HOST=<rds-endpoint>
export DB_PORT=5432
export DB_NAME=postgres
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port <port> --reload
```
Detach: `Ctrl+B`, then `D`
```bash
curl http://localhost:<port>/
```

### 6.8 Verify data directly in PostgreSQL
Connect with psql and inspect the tables to confirm data is persisted.
```bash
psql "host=<rds-endpoint> port=5432 dbname=postgres user=cwadmin password=<password> sslmode=require"
```
```sql
\dt
SELECT * FROM events;
SELECT * FROM sessions;
SELECT * FROM registrations;
```

```bash
# From local WSL terminal
aws rds describe-db-instances --db-instance-identifier cw-event-db --query "DBInstances[0].Endpoint.Address" --output text
```
### Step 7.1 — Verify Your Email in SES
```bash
```bash
# From local WSL terminal
aws rds describe-db-instances --db-instance-identifier cw-event-db --query "DBInstances[0].Endpoint.Address" --output text
```
### Step 7.2 — IAM Role for the Lambda Function
Create the trust policy 
```bash
cat > lambda-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
```
Create the role

```bash
aws iam create-role \
  --role-name cw-lambda-ses-role \
  --assume-role-policy-document file://lambda-trust-policy.json
```
Attach permissions — SES send access + basic Lambda logging

```bash
aws iam attach-role-policy \
  --role-name cw-lambda-ses-role \
  --policy-arn arn:aws:iam::aws:policy/AmazonSESFullAccess

aws iam attach-role-policy \
  --role-name cw-lambda-ses-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

Get the role's ARN

```bash
aws iam get-role --role-name cw-lambda-ses-role --query "Role.Arn" --output text
```
### Step 7.3 — Write and Deploy the Lambda Function

Create the function code locally
```bash
mkdir -p ~/lambda-low-seats
cd ~/lambda-low-seats
```
```bash
cat > lambda_function.py << 'EOF'
import boto3
import os

ses_client = boto3.client('ses', region_name='eu-west-1')

SENDER = os.environ.get('SENDER_EMAIL', 'dinithimuthuwanthih@gmail.com')
RECIPIENT = os.environ.get('RECIPIENT_EMAIL', 'dinithimuthuwanthih@gmail.com')

def lambda_handler(event, context):
    event_id = event.get('event_id', 'UNKNOWN')
    seats_left = event.get('seats_left', 'UNKNOWN')

    subject = f"Low Seat Alert: Event {event_id}"
    body_text = (
        f"Event {event_id} has only {seats_left} seats remaining.\n\n"
        f"This is an automated notification from the New Event platform."
    )

    response = ses_client.send_email(
        Source=SENDER,
        Destination={'ToAddresses': [RECIPIENT]},
        Message={
            'Subject': {'Data': subject},
            'Body': {'Text': {'Data': body_text}}
        }
    )

    return {
        'statusCode': 200,
        'body': f"Notification sent for event {event_id}, message ID: {response['MessageId']}"
    }
EOF
```
Package it into a zip (Lambda deployment format)
```bash
zip lambda_function.zip lambda_function.py
```
### Create the Lambda function in AWS

```bash
aws lambda create-function \
  --function-name low-seats-notification \
  --runtime python3.12 \
  --role arn:aws:iam::108405836017:role/cw-lambda-ses-role \
  --handler lambda_function.lambda_handler \
  --zip-file fileb://lambda_function.zip \
  --timeout 10

```
Test it directly

```bash
aws lambda invoke \
  --function-name low-seats-notification \
  --cli-binary-format raw-in-base64-out \
  --payload '{"event_id":"EVT001","seats_left":6}' \
  response.json

cat response.json
```
### Step 7.4 — Give EC2 Permission to Invoke Lambda

Create a trust policy for EC2
```bash
cat > ec2-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ec2.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
```

Create the role and attach Lambda invoke permission

```bash
aws iam create-role \
  --role-name cw-ec2-lambda-invoke-role \
  --assume-role-policy-document file://ec2-trust-policy.json

aws iam attach-role-policy \
  --role-name cw-ec2-lambda-invoke-role \
  --policy-arn arn:aws:iam::aws:policy/AWSLambda_FullAccess
```
Create an "instance profile" (the actual thing that attaches a role to an EC2 instance)

```bash
aws iam create-instance-profile --instance-profile-name cw-ec2-lambda-profile

aws iam add-role-to-instance-profile \
  --instance-profile-name cw-ec2-lambda-profile \
  --role-name cw-ec2-lambda-invoke-role
```

Attach the instance profile to your running EC2 instance
```bash
aws ec2 associate-iam-instance-profile \
  --instance-id i-0c3c8be754055de5f \
  --iam-instance-profile Name=cw-ec2-lambda-profile
```
### Step 7.5 — Wire the Real Lambda Call into Registration Service

```bash
cd ~/microservices/registration-service
source venv/bin/activate
pip install boto3
pip freeze | grep -iE "fastapi|uvicorn|pydantic|sqlalchemy|psycopg2|boto3" > requirements.txt
cat requirements.txt
```
Update main.py — replace the placeholder function

```bash

nano main.py
from fastapi import FastAPI, HTTPException, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel, EmailStr
from datetime import datetime
import uuid

from database import engine, get_db, Base
from models import RegistrationDB, EventDB

from database import engine, get_db, Base
from models import RegistrationDB, EventDB
import boto3
import json

Base.metadata.create_all(bind=engine)

app = FastAPI(title="Registration Service")

LOW_SEATS_THRESHOLD = 10

class RegistrationRequest(BaseModel):
    event_id: str
    name: str
    email: EmailStr
    ticket_count: int

class Registration(RegistrationRequest):
    registration_id: str
    timestamp: datetime

    class Config:
        from_attributes = True

@app.get("/")
def root():
    return {"service": "Registration Service", "status": "running"}

@app.post("/registrations", response_model=Registration)
def create_registration(reg: RegistrationRequest, db: Session = Depends(get_db)):
    event = db.query(EventDB).filter(EventDB.event_id == reg.event_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    if reg.ticket_count > event.seats_available:
        raise HTTPException(status_code=400, detail="Not enough seats available")

    # Deduct seats directly on the real Event Service table
    event.seats_available -= reg.ticket_count

    registration = RegistrationDB(
        registration_id=str(uuid.uuid4()),
        timestamp=datetime.utcnow(),
        **reg.dict()
    )
    db.add(registration)
    db.commit()
    db.refresh(registration)
    db.refresh(event)
# Step 8 — Web Analytics → ClickHouse

**Status:** In progress (8.1–8.5 complete and verified; 8.6 end-to-end data flow pending final confirmation)

---

## 8.1 — Deploy ClickHouse to k3s

SSH into the EC2 instance:
```bash
ssh -i cw-k8s-key.pem ubuntu@<PUBLIC_IP>
```

Create the manifests folder:
```bash
mkdir -p ~/k8s-manifests
cd ~/k8s-manifests
```

Write the ClickHouse Deployment (with persistent storage — see note below):
```bash
cat > clickhouse-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: clickhouse
spec:
  replicas: 1
  selector:
    matchLabels:
      app: clickhouse
  template:
    metadata:
      labels:
        app: clickhouse
    spec:
      containers:
        - name: clickhouse
          image: clickhouse/clickhouse-server:24.8
          ports:
            - containerPort: 8123
              name: http
            - containerPort: 9000
              name: native
          env:
            - name: CLICKHOUSE_DB
              value: "analytics"
            - name: CLICKHOUSE_USER
              value: "cwadmin"
            - name: CLICKHOUSE_PASSWORD
              value: "clickhouse123!"
            - name: CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT
              value: "1"
          volumeMounts:
            - name: clickhouse-storage
              mountPath: /var/lib/clickhouse
      volumes:
        - name: clickhouse-storage
          persistentVolumeClaim:
            claimName: clickhouse-pvc
EOF
```

Write the ClickHouse Service (internal only):
```bash
cat > clickhouse-service.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: clickhouse
spec:
  type: ClusterIP
  selector:
    app: clickhouse
  ports:
    - name: http
      port: 8123
      targetPort: 8123
    - name: native
      port: 9000
      targetPort: 9000
EOF
```

Create the PersistentVolumeClaim so ClickHouse's data survives pod restarts:
```bash
cat > clickhouse-pvc.yaml << 'EOF'
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: clickhouse-pvc
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 5Gi
EOF

kubectl apply -f clickhouse-pvc.yaml
```

Apply the Deployment and Service:
```bash
kubectl apply -f clickhouse-deployment.yaml
kubectl apply -f clickhouse-service.yaml
```

Verify:
```bash
kubectl get pods -l app=clickhouse
kubectl get pvc
```
**Expected:** `1/1 Running` pod; PVC status `Bound`.

**Why a PVC:** Kubernetes pods have disposable local storage by design — a pod recreated after eviction, restart, or upgrade starts with an empty filesystem. Since ClickHouse writes its data files to local disk (`/var/lib/clickhouse`), the PVC is what makes that data durable across pod recreation events.

---

## 8.2 — Create the analytics events table

```bash
kubectl run clickhouse-client --image=curlimages/curl -it --rm --restart=Never -- \
  curl -u cwadmin:clickhouse123! "http://clickhouse:8123/" --data-binary "
CREATE TABLE analytics.web_events (
    event_id UUID DEFAULT generateUUIDv4(),
    event_type String,
    session_id String,
    page_url String,
    section_name String,
    time_spent_seconds Float32,
    track_name String,
    referrer String,
    device_type String,
    event_timestamp DateTime DEFAULT now()
) ENGINE = MergeTree()
ORDER BY event_timestamp"
```

Verify:
```bash
kubectl run clickhouse-client --image=curlimages/curl -it --rm --restart=Never -- \
  curl -u cwadmin:clickhouse123! "http://clickhouse:8123/" --data-binary "SHOW TABLES FROM analytics"
```
**Expected:** `web_events` returned.

**Persistence check:** deleting the ClickHouse pod and re-running `SHOW TABLES` after the replacement pod reaches `Running` confirmed `web_events` still exists — validating the PVC is functioning correctly.

---

## 8.3 — Ingestion API (4th microservice: `analytics-service`)

FastAPI service exposing `POST /events`, writing rows into `analytics.web_events`. Built following the same pattern as `event-service` / `program-service` / `registration-service` (own `venv`, own `requirements.txt`, own `Dockerfile`).

**Note on environment variable naming:** avoid env var names that collide with any Kubernetes Service name in the namespace (e.g. `CLICKHOUSE_PORT` collides with the auto-injected `<SERVICE>_PORT` variable Kubernetes generates for a Service named `clickhouse`). Use a distinct name such as `CH_PORT` instead.

---

## 8.4 — Frontend tracking script (`analytics-tracker.js`)

Added to `templatemo_486_new_event/js/analytics-tracker.js`, referenced before `</body>`:
```html
<script src="js/custom.js"></script>
<script src="js/analytics-tracker.js"></script>
```

Captures four metrics via `navigator.sendBeacon` (with `fetch(..., keepalive: true)` fallback):

| Metric | `event_type` | Trigger |
|---|---|---|
| Page view | `page_view` | Fires once on page `load` |
| Section engagement time | `section_view` | `IntersectionObserver` on each `<section id="...">`, threshold 0.4, fires once a section leaves view after >1s dwell |
| Program track interest | `track_click` | Click on `#program .nav-tabs a[data-toggle="tab"]` |
| Registration intent | `register_click` | Click on `#register form input[type="submit"]` |

Each event also carries a session ID (persisted per-tab via `sessionStorage`), `page_url`, `referrer`, and `device_type` (derived from `navigator.userAgent`).

---

## 8.5 — Deploy ingestion API + rebuild frontend with tracking code

### 8.5.1–8.5.2 — Build and import the ingestion API image
```bash
cd ~/microservices/analytics-service
docker build -t analytics-service:v1 .
docker save analytics-service:v1 | sudo k3s ctr -n k8s.io images import -
sudo k3s crictl images | grep analytics-service
```

**Why `-n k8s.io` explicitly:** `docker save | k3s ctr images import` without a namespace flag imports into containerd's default namespace, which is *not* the namespace the kubelet/CRI reads from (`k8s.io`). Specifying `-n k8s.io` ensures the image is visible to Kubernetes when using `imagePullPolicy: Never`.

### 8.5.3 — Deploy analytics-service to k8s
```bash
cd ~/k8s-manifests

cat > analytics-service-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: analytics-service
spec:
  replicas: 2
  selector:
    matchLabels:
      app: analytics-service
  template:
    metadata:
      labels:
        app: analytics-service
    spec:
      containers:
        - name: analytics-service
          image: analytics-service:v1
          imagePullPolicy: Never
          ports:
            - containerPort: 8004
EOF

cat > analytics-service-svc.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: analytics-service
spec:
  type: NodePort
  selector:
    app: analytics-service
  ports:
    - port: 8004
      targetPort: 8004
      nodePort: 30081
EOF

kubectl apply -f analytics-service-deployment.yaml
kubectl apply -f analytics-service-svc.yaml
```

Open the NodePort in the security group:
```bash
SG_ID=sg-01457e1a4f626593f
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 30081 --cidr 0.0.0.0/0
```

Verify:
```bash
kubectl get pods -l app=analytics-service
kubectl get svc analytics-service
curl http://localhost:30081/
```
**Expected:** `2/2 Running`; `{"service":"Analytics Ingestion Service","status":"running"}`.

**Why NodePort here specifically:** unlike the internal-only `event-service` / `program-service` / `registration-service` (`ClusterIP`), the ingestion API must be reachable directly from a visitor's browser outside the cluster, so it requires a NodePort exposing it on the EC2 host.

### 8.5.4 — Point the tracker at the real ingestion URL and rebuild the frontend
```bash
cd ~/new-event/templatemo_486_new_event
# In js/analytics-tracker.js, set:
# const INGESTION_API = "http://<PUBLIC_IP>:30081/events";

docker build -t new-event-frontend:v2 .
docker save new-event-frontend:v2 | sudo k3s ctr -n k8s.io images import -
kubectl set image deployment/frontend-deployment frontend=new-event-frontend:v2
kubectl rollout status deployment/frontend-deployment
```

Verify:
```bash
kubectl get pods -l app=frontend
```
**Expected:** `2/2 Running` on the new image.

**Why the public IP is hardcoded:** the tracker script executes in the visitor's browser, outside the cluster's internal DNS. It can only reach the ingestion API via a routable address (the EC2 public IP), not the internal Kubernetes service name. Noted limitation: without an Elastic IP, this address changes on every instance stop/start and the frontend must be rebuilt accordingly.

---

## 8.6 — Verify events land in ClickHouse (in progress)

```bash
kubectl run clickhouse-client --image=curlimages/curl -it --rm --restart=Never -- \
  curl -u cwadmin:clickhouse123! "http://clickhouse:8123/" --data-binary \
  "SELECT event_type, count(*) FROM analytics.web_events GROUP BY event_type"
```

**Status:** table and persistence confirmed working; end-to-end browser → ingestion API → ClickHouse insert flow not yet confirmed with data. Final confirmation pending.

---

## Current Cluster State (10 pods across 5 deployments)
- `frontend-deployment` — 2 replicas
- `event-service` — 2 replicas
- `program-service` — 2 replicas
- `registration-service` — 2 replicas
- `analytics-service` — 2 replicas
- `clickhouse` — 1 replica (with PVC-backed persistent storage)
```
Verify the change and restart
```bash
grep -n "boto3\|lambda_client\|InvocationType" main.py
```

**Step 9: Metabase | Step 10: Prometheus + Grafana**
**Author:** Dinithi Hewawasam
 
---
 
## Step 9 — Business Intelligence Dashboard (Metabase)
 
**Status:** Complete
 
### 9.1 Pre-flight check
 
Before deploying Metabase, node headroom was confirmed. Metabase is a JVM-based application with a materially higher baseline memory footprint than the project's FastAPI microservices, and deploying it without checking available capacity was the direct cause of an earlier memory-eviction incident on the `t3.small` node.
 
```bash
kubectl top nodes
kubectl get pods -A
```
 
**Why we used this code:** `kubectl top nodes` surfaces current CPU/memory pressure before adding a new, heavier workload. Treating this as a mandatory gate — rather than deploying first and reacting to problems afterwards — avoids repeating the same eviction behaviour seen previously in the project.
 
### 9.2 Create Metabase's own metadata database on RDS
 
```bash
psql "host=<rds-endpoint> port=5432 dbname=postgres user=cwadmin password=<password> sslmode=require" \
  -c "CREATE DATABASE metabase;"
```
 
**Why we used this code:** Metabase's *application* metadata (dashboards, users, saved queries) is kept in a separate database from the *business* data it visualises (`events`, `sessions`, `registrations`). Mixing the two would risk Metabase's internal schema colliding with, or cluttering, the application's own tables.
 
### 9.2 Write the Metabase manifests
 
```bash
mkdir -p ~/k8s-manifests
cd ~/k8s-manifests
```
 
**Deployment:**
```bash
cat > metabase-deployment.yaml << 'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: metabase
spec:
  replicas: 1
  selector:
    matchLabels:
      app: metabase
  template:
    metadata:
      labels:
        app: metabase
    spec:
      containers:
        - name: metabase
          image: metabase/metabase:v0.50.8
          ports:
            - containerPort: 3000
          env:
            - name: MB_DB_TYPE
              value: "postgres"
            - name: MB_DB_DBNAME
              value: "metabase"
            - name: MB_DB_PORT
              value: "5432"
            - name: MB_DB_USER
              value: "cwadmin"
            - name: MB_DB_PASS
              value: "<password>"
            - name: MB_DB_HOST
              value: "<rds-endpoint>"
          resources:
            requests:
              memory: "512Mi"
              cpu: "250m"
            limits:
              memory: "1Gi"
              cpu: "500m"
EOF
```
 
**Why we used this code:** explicit `resources.requests` and `resources.limits` are set deliberately here, unlike the lighter FastAPI services. Without a memory limit, a JVM-based application like Metabase can consume unbounded memory under load and trigger the same node-level eviction seen earlier — `requests` reserves guaranteed headroom on the node at scheduling time, while `limits` caps worst-case consumption so one pod cannot starve the rest of the cluster.
 
**Service:**
```bash
cat > metabase-service.yaml << 'EOF'
apiVersion: v1
kind: Service
metadata:
  name: metabase
spec:
  type: NodePort
  selector:
    app: metabase
  ports:
    - port: 3000
      targetPort: 3000
      nodePort: 30082
EOF
```
 
**Why we used this code:** `NodePort` (rather than `ClusterIP`, used for the internal-only microservices) is required because Metabase's dashboard UI must be reachable directly from a browser outside the cluster, in the same way the frontend and analytics-ingestion services are exposed.
 
### 9.3 Apply and verify
 
```bash
kubectl apply -f metabase-deployment.yaml
kubectl apply -f metabase-service.yaml
 
# Open the NodePort in the security group
SG_ID=sg-01457e1a4f626593f
aws ec2 authorize-security-group-ingress --group-id $SG_ID --protocol tcp --port 30082 --cidr 0.0.0.0/0
 
kubectl get pods -l app=metabase
kubectl get svc metabase
```
 
**Expected:** `1/1 Running`; service listed as `3000:30082/TCP`.
 
### 9.4 Connect Metabase to the application data
 
Accessed via:
```
http://<PUBLIC_IP>:30082
```
 
Completed Metabase's first-run setup wizard, then added the existing RDS PostgreSQL instance (`events`, `sessions`, `registrations` tables) as a connected data source, enabling BI reporting directly on top of the application's transactional data without duplicating it.
 
**Why we used this approach:** connecting Metabase directly to the existing RDS instance (using a distinct database within the same instance for its own metadata) avoids standing up a second database server purely for BI purposes, keeping the architecture consistent with the rest of the project's data layer.
 
---
 
## Step 10 — Kubernetes Cluster Monitoring (Prometheus + Grafana)
 
**Status:** Complete (10.1–10.5 verified with dashboard evidence)
 
### 10.1 Pre-flight check
 
The same discipline applied in Step 9 was repeated here: cluster headroom was confirmed before adding the monitoring stack on top of an already-active cluster.
 
```bash
kubectl top nodes
kubectl get pods -A
```
 
### 10.2 Deploy Prometheus + Grafana
 
Prometheus and Grafana were deployed as the monitoring stack — the industry-standard pairing for Kubernetes observability, satisfying the coursework requirement to monitor system health, performance, and availability.
 
**Why we used this code:** Prometheus scrapes and stores time-series metrics from cluster components; Grafana visualises those metrics as dashboards. Using this established pairing, rather than a custom-built solution, reflects standard industry practice for cloud-native observability.
 
### 10.3 Configure Prometheus scraping
 
Two scrape jobs were defined in the `prometheus-config` ConfigMap:
 
```yaml
scrape_configs:
  - job_name: 'kubernetes-pods'
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: true
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        regex: ([^:]+)(?::\d+)?;(\d+)
        replacement: $1:$2
        target_label: __address__
      - source_labels: [__meta_kubernetes_namespace]
        target_label: kubernetes_namespace
      - source_labels: [__meta_kubernetes_pod_name]
        target_label: kubernetes_pod_name
 
  - job_name: 'kubernetes-cadvisor'
    kubernetes_sd_configs:
      - role: node
    scheme: https
    tls_config:
      ca_file: /var/run/secrets/kubernetes.io/serviceaccount/ca.crt
      insecure_skip_verify: true
    bearer_token_file: /var/run/secrets/kubernetes.io/serviceaccount/token
    relabel_configs:
      - target_label: __address__
        replacement: kubernetes.default.svc:443
      - source_labels: [__meta_kubernetes_node_name]
        regex: (.+)
        target_label: __metrics_path__
        replacement: /api/v1/nodes/$1/proxy/metrics/cadvisor
```
 
**Why we used this code:** the `kubernetes-cadvisor` job (role: `node`) collects container-level CPU/memory metrics directly from each node's cAdvisor endpoint. The `kubernetes-pods` job (role: `pod`) is opt-in by design — only pods explicitly annotated `prometheus.io/scrape: "true"` are scraped, preventing Prometheus from indiscriminately hitting every pod in the cluster.
 
#### Troubleshooting — cAdvisor scrape failure (`up=0`)
 
**Symptom:** `up{job="kubernetes-cadvisor"}` returned `0`, despite the target being discovered.
 
```bash
kubectl get --raw "/api/v1/nodes/<NODE_NAME>/proxy/metrics/cadvisor" | head -20
kubectl get clusterrole prometheus -o yaml | grep -A 5 "resources:"
```
 
**Root cause:** the `ClusterRole` bound to Prometheus's service account included `nodes` and `nodes/metrics`, but not `nodes/proxy` — the specific subresource required by the cAdvisor proxy path. Without it, the API server rejected the scrape request with a 403 before it reached cAdvisor.
 
**Fix:**
```bash
kubectl edit clusterrole prometheus
```
```yaml
resources:
  - nodes
  - nodes/metrics
  - nodes/proxy
  - services
  - endpoints
  - pods
```
 
**Why we used this code:** RBAC permissions are evaluated live on every API request, so no restart was required — the fix took effect on Prometheus's next scrape cycle. `nodes/metrics` and `nodes/proxy` are distinct RBAC subresources: the former exposes summary node metrics, the latter permits proxying arbitrary requests to a node's kubelet, which the cAdvisor endpoint specifically requires.
 
**Verification:** Prometheus UI → Status → Targets → `kubernetes-cadvisor` flipped from `DOWN` to `UP`.
 
### Deploying kube-state-metrics (restart counts / object state)
 
cAdvisor exposes only container resource usage; it has no visibility into Kubernetes object state such as pod restart counts. `kube-state-metrics` was deployed to close this gap.
 
```bash
kubectl apply -k https://github.com/kubernetes/kube-state-metrics/examples/standard
kubectl get pods -n kube-system -l app.kubernetes.io/name=kube-state-metrics
```
 
**Why we used this code:** current releases of `kube-state-metrics` no longer publish a single bundled manifest; `kubectl apply -k` uses Kustomize to fetch and apply every manifest in the project's `examples/standard/` directory as one coherent unit.
 
#### Troubleshooting — kube-state-metrics not scraped
 
**Symptom:** `kube_pod_container_status_restarts_total` returned no data, despite the pod running healthily.
 
**Diagnosis:** the `kubernetes-pods` job had no namespace restriction (so it does scan `kube-system`), but its relabel rule only keeps pods carrying `prometheus.io/scrape: "true"` — an annotation the upstream `kube-state-metrics` manifest does not set by default.
 
**Fix:**
```bash
kubectl patch deployment kube-state-metrics -n kube-system -p \
'{"spec":{"template":{"metadata":{"annotations":{"prometheus.io/scrape":"true","prometheus.io/port":"8080"}}}}}'
```
 
**Why we used this code:** `kubectl patch` adds the required annotations to the pod template without hand-editing the full manifest. This opts the pod into the existing `kubernetes-pods` job and specifies its metrics port, triggering an automatic rolling restart after which Prometheus picked it up.
 
### 10.4 Grafana dashboard panels
 
**Panel A — Microservices Memory Usage**
```
container_memory_usage_bytes{namespace="default", pod=~".*-service-.*|.*frontend.*|.*clickhouse.*"}
```
Visualization: Time series.
 
**Panel B — Per-Service CPU Usage**
```
rate(container_cpu_usage_seconds_total{namespace="default", pod=~".*-service-.*|.*frontend.*|.*clickhouse.*"}[1m])
```
Visualization: Time series.
 
**Why we used this code:** `container_cpu_usage_seconds_total` is a cumulative counter that only increases; wrapping it in `rate(...[1m])` converts it into cores used per second, averaged over a window wide enough to contain multiple 15-second scrape samples while remaining responsive to recent load changes.
 
**Panel C — Pod Restart Counts**
```
kube_pod_container_status_restarts_total{namespace="default"}
```
Visualization: Bar gauge / Stat (a running total, not a rate).
 
**Why we used this code:** this metric is the direct evidence of *availability* — the core requirement of this step. CPU and memory show resource pressure; restart count shows whether that pressure caused actual downtime.
 
### 10.5 Evidence captured
 
| # | Evidence | Confirms |
|---|---|---|
| 1 | Prometheus Status → Targets — `kubernetes-cadvisor` = `UP` | RBAC fix resolved the scrape failure |
| 2 | Grafana — Microservices Memory Usage panel, all 6 workloads | Full scrape coverage |
| 3 | Grafana — Pod Restart Counts panel | Availability evidence |
| 4 | Grafana — Per-Service CPU Usage panel | Per-service resource monitoring |
| 5 | Grafana — Cluster overview (memory/CPU/network) | Overall cluster health |
| 6 | `kubectl get pods` terminal output, matching timestamp | Cross-reference dashboard vs actual state |
 
---
 
## Summary
 
A Metabase instance was deployed for business-facing reporting on transactional data, connected to the existing RDS PostgreSQL instance with a dedicated metadata database. Separately, a Prometheus and Grafana stack was deployed for cluster-level observability, covering both container resource metrics (cAdvisor) and Kubernetes object-state metrics (`kube-state-metrics`). Two RBAC/configuration gaps were diagnosed and resolved during implementation — a missing `nodes/proxy` ClusterRole permission, and a missing scrape-opt-in annotation — both traced to root cause via direct inspection of live cluster configuration. Together, these two subsystems fulfil the coursework's requirements for business reporting and system health/performance/availability monitoring.

---

