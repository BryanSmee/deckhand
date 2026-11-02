{{/*
What the templates share. Each template is a file of deploy/kubernetes (or of a component), with
the values in place of its patches: the comments there say why each object is as it is.
*/}}

{{/* The label kustomization.yaml puts on every object (not on selectors or pod templates). */}}
{{- define "deckhand.labels" -}}
app.kubernetes.io/part-of: deckhand
{{- end }}

{{- define "deckhand.ns" -}}
{{ .Values.namespaces.services }}
{{- end }}

{{- define "deckhand.sandboxesNs" -}}
{{ .Values.namespaces.sandboxes }}
{{- end }}

{{/* A service's image: (list $ "edge"). */}}
{{- define "deckhand.image" -}}
{{- $ := index . 0 -}}
{{ $.Values.image.repository }}-{{ index . 1 }}:{{ $.Values.image.tag | default $.Chart.AppVersion }}
{{- end }}

{{/* The settings deckhand-env takes from the chart's values, which the objects (Roles, policies,
namespaces) agree with: `env` can't set them apart, by the value that does. */}}
{{- define "deckhand.managedEnv" -}}
RUNNER: the chart itself (kubernetes)
KUBERNETES_NAMESPACE: namespaces.sandboxes
KUBERNETES_SERVICES_NAMESPACE: namespaces.services
SANDBOX_IMAGE: image.sandbox
KUBERNETES_STORAGE_CLASS: sandboxes.storageClass
KUBERNETES_CACHE_STORAGE_CLASS: sandboxes.cacheStorageClass
KUBERNETES_AGENT_STORAGE_CLASS: sandboxes.agentStorageClass
KUBERNETES_REGISTRY: registry.url
KUBERNETES_REGISTRY_SECRET: registry.secretName
KUBERNETES_BUILDKIT: buildkit.enabled
STORE_URL: store
{{- end }}

{{/* deckhand-env's data: the base's literals, the components', then the values'. */}}
{{- define "deckhand.envData" -}}
{{- $env := dict
  "RUNNER" "kubernetes"
  "KUBERNETES_NAMESPACE" .Values.namespaces.sandboxes
  "KUBERNETES_SERVICES_NAMESPACE" .Values.namespaces.services
  "SANDBOX_IMAGE" (.Values.image.sandbox | default (include "deckhand.image" (list . "sandbox")))
-}}
{{- with .Values.sandboxes.storageClass }}{{ $_ := set $env "KUBERNETES_STORAGE_CLASS" . }}{{ end }}
{{- with .Values.sandboxes.cacheStorageClass }}{{ $_ := set $env "KUBERNETES_CACHE_STORAGE_CLASS" . }}{{ end }}
{{- with .Values.sandboxes.agentStorageClass }}{{ $_ := set $env "KUBERNETES_AGENT_STORAGE_CLASS" . }}{{ end }}
{{- if .Values.buildkit.enabled }}
{{- $_ := set $env "KUBERNETES_REGISTRY_SECRET" .Values.registry.secretName }}
{{- $_ := set $env "KUBERNETES_BUILDKIT" "tcp://buildkitd:1234" }}
{{- with .Values.registry.url }}{{ $_ := set $env "KUBERNETES_REGISTRY" . }}{{ end }}
{{- end }}
{{- range $name, $value := .Values.env }}
{{- with get (include "deckhand.managedEnv" $ | fromYaml) $name }}
{{- fail (printf "env.%s: the chart sets it from %s" $name .) }}
{{- end }}
{{- $_ := set $env $name (toString $value) }}
{{- end }}
{{- toYaml $env }}
{{- end }}

{{/* deckhand-server's data: config.yaml, and each grant under its path's key. */}}
{{- define "deckhand.serverData" -}}
{{- $data := dict "config.yaml" .Values.server.config -}}
{{- range $path, $text := .Values.server.grants }}
{{- $key := include "deckhand.grantKey" $path }}
{{- if hasKey $data $key }}
{{- fail (printf "server.grants: %q would take the ConfigMap key %q, already taken" $path $key) }}
{{- end }}
{{- $_ := set $data $key $text }}
{{- end }}
{{- toYaml $data }}
{{- end }}

{{/* A grant's key in deckhand-server, which can't hold a slash: a top-level file's name as it is
(default.yaml), else its path's hash before its path without slashes (acme/api.yaml:
<hash>.acme-api.yaml), as a-b/c.yaml and a/b-c.yaml would otherwise share one key. */}}
{{- define "deckhand.grantKey" -}}
{{- if contains "/" . -}}
{{ sha256sum . | trunc 8 }}.{{ replace "/" "-" . }}
{{- else -}}
{{ . }}
{{- end -}}
{{- end }}

{{/* The generated ConfigMaps' names carry a hash of their data, as kustomize's do: pods that
read them restart when it changes. */}}
{{- define "deckhand.envName" -}}
deckhand-env-{{ include "deckhand.envData" . | sha256sum | trunc 10 }}
{{- end }}

{{- define "deckhand.serverName" -}}
deckhand-server-{{ include "deckhand.serverData" . | sha256sum | trunc 10 }}
{{- end }}

{{/* The `server` volume: config.yaml, and the grants for the services that read them. */}}
{{- define "deckhand.serverVolume" -}}
{{- $ := index . 0 -}}
- name: server
  projected:
    sources:
      - configMap:
          name: {{ include "deckhand.serverName" $ }}
          items:
            - key: config.yaml
              path: config.yaml
            {{- if index . 1 }}
            {{- range $path, $_ := $.Values.server.grants }}
            - key: {{ include "deckhand.grantKey" $path }}
              path: grants/{{ $path }}
            {{- end }}
            {{- end }}
{{- end }}

{{- define "deckhand.brokerTokenVolume" -}}
- name: broker-token
  projected:
    sources:
      - serviceAccountToken:
          audience: deckhand-broker
          path: broker-token
          expirationSeconds: 3600
{{- end }}

{{- define "deckhand.podSecurityContext" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  runAsGroup: 1000
  {{- if not . }}
  fsGroup: 1000
  {{- end }}
  seccompProfile:
    type: RuntimeDefault
{{- end }}

{{- define "deckhand.containerSecurityContext" -}}
securityContext:
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: [ALL]
{{- end }}

{{- define "deckhand.strategy" -}}
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 0
    maxSurge: 1
{{- end }}

{{/* Copies on one node, sharing a ReadWriteOnce claim: (the app label). */}}
{{- define "deckhand.sameNode" -}}
affinity:
  podAffinity:
    requiredDuringSchedulingIgnoredDuringExecution:
      - topologyKey: kubernetes.io/hostname
        labelSelector:
          matchLabels:
            app: {{ . }}
{{- end }}

{{/* Probes: (list port readinessPath livenessPath). */}}
{{- define "deckhand.probes" -}}
readinessProbe:
  httpGet:
    path: {{ index . 1 }}
    port: {{ index . 0 }}
  periodSeconds: 5
livenessProbe:
  httpGet:
    path: {{ index . 2 }}
    port: {{ index . 0 }}
  periodSeconds: 10
  failureThreshold: 6
{{- end }}

{{/* A service's store in Redis (components/redis/stores/): (the service's name). */}}
{{- define "deckhand.redisStore" -}}
- name: STORE_URL
  value: "redis://{{ . }}@redis:6379?prefix=deckhand:{{ . }}:"
- name: REDIS_PASSWORD
  valueFrom:
    secretKeyRef:
      name: deckhand-redis
      key: {{ . }}
{{- end }}

{{/* A service's claim: (list $ name accessMode). Kept by `helm uninstall`, as its store is. */}}
{{- define "deckhand.claim" -}}
{{- $ := index . 0 -}}
{{- $name := index . 1 -}}
{{- $mode := index . 2 -}}
{{- $class := $.Values.persistence.storageClass -}}
{{- if eq $mode "ReadWriteMany" }}{{ $class = $.Values.persistence.sharedStorageClass | default $class }}{{ end -}}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ $name }}
  namespace: {{ include "deckhand.ns" $ }}
  labels:
    {{- include "deckhand.labels" $ | nindent 4 }}
  annotations:
    helm.sh/resource-policy: keep
spec:
  accessModes: [{{ $mode }}]
  {{- with $class }}
  storageClassName: {{ . }}
  {{- end }}
  resources:
    requests:
      storage: {{ required (printf "persistence.sizes.%s" $name) (index $.Values.persistence.sizes $name) }}
{{- end }}

{{/* The values the templates can't do without, checked once (namespaces.yaml). */}}
{{- define "deckhand.check" -}}
{{- if not (has .Values.store (list "file" "redis")) }}
{{- fail (printf "store: %q, where file or redis is expected" .Values.store) }}
{{- end }}
{{- if eq .Values.namespaces.services .Values.namespaces.sandboxes }}
{{- fail "namespaces: the services and the sandboxes need a namespace each" }}
{{- end }}
{{- if and .Values.ingress.enabled (not .Values.ingress.host) }}
{{- fail "ingress.host: required with ingress.enabled" }}
{{- end }}
{{- if not .Values.apiServer.cidrs }}
{{- fail "apiServer.cidrs: the API server's addresses, one at least" }}
{{- end }}
{{- end }}
