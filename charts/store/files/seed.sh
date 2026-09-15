#!/bin/sh
# Idempotent WooCommerce bootstrap. Every step checks current state first,
# so a retried Job (backoffLimit) resumes where the previous attempt died.
set -eu
WP="wp --allow-root --path=/var/www/html"

echo "[seeder] waiting for WordPress files (wp-config.php) on the shared volume"
until [ -f /var/www/html/wp-config.php ] && [ -f /var/www/html/wp-includes/version.php ]; do sleep 3; done

echo "[seeder] waiting for MariaDB"
until php -r '
  mysqli_report(MYSQLI_REPORT_OFF);
  $h = explode(":", getenv("WORDPRESS_DB_HOST"));
  $c = @mysqli_connect($h[0], getenv("WORDPRESS_DB_USER"), getenv("WORDPRESS_DB_PASSWORD"), getenv("WORDPRESS_DB_NAME"), (int)($h[1] ?? 3306));
  exit($c ? 0 : 1);'; do sleep 3; done

if ! $WP core is-installed; then
  echo "[seeder] installing WordPress"
  $WP core install \
    --url="${STORE_URL}" \
    --title="${STORE_NAME}" \
    --admin_user="${ADMIN_USER}" \
    --admin_password="${ADMIN_PASSWORD}" \
    --admin_email="${ADMIN_EMAIL}" \
    --skip-email
fi
$WP option update blogname "${STORE_NAME}"
$WP rewrite structure '/%postname%/' --hard

if ! $WP plugin is-installed woocommerce; then
  echo "[seeder] installing WooCommerce ${WOOCOMMERCE_VERSION}"
  $WP plugin install woocommerce --version="${WOOCOMMERCE_VERSION}"
fi
if ! $WP plugin is-active woocommerce; then
  $WP plugin activate woocommerce
fi

# Storefront is WooCommerce's official theme: classic templates, header cart,
# product search and a mobile footer bar that work with WooCommerce 8.9.
if ! $WP theme is-installed storefront; then
  echo "[seeder] installing Storefront ${STOREFRONT_VERSION}"
  $WP theme install storefront --version="${STOREFRONT_VERSION}"
fi
if ! $WP theme is-active storefront; then
  $WP theme activate storefront
fi

# Cosmetic settings: WooCommerce's own option handlers occasionally reject a
# write (for example the onboarding task list), which must not abort seeding.
optional_option() {
  $WP option update "$@" >/dev/null 2>&1 || echo "[seeder] warning: could not set optional option $1"
}

echo "[seeder] configuring store"
$WP option update woocommerce_store_address "123 Test St"
$WP option update woocommerce_store_city "Austin"
$WP option update woocommerce_store_postcode "78701"
$WP option update woocommerce_default_country "US:TX"
$WP option update woocommerce_currency "USD"
# Demo stores sell without shipping zones; physical goods would otherwise
# block checkout with "no shipping options".
$WP option update woocommerce_ship_to_countries "disabled"
$WP option update woocommerce_enable_guest_checkout "yes"
optional_option woocommerce_enable_ajax_add_to_cart "yes"
optional_option woocommerce_cart_redirect_after_add "no"
optional_option woocommerce_calc_taxes "no"
optional_option woocommerce_allow_tracking "no"
optional_option woocommerce_show_marketplace_suggestions "no"
optional_option woocommerce_onboarding_profile '{"skipped":true}' --format=json
optional_option woocommerce_task_list_hidden "yes"
optional_option woocommerce_coming_soon "no"
optional_option woocommerce_email_from_name "${STORE_NAME}"

# Enable Cash on Delivery (COD)
$WP option update woocommerce_cod_settings '{"enabled":"yes","title":"Cash on Delivery","description":"Pay with cash upon delivery.","instructions":"Pay with cash upon delivery.","enable_for_methods":[],"enable_for_virtual":"yes"}' --format=json

# Catalog, product images, home page, menus and branding for this store.
$WP eval-file /scripts/seed-store.php --user="${ADMIN_USER}"

$WP rewrite flush --hard
$WP cache flush >/dev/null 2>&1 || true
echo "[seeder] store ${STORE_NAME} ready at ${STORE_URL}"
