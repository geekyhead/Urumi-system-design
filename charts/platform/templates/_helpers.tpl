{{- define "platform.fullname" -}}
{{- default .Release.Name .Values.nameOverride | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "platform.labels" -}}
app.kubernetes.io/part-of: store-platform
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "platform.serviceAccountName" -}}
{{ include "platform.fullname" . }}-api
{{- end -}}

{{- define "platform.tenantRoleName" -}}
{{ include "platform.fullname" . }}-tenant-manager
{{- end -}}
