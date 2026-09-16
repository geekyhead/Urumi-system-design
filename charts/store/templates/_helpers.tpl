{{/* Validates required values and returns the short store id. */}}
{{- define "store.id" -}}
{{- $id := required "store.id is required" .Values.store.id -}}
{{- if not (regexMatch "^[a-z0-9]{3,20}$" $id) -}}
{{- fail "store.id must be 3-20 lowercase alphanumeric characters" -}}
{{- end -}}
{{- $id -}}
{{- end -}}

{{- define "store.host" -}}
store-{{ include "store.id" . }}.{{ .Values.global.baseDomain }}
{{- end -}}

{{/* Every hostname the store answers on: primary first, then aliases. */}}
{{- define "store.hosts" -}}
{{- $id := include "store.id" . -}}
{{- $hosts := list (include "store.host" .) -}}
{{- range .Values.global.aliasDomains -}}
{{- $hosts = append $hosts (printf "store-%s.%s" $id .) -}}
{{- end -}}
{{- range (.Values.global.customDomains | default list) -}}
{{- $hosts = append $hosts (lower .) -}}
{{- end -}}
{{- toJson $hosts -}}
{{- end -}}

{{- define "store.scheme" -}}
{{- if .Values.global.tls -}}https{{- else -}}http{{- end -}}
{{- end -}}

{{- define "store.url" -}}
{{ include "store.scheme" . }}://{{ include "store.host" . }}
{{- end -}}

{{- define "store.labels" -}}
app.kubernetes.io/part-of: store-platform
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
platform.io/store-id: {{ include "store.id" . | quote }}
{{- end -}}

{{/* Selector labels for one store component. Args: (dict "root" . "component" "wordpress") */}}
{{- define "store.selectorLabels" -}}
app.kubernetes.io/component: {{ .component }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{- define "store.secretName" -}}
{{ .Release.Name }}-credentials
{{- end -}}

{{/* Reuses an existing base64 value from the looked-up Secret or generates a new one. Args: (list $data key length) */}}
{{- define "store.secretValue" -}}
{{- $data := index . 0 -}}
{{- $key := index . 1 -}}
{{- $len := index . 2 -}}
{{- if hasKey $data $key -}}
{{- index $data $key -}}
{{- else -}}
{{- randAlphaNum $len | b64enc -}}
{{- end -}}
{{- end -}}

{{- define "store.mariadbHost" -}}
{{ .Release.Name }}-mariadb
{{- end -}}

{{/* Environment shared by WordPress and the WP-CLI seeder so both render the same wp-config.php. */}}
{{- define "store.wordpressEnv" -}}
- name: WORDPRESS_DB_HOST
  value: "{{ include "store.mariadbHost" . }}:3306"
- name: WORDPRESS_DB_NAME
  value: wordpress
- name: WORDPRESS_DB_USER
  value: wordpress
- name: WORDPRESS_DB_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ include "store.secretName" . }}
      key: mariadb-password
- name: WORDPRESS_AUTH_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "store.secretName" . }}
      key: wp-auth-key
- name: WORDPRESS_SECURE_AUTH_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "store.secretName" . }}
      key: wp-secure-auth-key
- name: WORDPRESS_LOGGED_IN_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "store.secretName" . }}
      key: wp-logged-in-key
- name: WORDPRESS_NONCE_KEY
  valueFrom:
    secretKeyRef:
      name: {{ include "store.secretName" . }}
      key: wp-nonce-key
- name: WORDPRESS_CONFIG_EXTRA
  value: |
    if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && strpos($_SERVER['HTTP_X_FORWARDED_PROTO'], 'https') !== false) {
      $_SERVER['HTTPS'] = 'on';
    }
    if (isset($_SERVER['HTTP_X_FORWARDED_HOST'])) {
      $_SERVER['HTTP_HOST'] = $_SERVER['HTTP_X_FORWARDED_HOST'];
    }
    // Serve links and assets on whichever hostname the visitor used: the
    // platform subdomain, the *.localhost alias or a custom domain. Only
    // hostnames the store Ingress routes can reach WordPress, so attaching a
    // domain updates the Ingress alone and never restarts this pod.
    $store_host = isset($_SERVER['HTTP_HOST']) ? explode(':', $_SERVER['HTTP_HOST'])[0] : '';
    $store_host = strtolower(preg_replace('/[^A-Za-z0-9.\-]/', '', $store_host));
    if ($store_host === '') {
      $store_host = '{{ include "store.host" . }}';
    }
    define('WP_HOME', '{{ include "store.scheme" . }}://' . $store_host);
    define('WP_SITEURL', '{{ include "store.scheme" . }}://' . $store_host);
    define('FS_METHOD', 'direct');
    define('DISABLE_WP_CRON', false);
    define('WP_MEMORY_LIMIT', '256M');
{{- end -}}
