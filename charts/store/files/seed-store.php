<?php
/**
 * Store content seeder, run with `wp eval-file` after WooCommerce and
 * Storefront are active. Idempotent: products are matched by SKU, pages by
 * slug and the menu by name, so re-running updates instead of duplicating.
 *
 * Environment: STORE_NAME, STORE_ACCENT, STORE_ID.
 * Catalog: /scripts/catalog.json built by the orchestrator for this store.
 */

require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';
require_once ABSPATH . 'wp-admin/includes/image.php';

function seed_log( string $message ): void {
	WP_CLI::log( "[seeder] {$message}" );
}

function seed_env( string $name, string $fallback ): string {
	$value = getenv( $name );
	return ( false === $value || '' === $value ) ? $fallback : $value;
}

/** @return int[] RGB triple for a #rrggbb color. */
function seed_rgb( string $hex ): array {
	$hex = ltrim( $hex, '#' );
	if ( ! preg_match( '/^[0-9a-fA-F]{6}$/', $hex ) ) {
		$hex = '7f54b3';
	}
	return array_map( 'hexdec', str_split( $hex, 2 ) );
}

/** Mixes a color towards black (negative) or white (positive). */
function seed_shade( string $hex, float $amount ): string {
	$out = array();
	foreach ( seed_rgb( $hex ) as $channel ) {
		$target = $amount < 0 ? 0 : 255;
		$out[]  = (int) round( $channel + ( $target - $channel ) * abs( $amount ) );
	}
	return vsprintf( '#%02x%02x%02x', $out );
}

function seed_font(): ?string {
	$candidates = array(
		ABSPATH . 'wp-content/themes/twentytwentytwo/assets/fonts/dm-sans/DMSans-Bold.ttf',
		ABSPATH . 'wp-content/themes/twentytwentythree/assets/fonts/inter/Inter-VariableFont_slnt,wght.ttf',
		ABSPATH . 'wp-content/themes/twentytwentytwo/assets/fonts/inter/Inter.ttf',
	);
	foreach ( $candidates as $font ) {
		if ( is_readable( $font ) ) {
			return $font;
		}
	}
	return null;
}

function seed_centered_text( $image, string $font, float $size, int $y, $color, string $text ): void {
	$box   = imagettfbbox( $size, 0, $font, $text );
	$width = abs( $box[2] - $box[0] );
	imagettftext( $image, $size, 0, (int) ( ( imagesx( $image ) - $width ) / 2 ), $y, $color, $font, $text );
}

/** Generates a branded product image offline with GD and attaches it. */
function seed_product_image( array $product, int $post_id ): int {
	if ( ! function_exists( 'imagecreatetruecolor' ) ) {
		return 0;
	}
	$size  = 800;
	$image = imagecreatetruecolor( $size, $size );
	list( $r, $g, $b ) = seed_rgb( $product['color'] );

	for ( $y = 0; $y < $size; $y++ ) {
		$t    = $y / $size;
		$line = imagecolorallocate(
			$image,
			(int) ( $r + ( 255 - $r ) * $t * 0.45 ),
			(int) ( $g + ( 255 - $g ) * $t * 0.45 ),
			(int) ( $b + ( 255 - $b ) * $t * 0.45 )
		);
		imageline( $image, 0, $y, $size, $y, $line );
	}

	$ring  = imagecolorallocatealpha( $image, 255, 255, 255, 100 );
	$white = imagecolorallocate( $image, 255, 255, 255 );
	imagefilledellipse( $image, $size / 2, 330, 400, 400, $ring );

	$words    = preg_split( '/\s+/', preg_replace( '/[^A-Za-z0-9 ]/', '', $product['name'] ) );
	$initials = strtoupper( substr( $words[0] ?? 'S', 0, 1 ) . substr( $words[1] ?? '', 0, 1 ) );
	$font     = seed_font();

	if ( $font && function_exists( 'imagettftext' ) ) {
		seed_centered_text( $image, $font, 120, 390, $white, $initials );
		seed_centered_text( $image, $font, 34, 640, $white, $product['name'] );
		seed_centered_text( $image, $font, 24, 700, $white, $product['category'] );
	} else {
		imagestring( $image, 5, 40, 620, $product['name'], $white );
	}

	$slug = sanitize_title( $product['name'] );
	$tmp  = wp_tempnam( $slug . '.png' );
	imagepng( $image, $tmp );
	imagedestroy( $image );

	$attachment_id = media_handle_sideload(
		array(
			'name'     => $slug . '.png',
			'tmp_name' => $tmp,
		),
		$post_id,
		$product['name']
	);
	if ( is_wp_error( $attachment_id ) ) {
		@unlink( $tmp );
		seed_log( 'image for ' . $product['name'] . ' failed: ' . $attachment_id->get_error_message() );
		return 0;
	}
	update_post_meta( $attachment_id, '_wp_attachment_image_alt', $product['name'] );
	return (int) $attachment_id;
}

function seed_category( string $name ): int {
	$term = term_exists( $name, 'product_cat' );
	if ( ! $term ) {
		$term = wp_insert_term( $name, 'product_cat' );
	}
	if ( is_wp_error( $term ) ) {
		WP_CLI::error( 'cannot create category ' . $name . ': ' . $term->get_error_message() );
	}
	return (int) ( is_array( $term ) ? $term['term_id'] : $term );
}

/** Creates or updates a page by slug and returns its ID. */
function seed_page( string $slug, string $title, string $content, string $template = '' ): int {
	$page = get_page_by_path( $slug, OBJECT, 'page' );
	$data = array(
		'post_title'   => $title,
		'post_name'    => $slug,
		'post_content' => $content,
		'post_status'  => 'publish',
		'post_type'    => 'page',
	);
	if ( $page ) {
		$data['ID'] = $page->ID;
		$page_id    = wp_update_post( wp_slash( $data ), true );
	} else {
		$page_id = wp_insert_post( wp_slash( $data ), true );
	}
	if ( is_wp_error( $page_id ) ) {
		WP_CLI::error( 'cannot save page ' . $slug . ': ' . $page_id->get_error_message() );
	}
	if ( $template ) {
		update_post_meta( $page_id, '_wp_page_template', $template );
	}
	return (int) $page_id;
}

// ---------------------------------------------------------------------------
// Inputs

$store_id   = seed_env( 'STORE_ID', 'store' );
$store_name = seed_env( 'STORE_NAME', 'My Store' );
$accent     = seed_env( 'STORE_ACCENT', '#7f54b3' );
$catalog    = json_decode( (string) file_get_contents( '/scripts/catalog.json' ), true );

if ( ! is_array( $catalog ) || empty( $catalog['products'] ) ) {
	WP_CLI::error( 'catalog.json is missing or has no products' );
}
// Content is seeded once. Upgrades re-run this Job, and must not overwrite
// prices, stock or pages the merchant has edited since.
$seeded_at = get_option( 'platform_content_seeded_at' );
if ( $seeded_at && 'true' !== seed_env( 'STORE_RESEED', 'false' ) ) {
	seed_log( "content already seeded at {$seeded_at}; skipping (set seeder.reseedContent=true to re-apply)" );
	return;
}
seed_log( "seeding '{$store_name}' with the {$catalog['label']} catalog (" . count( $catalog['products'] ) . ' products)' );

// ---------------------------------------------------------------------------
// Remove WordPress demo content

foreach ( array( 'hello-world' => 'post', 'sample-page' => 'page' ) as $slug => $type ) {
	$post = get_page_by_path( $slug, OBJECT, $type );
	if ( $post ) {
		wp_delete_post( $post->ID, true );
	}
}
update_option( 'blogdescription', $catalog['tagline'] );

// ---------------------------------------------------------------------------
// Products

$sku_prefix = strtoupper( substr( preg_replace( '/[^a-z0-9]/i', '', $store_id ), 0, 8 ) );
foreach ( $catalog['products'] as $index => $definition ) {
	$sku        = sprintf( '%s-%02d', $sku_prefix, $index + 1 );
	$product_id = wc_get_product_id_by_sku( $sku );
	if ( ! $product_id ) {
		$existing   = get_page_by_path( sanitize_title( $definition['name'] ), OBJECT, 'product' );
		$product_id = $existing ? $existing->ID : 0;
	}

	$product = $product_id ? wc_get_product( $product_id ) : new WC_Product_Simple();
	$category_id = seed_category( $definition['category'] );

	$product->set_name( $definition['name'] );
	$product->set_status( 'publish' );
	$product->set_catalog_visibility( 'visible' );
	$product->set_sku( $sku );
	$product->set_regular_price( $definition['price'] );
	$product->set_short_description( $definition['short'] );
	$product->set_description( $definition['description'] );
	$product->set_category_ids( array( $category_id ) );
	$product->set_featured( (bool) $definition['featured'] );
	$product->set_manage_stock( true );
	$product->set_stock_quantity( 100 );
	$product->set_stock_status( 'instock' );
	$product->set_menu_order( $index );
	$product_id = $product->save();

	if ( ! $product->get_image_id() ) {
		$image_id = seed_product_image( $definition, $product_id );
		if ( $image_id ) {
			$product->set_image_id( $image_id );
			$product->save();
			if ( ! get_term_meta( $category_id, 'thumbnail_id', true ) ) {
				update_term_meta( $category_id, 'thumbnail_id', $image_id );
			}
		}
	}
	seed_log( "product {$sku} {$definition['name']} (#{$product_id})" );
}

// The uncategorized default category would otherwise appear on the home page.
$uncategorized = get_term_by( 'slug', 'uncategorized', 'product_cat' );
if ( $uncategorized && 0 === (int) $uncategorized->count ) {
	update_option( 'default_product_cat', seed_category( $catalog['products'][0]['category'] ) );
	wp_delete_term( $uncategorized->term_id, 'product_cat' );
}

// ---------------------------------------------------------------------------
// Pages

$shop_url = get_permalink( wc_get_page_id( 'shop' ) );
$name     = esc_html( $store_name );
$hero     = esc_html( $catalog['hero'] );
$tagline  = esc_html( $catalog['tagline'] );
$dark     = seed_shade( $accent, -0.25 );

$home_content = <<<HTML
<!-- wp:group {"align":"full","className":"store-hero","style":{"color":{"background":"{$accent}"},"spacing":{"padding":{"top":"72px","bottom":"72px","left":"24px","right":"24px"}}},"layout":{"type":"constrained"}} -->
<div class="wp-block-group alignfull store-hero has-background" style="background-color:{$accent};padding-top:72px;padding-right:24px;padding-bottom:72px;padding-left:24px"><!-- wp:heading {"textAlign":"center","level":1,"style":{"color":{"text":"#ffffff"}}} -->
<h1 class="wp-block-heading has-text-align-center has-text-color" style="color:#ffffff">Welcome to {$name}</h1>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center","style":{"color":{"text":"#ffffff"}}} -->
<p class="has-text-align-center has-text-color" style="color:#ffffff">{$hero}</p>
<!-- /wp:paragraph -->

<!-- wp:buttons {"layout":{"type":"flex","justifyContent":"center"}} -->
<div class="wp-block-buttons"><!-- wp:button {"style":{"color":{"background":"#ffffff","text":"{$dark}"}}} -->
<div class="wp-block-button"><a class="wp-block-button__link has-text-color has-background wp-element-button" href="{$shop_url}" style="color:{$dark};background-color:#ffffff">Shop all products</a></div>
<!-- /wp:button --></div>
<!-- /wp:buttons --></div>
<!-- /wp:group -->

<!-- wp:columns {"className":"store-benefits"} -->
<div class="wp-block-columns store-benefits"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:heading {"textAlign":"center","level":4} -->
<h4 class="wp-block-heading has-text-align-center">Cash on Delivery</h4>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center">Pay when your order arrives.</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:heading {"textAlign":"center","level":4} -->
<h4 class="wp-block-heading has-text-align-center">No shipping fees</h4>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center">The price you see is the price you pay.</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column -->

<!-- wp:column -->
<div class="wp-block-column"><!-- wp:heading {"textAlign":"center","level":4} -->
<h4 class="wp-block-heading has-text-align-center">Guest checkout</h4>
<!-- /wp:heading -->

<!-- wp:paragraph {"align":"center"} -->
<p class="has-text-align-center">No account needed to place an order.</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->

<!-- wp:heading {"textAlign":"center"} -->
<h2 class="wp-block-heading has-text-align-center">Shop by category</h2>
<!-- /wp:heading -->

<!-- wp:shortcode -->
[product_categories parent="0" hide_empty="1" columns="4" orderby="name"]
<!-- /wp:shortcode -->

<!-- wp:heading {"textAlign":"center"} -->
<h2 class="wp-block-heading has-text-align-center">Featured products</h2>
<!-- /wp:heading -->

<!-- wp:shortcode -->
[products visibility="featured" limit="4" columns="4" orderby="menu_order" order="ASC"]
<!-- /wp:shortcode -->

<!-- wp:heading {"textAlign":"center"} -->
<h2 class="wp-block-heading has-text-align-center">All products</h2>
<!-- /wp:heading -->

<!-- wp:shortcode -->
[products limit="12" columns="4" orderby="menu_order" order="ASC"]
<!-- /wp:shortcode -->

<!-- wp:paragraph {"align":"center","className":"store-tagline"} -->
<p class="has-text-align-center store-tagline">{$tagline}</p>
<!-- /wp:paragraph -->
HTML;

$home_id = seed_page( 'home', 'Home', $home_content, 'template-fullwidth.php' );
update_option( 'show_on_front', 'page' );
update_option( 'page_on_front', $home_id );

// Classic shortcodes render the full cart and checkout server side inside
// Storefront, so the flow works without the block checkout bundle.
$cart_id     = wc_get_page_id( 'cart' );
$checkout_id = wc_get_page_id( 'checkout' );
wp_update_post( array( 'ID' => $cart_id, 'post_content' => '<!-- wp:shortcode -->[woocommerce_cart]<!-- /wp:shortcode -->' ) );
wp_update_post( array( 'ID' => $checkout_id, 'post_content' => '<!-- wp:shortcode -->[woocommerce_checkout]<!-- /wp:shortcode -->' ) );
foreach ( array( $cart_id, $checkout_id, wc_get_page_id( 'myaccount' ) ) as $page_id ) {
	update_post_meta( $page_id, '_wp_page_template', 'template-fullwidth.php' );
}

// A fresh install fills the sidebar with blog widgets (Recent Posts,
// Archives, Meta). An empty sidebar makes Storefront render full width.
$sidebars = (array) get_option( 'sidebars_widgets', array() );
foreach ( array_keys( $sidebars ) as $sidebar ) {
	if ( 'wp_inactive_widgets' !== $sidebar && 'array_version' !== $sidebar ) {
		$sidebars[ $sidebar ] = array();
	}
}
update_option( 'sidebars_widgets', $sidebars );

// ---------------------------------------------------------------------------
// Navigation

$menu_name = 'Main Menu';
$menu      = wp_get_nav_menu_object( $menu_name );
$menu_id   = $menu ? (int) $menu->term_id : (int) wp_create_nav_menu( $menu_name );
if ( ! $menu ) {
	$items = array(
		'Home'       => $home_id,
		'Shop'       => wc_get_page_id( 'shop' ),
		'Cart'       => $cart_id,
		'Checkout'   => $checkout_id,
		'My account' => wc_get_page_id( 'myaccount' ),
	);
	$position = 1;
	foreach ( $items as $label => $page_id ) {
		wp_update_nav_menu_item(
			$menu_id,
			0,
			array(
				'menu-item-title'     => $label,
				'menu-item-object'    => 'page',
				'menu-item-object-id' => $page_id,
				'menu-item-type'      => 'post_type',
				'menu-item-status'    => 'publish',
				'menu-item-position'  => $position++,
			)
		);
	}
}
$locations             = (array) get_theme_mod( 'nav_menu_locations', array() );
$locations['primary']  = $menu_id;
$locations['handheld'] = $menu_id;
set_theme_mod( 'nav_menu_locations', $locations );

// ---------------------------------------------------------------------------
// Branding (Storefront customizer settings)

$theme_mods = array(
	'storefront_accent_color'                => $accent,
	'storefront_header_background_color'     => $dark,
	'storefront_header_text_color'           => '#f3f4f6',
	'storefront_header_link_color'           => '#ffffff',
	'storefront_button_background_color'     => $accent,
	'storefront_button_text_color'           => '#ffffff',
	'storefront_button_alt_background_color' => $dark,
	'storefront_button_alt_text_color'       => '#ffffff',
	'storefront_footer_background_color'     => '#f8f8f8',
	'storefront_footer_link_color'           => $dark,
);
foreach ( $theme_mods as $mod => $value ) {
	set_theme_mod( $mod, $value );
}

$css = <<<CSS
.home.page-template-template-fullwidth-php .entry-header { display: none; }
body.home .site-content { padding-top: 0; }
body.home .site-header { margin-bottom: 0 !important; }
body.home .storefront-breadcrumb { display: none; }
.store-hero h1 { font-size: 2.8em; margin-bottom: .4em; }
.store-benefits { margin: 2.5em 0 1.5em; }
.store-benefits h4 { color: {$dark}; margin-bottom: .3em; }
.home h2.wp-block-heading { margin-top: 1.2em; }
.store-tagline { opacity: .7; margin-top: 2em; }
ul.products li.product .woocommerce-loop-product__title { min-height: 2.6em; }
CSS;
wp_update_custom_css_post( $css, 'storefront' );

update_option( 'woocommerce_demo_store', 'yes' );
update_option( 'woocommerce_demo_store_notice', "Demo store {$store_id}: orders are paid with Cash on Delivery." );

update_option( 'platform_content_seeded_at', gmdate( 'c' ), false );
seed_log( 'content seeded: ' . count( $catalog['products'] ) . ' products, home page, menu and branding' );
