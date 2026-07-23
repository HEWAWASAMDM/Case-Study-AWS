#!/bin/bash

SERVICE=$1

if [ -z "$SERVICE" ]; then
    echo "Usage: $0 <service-name>"
    echo "Example: $0 event-service"
    exit 1
fi

CURRENT=$(kubectl get deployment ${SERVICE} -o jsonpath='{.metadata.labels.color}' 2>/dev/null)

if [ -z "$CURRENT" ]; then
    echo "Error: Cannot determine current color for $SERVICE"
    exit 1
fi

if [ "$CURRENT" == "blue" ]; then
    PREVIOUS="green"
else
    PREVIOUS="blue"
fi

echo "Rolling back $SERVICE from $CURRENT to $PREVIOUS"

kubectl scale deployment ${SERVICE}-${PREVIOUS} --replicas=1

kubectl rollout status deployment/${SERVICE}-${PREVIOUS} --timeout=120s

kubectl patch service ${SERVICE} -p "{\"spec\":{\"selector\":{\"app\":\"${SERVICE}\",\"color\":\"${PREVIOUS}\"}}}"

echo "Rollback complete - traffic switched to $PREVIOUS"
