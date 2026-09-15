import { createHash } from 'node:crypto';

/** One product the WP-CLI seeder creates. */
export interface SeedProduct {
  name: string;
  category: string;
  price: string;
  color: string;
  short: string;
  description: string;
  featured: boolean;
}

/** Catalog handed to the store chart as `store.catalogData`. */
export interface ResolvedCatalog {
  type: string;
  label: string;
  tagline: string;
  hero: string;
  products: SeedProduct[];
}

export interface CustomProductInput {
  name: string;
  price: number;
  category?: string;
}

/** What the client asked for; persisted on the namespace so re-provisioning is deterministic. */
export interface CatalogSpec {
  type: string;
  sells?: string;
  products?: CustomProductInput[];
}

type ProductRow = [name: string, category: string, price: number, short: string];

interface Vertical {
  label: string;
  description: string;
  tagline: string;
  hero: string;
  /** Plain keywords score 2 on an exact word and 1 on a prefix; `!keyword` scores 4. Phrases match anywhere. */
  keywords: string[];
  products: ProductRow[];
}

const VERTICALS: Record<string, Vertical> = {
  apparel: {
    label: 'Apparel',
    description: 'Hoodies, tees, denim and accessories',
    tagline: 'Everyday essentials, made to last.',
    hero: 'Soft fabrics, honest prices and Cash on Delivery on every order.',
    keywords: ['!apparel', '!clothing', '!clothes', 'fashion', 'wear', 'shirt', 'shirts', 'tee', 'tees', 'tshirt', 'hoodie', 'hoodies', 'boutique', 'outfit', 'outfits', 'dress', 'dresses', 'jeans', 'denim', 'threads', 'streetwear'],
    products: [
      ['Classic Hoodie', 'Hoodies', 29.99, 'Cozy cotton blend hoodie for test orders.'],
      ['Everyday Crew Tee', 'Tops', 18, 'Breathable organic cotton crew neck tee.'],
      ['Slim Stretch Chinos', 'Bottoms', 44.5, 'Tailored chinos with a touch of stretch.'],
      ['Denim Trucker Jacket', 'Outerwear', 69, 'Rigid selvedge denim that softens with wear.'],
      ['Merino Wool Beanie', 'Accessories', 16, 'Warm, itch-free rib-knit merino beanie.'],
      ['Waxed Canvas Tote', 'Accessories', 24, 'Water resistant tote with leather handles.'],
    ],
  },
  books: {
    label: 'Books',
    description: 'Fiction, non-fiction, children’s books and journals',
    tagline: 'Stories and ideas worth sharing.',
    hero: 'Hand-picked fiction, practical guides and beautiful journals.',
    keywords: ['!book', '!books', '!bookstore', '!bookshop', 'library', 'read', 'reading', 'reads', 'novel', 'novels', 'literature', 'literary', 'publisher', 'comics', 'manga', 'chapter'],
    products: [
      ['The Silent Orchard', 'Fiction', 14.99, 'A quiet, haunting family saga. Paperback, 384 pages.'],
      ['Systems That Scale', 'Non-fiction', 39, 'Practical patterns for reliable software. Hardcover.'],
      ['Midnight at the Harbor', 'Mystery', 12.99, 'A detective, a storm and a missing ship.'],
      ['Pocket Atlas of the Stars', 'Illustrated', 22, 'Sixty hand-drawn star charts in a linen hardcover.'],
      ['Little Fox Finds Home', 'Children', 9.99, 'A picture book about courage and friendship.'],
      ['Dot Grid Reading Journal', 'Journals', 12.5, 'Log every book you read on 120 gsm paper.'],
    ],
  },
  electronics: {
    label: 'Electronics',
    description: 'Earbuds, chargers, keyboards and smart home gear',
    tagline: 'Smart gear for work and play.',
    hero: 'Reliable gadgets, fair prices and Cash on Delivery.',
    keywords: ['!electronics', '!electronic', '!gadget', '!gadgets', 'tech', 'digital', 'device', 'devices', 'computer', 'computers', 'laptop', 'laptops', 'phone', 'phones', 'mobile', 'headphones', 'charger', 'smart'],
    products: [
      ['Aurora Wireless Earbuds', 'Audio', 59.99, 'Active noise cancelling with 30-hour battery.'],
      ['65W USB-C GaN Charger', 'Power', 34, 'Charge a laptop and phone at the same time.'],
      ['10,000mAh Power Bank', 'Power', 29, 'Slim USB-C power bank with fast charging.'],
      ['Low-Profile Mechanical Keyboard', 'Peripherals', 89, 'Quiet tactile switches and Bluetooth.'],
      ['1440p Streaming Webcam', 'Peripherals', 49, 'Autofocus webcam with dual microphones.'],
      ['Lumen Smart Desk Lamp', 'Smart Home', 42, 'Adjustable warmth with app and voice control.'],
    ],
  },
  coffee: {
    label: 'Coffee & Tea',
    description: 'Roasted beans, loose tea and brewing gear',
    tagline: 'Freshly roasted, delivered to your door.',
    hero: 'Small-batch beans and brewing gear for better mornings.',
    keywords: ['!coffee', '!cafe', '!café', '!espresso', '!tea', 'roaster', 'roastery', 'roast', 'beans', 'bean', 'brew', 'brews', 'barista', 'latte', 'chai'],
    products: [
      ['House Blend Whole Beans', 'Coffee', 16, 'Chocolatey medium roast, 1 lb bag.'],
      ['Ethiopia Yirgacheffe', 'Coffee', 19.5, 'Bright floral single origin, 12 oz.'],
      ['Earl Grey Loose Leaf Tea', 'Tea', 14, 'Black tea with Calabrian bergamot, 100 g.'],
      ['Ceramic Pour-Over Set', 'Brewing Gear', 32, 'Dripper, glass carafe and 40 filters.'],
      ['Hand Burr Grinder', 'Brewing Gear', 45, 'Stainless steel conical burrs, 40 settings.'],
      ['Insulated Travel Mug', 'Drinkware', 24, 'Keeps drinks hot for six hours, 16 oz.'],
    ],
  },
  hobby: {
    label: 'RC & Hobby',
    description: 'RC cars, drones, batteries and chargers',
    tagline: 'Built for speed, made for fun.',
    hero: 'Radio-controlled cars, crawlers and drones ready to run.',
    keywords: ['!rc', '!remote control', '!radio control', '!drone', '!drones', '!quadcopter', 'hobby', 'hobbies', 'model', 'models', 'crawler', 'crawlers', 'buggy', 'racing', 'racer', 'fpv', 'toy', 'toys'],
    products: [
      ['Storm Racer 1:10 RC Buggy', 'RC Cars', 189, '4WD brushless buggy that reaches 60 km/h.'],
      ['Rock Crawler 4x4 RC Truck', 'RC Cars', 229, 'Waterproof electronics and locking diffs.'],
      ['Mini Drift Car 1:24', 'RC Cars', 59, 'Palm-sized drift car with gyro assist.'],
      ['Falcon FPV Quadcopter', 'Drones', 249, 'HD FPV camera and 20-minute flight time.'],
      ['7.4V 5200mAh LiPo Battery', 'Batteries', 39, 'Hard-case 2S pack with Deans connector.'],
      ['Smart Balance Charger', 'Chargers', 49, 'Charges and balances LiPo and NiMH packs.'],
    ],
  },
  watches: {
    label: 'Watches & Jewelry',
    description: 'Automatic watches, chronographs and fine jewelry',
    tagline: 'Timeless pieces for every day.',
    hero: 'Precision watches and jewelry, delivered with Cash on Delivery.',
    keywords: ['!watch', '!watches', '!jewelry', '!jewellery', '!timepiece', '!timepieces', 'jewel', 'jewels', 'ring', 'rings', 'necklace', 'necklaces', 'bracelet', 'bracelets', 'earrings', 'gold', 'silver', 'diamond'],
    products: [
      ['Meridian Automatic Watch', 'Watches', 249, 'Sapphire crystal and a 42-hour power reserve.'],
      ['Field Chronograph', 'Watches', 179, 'Stopwatch complication and 100 m water resistance.'],
      ['Minimalist Mesh Watch', 'Watches', 129, 'Slim steel case on a milanese mesh strap.'],
      ['Sterling Silver Chain Necklace', 'Necklaces', 59, '925 silver curb chain, 50 cm.'],
      ['Gold Hoop Earrings', 'Earrings', 45, '18k gold-plated, hypoallergenic hoops.'],
      ['Italian Leather Watch Strap', 'Straps', 29, 'Quick-release 20 mm leather strap.'],
    ],
  },
  beauty: {
    label: 'Beauty & Skincare',
    description: 'Serums, moisturizers, makeup and fragrance',
    tagline: 'Clean beauty for your daily ritual.',
    hero: 'Gentle skincare and makeup that lets your skin breathe.',
    keywords: ['!beauty', '!skincare', '!cosmetics', '!makeup', 'skin', 'cosmetic', 'salon', 'spa', 'glow', 'serum', 'perfume', 'perfumes', 'fragrance', 'lipstick', 'nails'],
    products: [
      ['Vitamin C Glow Serum', 'Skincare', 28, 'Brightening serum with 15% vitamin C.'],
      ['Hydrating Gel Moisturizer', 'Skincare', 24, 'Lightweight hyaluronic acid moisturizer.'],
      ['Gentle Foaming Cleanser', 'Skincare', 18, 'pH-balanced cleanser for all skin types.'],
      ['Matte Liquid Lipstick', 'Makeup', 16, 'Long-wear color that does not dry lips.'],
      ['Volumizing Mascara', 'Makeup', 19, 'Buildable volume without clumps.'],
      ['Cedar & Amber Eau de Parfum', 'Fragrance', 68, 'Warm woody fragrance, 50 ml.'],
    ],
  },
  fitness: {
    label: 'Sports & Fitness',
    description: 'Yoga, strength training and outdoor gear',
    tagline: 'Gear up. Show up.',
    hero: 'Training equipment and outdoor gear for every goal.',
    keywords: ['!fitness', '!gym', '!sports', '!sport', '!yoga', 'workout', 'workouts', 'running', 'runner', 'athletic', 'athletics', 'cycling', 'outdoor', 'outdoors', 'camping', 'hiking', 'training'],
    products: [
      ['Pro Grip Yoga Mat', 'Yoga', 38, 'Non-slip 6 mm mat with alignment lines.'],
      ['Adjustable Dumbbell 20 kg', 'Strength', 129, 'Dial from 2 to 20 kg in seconds.'],
      ['Resistance Band Set', 'Strength', 24, 'Five bands with handles and door anchor.'],
      ['Lightweight Running Shorts', 'Apparel', 32, 'Quick-dry shorts with a zip pocket.'],
      ['Insulated Sports Bottle', 'Accessories', 22, 'Keeps water cold for 24 hours, 750 ml.'],
      ['Trail Daypack 25L', 'Outdoor', 59, 'Ventilated back panel and rain cover.'],
    ],
  },
  pets: {
    label: 'Pet Supplies',
    description: 'Food, treats, beds and toys for dogs and cats',
    tagline: 'Everything your best friend needs.',
    hero: 'Healthy food, comfy beds and toys for happy pets.',
    keywords: ['!pet', '!pets', '!dog', '!dogs', '!cat', '!cats', 'puppy', 'puppies', 'kitten', 'kittens', 'paw', 'paws', 'vet', 'aquarium', 'petshop'],
    products: [
      ['Grain-Free Chicken Kibble 5 kg', 'Dog Food', 42, 'High-protein recipe for adult dogs.'],
      ['Wild Salmon Cat Treats', 'Cat Food', 8, 'Freeze-dried single-ingredient treats.'],
      ['Orthopedic Dog Bed', 'Beds', 79, 'Memory foam bed with washable cover.'],
      ['Rope Tug Toy', 'Toys', 12, 'Durable cotton rope for fetch and tug.'],
      ['Adjustable Nylon Harness', 'Walking', 26, 'No-pull harness with reflective trim.'],
      ['Feather Wand Cat Toy', 'Toys', 9, 'Interactive wand with refill feathers.'],
    ],
  },
  grocery: {
    label: 'Gourmet Grocery',
    description: 'Pantry staples, spices and snacks',
    tagline: 'Good food starts with good ingredients.',
    hero: 'Small-producer pantry staples, spices and snacks.',
    keywords: ['!grocery', '!groceries', '!organic', '!pantry', 'food', 'foods', 'farm', 'market', 'spice', 'spices', 'snack', 'snacks', 'gourmet', 'deli', 'honey', 'olive'],
    products: [
      ['Cold-Pressed Olive Oil 500 ml', 'Pantry', 18, 'Extra virgin oil from a single estate.'],
      ['Raw Wildflower Honey', 'Pantry', 12, 'Unfiltered honey from local hives.'],
      ['Stone-Ground Sourdough Flour', 'Baking', 9, 'Organic heritage wheat, 2 kg.'],
      ['Smoked Spanish Paprika', 'Spices', 7, 'Oak-smoked pimentón de la Vera.'],
      ['Dark Chocolate Sea Salt Bar', 'Snacks', 6, '70% cacao with flaky sea salt.'],
      ['Roasted Salted Almonds 500 g', 'Snacks', 14, 'Slow-roasted California almonds.'],
    ],
  },
  bakery: {
    label: 'Bakery',
    description: 'Bread, pastries, cakes and cookies',
    tagline: 'Baked fresh every morning.',
    hero: 'Sourdough, pastries and celebration cakes from our oven to your table.',
    keywords: ['!bakery', '!bakes', '!cake', '!cakes', '!pastry', '!patisserie', 'baked', 'bake', 'cookie', 'cookies', 'dessert', 'desserts', 'sweets', 'cupcake', 'cupcakes', 'bread', 'donut', 'donuts'],
    products: [
      ['Classic Sourdough Loaf', 'Bread', 8, 'Naturally leavened, 36-hour ferment.'],
      ['Butter Croissants (4 pack)', 'Pastry', 12, 'Laminated with French butter.'],
      ['Chocolate Fudge Cake', 'Cakes', 36, 'Three layers of rich chocolate, serves 10.'],
      ['Red Velvet Cupcakes (6)', 'Cakes', 18, 'Cream cheese frosting on every one.'],
      ['Almond Biscotti Jar', 'Cookies', 14, 'Twice-baked Tuscan almond biscotti.'],
      ['Cinnamon Rolls (4)', 'Pastry', 15, 'Soft rolls with brown butter glaze.'],
    ],
  },
  home: {
    label: 'Home & Kitchen',
    description: 'Cookware, tableware, decor and furniture',
    tagline: 'Make your house feel like home.',
    hero: 'Cookware, tableware and decor designed to be used every day.',
    keywords: ['!home', '!kitchen', '!homeware', '!decor', 'furniture', 'interior', 'interiors', 'cookware', 'living', 'houseware', 'candle', 'candles', 'tableware', 'furnishings'],
    products: [
      ['Cast Iron Skillet 12 inch', 'Cookware', 45, 'Pre-seasoned and oven safe.'],
      ['Bamboo Cutting Board', 'Kitchen', 28, 'Knife-friendly board with juice groove.'],
      ['Stoneware Dinner Plates (4)', 'Tableware', 48, 'Reactive glaze, dishwasher safe.'],
      ['Linen Throw Pillow', 'Decor', 34, 'Stonewashed linen with feather insert.'],
      ['Soy Wax Candle', 'Decor', 22, 'Fig and cedar scent, 50-hour burn.'],
      ['Oak Floating Shelf', 'Furniture', 39, 'Solid oak with hidden bracket, 60 cm.'],
    ],
  },
  garden: {
    label: 'Plants & Garden',
    description: 'Houseplants, planters, seeds and tools',
    tagline: 'Grow something beautiful.',
    hero: 'Healthy houseplants, planters and garden tools.',
    keywords: ['!plant', '!plants', '!garden', '!gardening', '!florist', 'nursery', 'flower', 'flowers', 'succulent', 'succulents', 'seeds', 'greenhouse', 'botanical', 'bonsai'],
    products: [
      ['Monstera Deliciosa', 'Houseplants', 35, 'Easy-care statement plant in a 17 cm pot.'],
      ['Snake Plant', 'Houseplants', 28, 'Air-purifying and low-light tolerant.'],
      ['Succulent Trio', 'Succulents', 24, 'Three potted succulents in ceramic cups.'],
      ['Terracotta Planter Set', 'Pots', 30, 'Three sizes with drainage saucers.'],
      ['Heirloom Tomato Seeds', 'Seeds', 5, 'Mixed heirloom varieties, 50 seeds.'],
      ['Bypass Pruning Shears', 'Tools', 22, 'Carbon steel blades with safety lock.'],
    ],
  },
  stationery: {
    label: 'Stationery & Art',
    description: 'Notebooks, pens, paints and craft supplies',
    tagline: 'Tools for makers and dreamers.',
    hero: 'Notebooks, pens and art supplies for your next idea.',
    keywords: ['!stationery', '!art', '!arts', '!craft', '!crafts', 'paper', 'pen', 'pens', 'notebook', 'notebooks', 'journal', 'journals', 'paint', 'paints', 'painting', 'sketch', 'drawing'],
    products: [
      ['Hardcover Dot Journal A5', 'Notebooks', 19, 'Lay-flat binding with numbered pages.'],
      ['Fine Liner Pen Set (12)', 'Pens', 16, 'Archival ink in twelve colors.'],
      ['Brass Fountain Pen', 'Pens', 58, 'Solid brass body with a steel nib.'],
      ['Watercolor Travel Palette', 'Paint', 34, '24 artist-grade pans and a water brush.'],
      ['Mixed Media Sketchbook', 'Paper', 14, '200 gsm paper for wet and dry media.'],
      ['Washi Tape Set', 'Craft', 9, 'Ten patterned rolls for journaling.'],
    ],
  },
  gaming: {
    label: 'Gaming',
    description: 'Controllers, headsets and board games',
    tagline: 'Level up your setup.',
    hero: 'Controllers, headsets and games for every kind of player.',
    keywords: ['!gaming', '!gamer', '!gamers', '!esports', '!videogames', '!boardgames', 'game', 'games', 'console', 'consoles', 'playstation', 'xbox', 'nintendo', 'arcade'],
    products: [
      ['Pro Wireless Controller', 'Controllers', 59, 'Remappable buttons and 40-hour battery.'],
      ['RGB Gaming Mouse', 'Accessories', 45, '26K DPI sensor and eight buttons.'],
      ['Surround Gaming Headset', 'Audio', 79, '7.1 surround with detachable microphone.'],
      ['XL Desk Mouse Pad', 'Accessories', 22, 'Stitched edges, 90 x 40 cm.'],
      ['Frontier Strategy Board Game', 'Board Games', 44, 'Two to five players, 60-minute games.'],
      ['Party Night Card Game', 'Card Games', 15, 'Fast rounds for four to ten players.'],
    ],
  },
  footwear: {
    label: 'Footwear',
    description: 'Sneakers, boots, sandals and socks',
    tagline: 'Step into comfort.',
    hero: 'Sneakers, boots and sandals made for walking all day.',
    keywords: ['!shoe', '!shoes', '!sneaker', '!sneakers', '!footwear', 'boots', 'boot', 'sandals', 'kicks', 'socks'],
    products: [
      ['Everyday Leather Sneaker', 'Sneakers', 89, 'Full-grain leather with a cushioned sole.'],
      ['Trail Running Shoe', 'Running', 119, 'Grippy lugs and a rock plate.'],
      ['Suede Chelsea Boot', 'Boots', 139, 'Water-repellent suede with elastic sides.'],
      ['Cushioned Slide Sandal', 'Sandals', 35, 'Contoured footbed for all-day comfort.'],
      ['Wool Crew Socks (3 pairs)', 'Socks', 18, 'Merino blend that stays fresh.'],
      ['Shoe Care Kit', 'Care', 24, 'Cleaner, brush and protector spray.'],
    ],
  },
  music: {
    label: 'Music & Instruments',
    description: 'Guitars, keyboards, drums and accessories',
    tagline: 'Play loud. Play often.',
    hero: 'Instruments and accessories for beginners and pros.',
    keywords: ['!music', '!musical', '!instrument', '!instruments', '!guitar', '!guitars', 'piano', 'drum', 'drums', 'vinyl', 'records', 'ukulele', 'violin', 'bass'],
    products: [
      ['Acoustic Dreadnought Guitar', 'Guitars', 249, 'Solid spruce top with a rich, warm tone.'],
      ['Portable 61-Key Keyboard', 'Keyboards', 179, 'Touch-sensitive keys and built-in speakers.'],
      ['Maple Drumsticks 5A', 'Drums', 14, 'Balanced sticks with wood tips.'],
      ['Phosphor Bronze Guitar Strings', 'Accessories', 12, 'Light gauge acoustic strings.'],
      ['Clip-On Chromatic Tuner', 'Accessories', 18, 'Fast, accurate tuning for any instrument.'],
      ['Vinyl Record Cleaning Kit', 'Vinyl', 25, 'Brush, fluid and anti-static cloth.'],
    ],
  },
  auto: {
    label: 'Auto Parts & Care',
    description: 'Car care, tools, lighting and accessories',
    tagline: 'Keep your ride running right.',
    hero: 'Parts, tools and detailing supplies for drivers who care.',
    keywords: ['!automotive', '!auto', '!garage', '!mechanic', 'car', 'cars', 'parts', 'motor', 'motors', 'motorcycle', 'tire', 'tires', 'tyre', 'tyres', 'detailing', 'vehicle'],
    products: [
      ['Microfiber Detailing Kit', 'Car Care', 29, 'Towels, applicators and a wash mitt.'],
      ['Ceramic Wax Spray', 'Car Care', 24, 'Hydrophobic shine that lasts months.'],
      ['Portable Tire Inflator', 'Tools', 55, 'Cordless inflator with auto shut-off.'],
      ['LED Headlight Bulbs (Pair)', 'Lighting', 49, '6000K bulbs, plug and play.'],
      ['1440p Dash Cam', 'Electronics', 89, 'Wide-angle recording with parking mode.'],
      ['All-Weather Floor Mats', 'Interior', 69, 'Trim-to-fit rubber mats, set of four.'],
    ],
  },
  baby: {
    label: 'Baby & Kids',
    description: 'Clothing, toys, feeding and bedding',
    tagline: 'Little things for little ones.',
    hero: 'Safe, soft and thoughtfully made essentials for babies and kids.',
    keywords: ['!baby', '!babies', '!kids', '!toddler', '!infant', 'kid', 'children', 'child', 'maternity', 'newborn'],
    products: [
      ['Organic Cotton Onesie Set', 'Clothing', 26, 'Three soft onesies, 0 to 3 months.'],
      ['Soft Plush Bunny', 'Toys', 18, 'Machine-washable cuddle toy.'],
      ['Silicone Feeding Set', 'Feeding', 22, 'Suction plate, bowl and spoon.'],
      ['Muslin Swaddle Blankets (3)', 'Bedding', 32, 'Breathable cotton muslin, 120 cm.'],
      ['Wooden Stacking Rings', 'Toys', 15, 'Non-toxic paint, ages 1 and up.'],
      ['Diaper Backpack', 'Bags', 59, 'Insulated pockets and a changing pad.'],
    ],
  },
};

const GENERAL: Vertical = {
  label: 'General Store',
  description: 'Gift cards, totes, mugs and everyday goods',
  tagline: 'Something for everyone.',
  hero: 'A little bit of everything, delivered with Cash on Delivery.',
  keywords: [],
  products: [
    ['Gift Card $25', 'Gift Cards', 25, 'The easy gift, delivered by email.'],
    ['Canvas Tote Bag', 'Bags', 18, 'Heavy cotton canvas with long handles.'],
    ['Ceramic Mug', 'Kitchen', 14, 'Stoneware mug, 350 ml.'],
    ['Pocket Notebook', 'Stationery', 9, 'Recycled paper, dot grid.'],
    ['Stainless Water Bottle', 'Drinkware', 22, 'Double-wall insulated, 500 ml.'],
    ['Scented Soy Candle', 'Home', 20, 'Hand-poured with cotton wick.'],
  ],
};

const PRODUCT_COLORS = ['#6d28d9', '#0e7490', '#a16207', '#3f6212', '#9f1239', '#1e3a8a', '#9a3412', '#0f766e', '#be185d', '#475569', '#15803d', '#b45309'];
const ACCENT_COLORS = ['#7c3aed', '#0f766e', '#b45309', '#be123c', '#1d4ed8', '#15803d', '#9333ea', '#c2410c'];
const MAX_PRODUCTS = 24;

function hashByte(value: string, index = 0): number {
  return createHash('sha256').update(value).digest()[index % 32] ?? 0;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

function scoreVertical(vertical: Vertical, text: string): number {
  const tokens = words(text);
  const joined = ` ${tokens.join(' ')} `;
  let score = 0;
  for (const raw of vertical.keywords) {
    const strong = raw.startsWith('!');
    const keyword = strong ? raw.slice(1) : raw;
    if (keyword.includes(' ')) {
      if (joined.includes(` ${keyword} `)) score += strong ? 4 : 2;
      continue;
    }
    for (const token of tokens) {
      if (token === keyword) score += strong ? 4 : 2;
      else if (keyword.length >= 4 && token.startsWith(keyword)) score += 1;
    }
  }
  return score;
}

/** Returns the best matching vertical id, or null when nothing matches. */
export function detectVertical(name: string, sells = ''): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const [id, vertical] of Object.entries(VERTICALS)) {
    // What the store sells is a stronger signal than its name.
    const score = scoreVertical(vertical, name) + 2 * scoreVertical(vertical, sells);
    if (score > bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

function titleCase(text: string): string {
  return text.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

function price(value: number): string {
  return value.toFixed(2);
}

function colorFor(name: string): string {
  return PRODUCT_COLORS[hashByte(name) % PRODUCT_COLORS.length] ?? PRODUCT_COLORS[0]!;
}

function toSeedProducts(rows: ProductRow[], storeName: string): SeedProduct[] {
  return rows.map(([name, category, amount, short], index) => ({
    name,
    category,
    price: price(amount),
    color: colorFor(name),
    short,
    description: `${short} Sold by ${storeName} with Cash on Delivery.`,
    featured: index < 4,
  }));
}

/** "rc cars, drones and batteries" -> ["Rc Cars", "Drones", "Batteries"] */
function itemsFromSells(sells: string): string[] {
  return sells
    .split(/,|;|\n|\band\b|&|\//i)
    .map((item) => item.trim().replace(/\s+/g, ' '))
    .filter((item) => item.length >= 2)
    .slice(0, 8)
    .map((item) => titleCase(item));
}

function fromItems(items: string[], storeName: string, storeId: string): ProductRow[] {
  const tiers: Array<[string, number, string]> = [
    ['Essential', 1, 'Great value pick for everyday use.'],
    ['Premium', 2.2, 'Upgraded materials and a longer warranty.'],
  ];
  // Two tiers for each of the first six items: at most 12 products.
  return items.slice(0, 6).flatMap((item) => {
    const base = 12 + (hashByte(`${storeId}:${item}`) % 60);
    return tiers.map(
      ([tier, multiplier, blurb]): ProductRow => [
        `${tier} ${item}`,
        item,
        Math.round(base * multiplier) - 0.01,
        `${blurb} From the ${storeName} ${item.toLowerCase()} range.`,
      ],
    );
  });
}

function fromVertical(type: string, vertical: Vertical, storeName: string): ResolvedCatalog {
  return {
    type,
    label: vertical.label,
    tagline: vertical.tagline,
    hero: vertical.hero,
    products: toSeedProducts(vertical.products, storeName),
  };
}

/**
 * Builds the catalog a store is seeded with:
 *   1. custom products from the client, if any;
 *   2. an explicitly chosen store type;
 *   3. the store type detected from the name and "what will you sell";
 *   4. products named after the items in "what will you sell";
 *   5. a general store.
 */
export function resolveCatalog(spec: CatalogSpec, storeName: string, storeId: string): ResolvedCatalog {
  const sells = spec.sells?.trim() ?? '';
  const explicit = spec.type && spec.type !== 'auto' && VERTICALS[spec.type] ? spec.type : null;
  const detected = explicit ?? detectVertical(storeName, sells);
  const vertical = detected ? VERTICALS[detected]! : null;

  if (spec.products && spec.products.length > 0) {
    const rows: ProductRow[] = spec.products.slice(0, MAX_PRODUCTS).map((p) => [
      p.name.trim(),
      p.category?.trim() || vertical?.products[0]?.[1] || 'Products',
      p.price,
      `${p.name.trim()} from ${storeName}.`,
    ]);
    return {
      type: 'custom',
      label: vertical ? `${vertical.label} (custom products)` : 'Custom products',
      tagline: vertical?.tagline ?? (sells ? `${titleCase(sells)}, delivered to your door.` : 'Hand-picked products, delivered to your door.'),
      hero: vertical?.hero ?? `Shop ${rows.length} hand-picked products with Cash on Delivery.`,
      products: toSeedProducts(rows, storeName),
    };
  }

  if (vertical && detected) return fromVertical(detected, vertical, storeName);

  const items = itemsFromSells(sells);
  if (items.length > 0) {
    const list = items.slice(0, 3).join(', ').toLowerCase();
    return {
      type: 'items',
      label: `Custom range: ${items.slice(0, 3).join(', ')}`,
      tagline: `The best ${list}, delivered to your door.`,
      hero: `Shop our ${list} range with Cash on Delivery.`,
      products: toSeedProducts(fromItems(items, storeName, storeId), storeName),
    };
  }

  return fromVertical('general', GENERAL, storeName);
}

export function listCatalogTypes(): Array<{ type: string; label: string; description: string }> {
  return Object.entries(VERTICALS).map(([type, v]) => ({ type, label: v.label, description: v.description }));
}

export function isCatalogType(type: string): boolean {
  return type === 'auto' || type in VERTICALS;
}

export function accentColorFor(storeId: string): string {
  return ACCENT_COLORS[hashByte(storeId, 1) % ACCENT_COLORS.length] ?? ACCENT_COLORS[0]!;
}
