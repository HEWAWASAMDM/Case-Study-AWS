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

## Section 3 — Frontend Containerisation & Deployment

### 3.1 Transfer the "New Event" template to EC2
```bash
# Download the HTML Template onto the EC2 Instance
:
wget https://templatemo.com/download/templatemo_486_new_event -O new-event.zip

# On EC2:
sudo apt install -y unzip
unzip tm-486-new-event.zip -d new-event
cd new-event/templatemo_486_new_event   # adjust if extraction folder name differs
```

### 3.2 Install Docker (on EC2, if not already present)
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

> **TODO (future step):** Allocate an Elastic IP so the public IP stops changing —
> planned before CI/CD stage / viva demo.

---

## Change Log

| Date | Change |
|---|---|
| 19 Jul 2026 | Initial runbook: account setup, k3s cluster, frontend deployed and verified |
