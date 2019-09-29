#!/bin/bash

# Copyright (c) Microsoft Corporation
# All rights reserved.
#
# MIT License
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the "Software"), to deal in the Software without restriction, including without limitation
# the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
# to permit persons to whom the Software is furnished to do so, subject to the following conditions:
# The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
# BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
# NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
# DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

pushd $(dirname "$0") > /dev/null

APISERVER=$(kubectl config view | grep server | cut -f 2- -d ":" | tr -d " ")

until ! kubectl get sts | grep -q "hivedscheduler-sts"; do
    echo 'Trying to stop hivedscheduler ...'
    curl -X DELETE $APISERVER/apis/apps/v1/namespaces/default/statefulsets/hivedscheduler-sts \
        -H "Content-Type: application/json" \
        -d '{"kind":"DeleteOptions","apiVersion":"v1","propagationPolicy":"Foreground"}' > /dev/null 2>&1
    sleep 5
done

if kubectl get configmap | grep -q "hivedscheduler-config"; then
    kubectl delete configmap hivedscheduler-config || exit $?
fi

if kubectl get serviceaccount | grep -q "hivedscheduler-account"; then
    kubectl delete serviceaccount hivedscheduler-account || exit $?
fi

if kubectl get clusterrolebinding | grep -q "hivedscheduler-role-binding"; then
    kubectl delete clusterrolebinding hivedscheduler-role-binding || exit $?
fi

until ! kubectl get ds --namespace=kube-system | grep -q "nvidia-device-plugin-daemonset"; do
    echo 'Trying to stop nvidia device plugin ...'
    curl -X DELETE $APISERVER/apis/apps/v1/namespaces/kube-system/daemonsets/nvidia-device-plugin-daemonset \
        -H "Content-Type: application/json" \
        -d '{"kind":"DeleteOptions","apiVersion":"v1","propagationPolicy":"Foreground"}' > /dev/null 2>&1
    sleep 5
done

popd > /dev/null