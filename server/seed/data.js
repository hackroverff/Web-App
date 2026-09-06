/**
 * Demo catalogue for a Chennai provision store. Prices are realistic 2026
 * Chennai retail levels (₹) — this is seed data for a demo, not a price promise.
 * Brand names are invented so no third-party trademarks or imagery are used.
 *
 * Row shape (see seed/index.js for the importer):
 *   n name · ta Tamil name · c 'Category / Sub-category' · b brand · p pack size
 *   u unit · mrp · r retail price · w wholesale price (null = retail only)
 *   moq wholesale minimum packs · min retail minimum · stock packs on hand
 *   low low-stock alert level · tiers [[from,to,price],...] · feat featured flag
 */

export const CATEGORY_TREE = [
  {
    name: 'Grocery & Staples',
    name_ta: 'தானியம் & முக்கிய பொருட்கள்',
    icon: '🌾',
    children: ['Atta & Flours', 'Rice & Millets', 'Dals & Lentils', 'Cooking Oils', 'Masalas & Spices', 'Sugar & Salt'],
  },
  { name: 'Beverages', name_ta: 'பானங்கள்', icon: '☕', children: ['Tea & Coffee', 'Juices & Cordials', 'Soft Drinks'] },
  { name: 'Snacks', name_ta: 'இடுகடிகள்', icon: '🍿', children: ['Namkeen', 'Biscuits & Cookies', 'Chips', 'Traditional Sweets'] },
  { name: 'Dairy & Breakfast', name_ta: 'பால் & காலை உணவு', icon: '🥛', children: ['Milk & Curd', 'Bread & Eggs', 'Cereals'] },
  { name: 'Personal Care', name_ta: 'தனிநபர் பராமரிப்பு', icon: '🧼', children: ['Bath & Body', 'Hair Care', 'Oral Care', 'Baby Care'] },
  { name: 'Household', name_ta: 'வீடு & சுத்தம்', icon: '🧽', children: ['Kitchen Cleaning', 'Laundry', 'Pest Control', 'Disposables'] },
  { name: 'Kitchen Essentials', name_ta: 'அடுப்பறை உபகரணங்கள்', icon: '🍳', children: ['Cookware', 'Storage', 'Foil & Wraps'] },
  { name: 'Puja & Festivals', name_ta: 'பூஜை & பண்டிகை', icon: '🪔', children: [] },
];

export const PRODUCTS = [
  { n: 'Whole Wheat Atta', ta: 'கோதுமை மாவு', c: 'Grocery & Staples/Atta & Flours', b: 'Nalam', p: '5 kg', u: 'kg', mrp: 285, r: 255, w: 235, moq: 6, stock: 26, feat: 1,
    tiers: [[6, 11, 229], [12, 29, 222], [30, null, 215]], desc: 'Chakki-fresh whole wheat flour, milled weekly. 100% wheat, no maida mix.' },
  { n: 'Rice Flour', ta: 'அரிசி மாவு', c: 'Grocery & Staples/Atta & Flours', b: 'Kaveri Gold', p: '500 g', u: 'g', mrp: 55, r: 48, w: 43, moq: 8, stock: 34 },
  { n: 'Ponni Boiled Rice', ta: 'பொன்னி அரிசி', c: 'Grocery & Staples/Rice & Millets', b: 'Kaveri Gold', p: '10 kg', u: 'kg', mrp: 620, r: 555, w: 495, moq: 4, stock: 15, feat: 1,
    tiers: [[4, 9, 488], [10, 24, 470], [25, null, 455]], desc: 'Daily-use Ponni boiled rice from the Kaveri delta, 10 kg gunny bag.' },
  { n: 'Sona Masoori Rice', ta: 'சோனா முசுரி அரிசி', c: 'Grocery & Staples/Rice & Millets', b: 'Kaveri Gold', p: '5 kg', u: 'kg', mrp: 480, r: 425, w: 385, moq: 5, stock: 21,
    tiers: [[5, 14, 375], [15, null, 362]] },
  { n: 'Toor Dal (Thuvaram Paruppu)', ta: 'துவரம் பருப்பு', c: 'Grocery & Staples/Dals & Lentils', b: 'Mannar', p: '1 kg', u: 'kg', mrp: 165, r: 148, w: 132, moq: 6, stock: 30, feat: 1,
    tiers: [[6, 17, 128], [18, 49, 124], [50, null, 119]] },
  { n: 'Whole Green Gram', ta: 'பாசிப் பருப்பு', c: 'Grocery & Staples/Dals & Lentils', b: 'Mannar', p: '500 g', u: 'g', mrp: 88, r: 79, w: 72, moq: 8, stock: 24 },
  { n: 'Masoor Dal', ta: 'மசூர் பருப்பு', c: 'Grocery & Staples/Dals & Lentils', b: 'Mannar', p: '1 kg', u: 'kg', mrp: 105, r: 95, w: 86, moq: 6, stock: 19 },
  { n: 'Whole Black Gram (Ulundu)', ta: 'உளுந்து', c: 'Grocery & Staples/Dals & Lentils', b: 'Mannar', p: '500 g', u: 'g', mrp: 78, r: 70, w: 63, moq: 8, stock: 28 },

  // ------------------------------------------------------------- Cooking Oils
  { n: 'Refined Sunflower Oil', ta: 'சூரியகாந்தி எண்ணெய்', c: 'Grocery & Staples/Cooking Oils', b: 'Suravi', p: '1 litre', u: 'litre', mrp: 165, r: 148, w: 135, moq: 6, stock: 48, feat: 1,
    tiers: [[6, 23, 129], [24, 59, 124], [60, null, 118]] },
  { n: 'Groundnut Oil', ta: 'நிலக்கடலை எண்ணெய்', c: 'Grocery & Staples/Cooking Oils', b: 'Suravi', p: '1 litre', u: 'litre', mrp: 245, r: 225, w: 205, moq: 6, stock: 22,
    tiers: [[6, 23, 198], [24, null, 190]] },
  { n: 'Coconut Oil (Filtered)', ta: 'தேங்காய் எண்ணெய்', c: 'Grocery & Staples/Cooking Oils', b: 'Kudamittai', p: '500 ml', u: 'ml', mrp: 210, r: 189, w: 172, moq: 6, stock: 27 },
  { n: 'Sesame (Gingelly) Oil', ta: 'நல்லெண்ணெய்', c: 'Grocery & Staples/Cooking Oils', b: 'Kudamittai', p: '500 ml', u: 'ml', mrp: 235, r: 212, w: 195, moq: 4, stock: 11, low: 4 },
  { n: 'Turmeric Powder', ta: 'மஞ்சள் பொடி', c: 'Grocery & Staples/Masalas & Spices', b: 'Avoor', p: '200 g', u: 'g', mrp: 58, r: 52, w: 46, moq: 10, stock: 55,
    tiers: [[10, 49, 44], [50, null, 41]] },
  { n: 'Red Chilli Powder', ta: 'மிளகாய் தூள்', c: 'Grocery & Staples/Masalas & Spices', b: 'Avoor', p: '200 g', u: 'g', mrp: 92, r: 84, w: 75, moq: 10, stock: 38 },
  { n: 'Coriander Powder', ta: 'கொத்தமல்லி தூள்', c: 'Grocery & Staples/Masalas & Spices', b: 'Avoor', p: '200 g', u: 'g', mrp: 62, r: 56, w: 50, moq: 10, stock: 41 },
  { n: 'Sambar Powder', ta: 'சாம்பார் பொடி', c: 'Grocery & Staples/Masalas & Spices', b: 'Sathvika Select', p: '200 g', u: 'g', mrp: 85, r: 76, w: 68, moq: 6, stock: 33 },
  { n: 'Rasam Powder', ta: 'ரசம் பொடி', c: 'Grocery & Staples/Masalas & Spices', b: 'Sathvika Select', p: '100 g', u: 'g', mrp: 68, r: 61, w: 55, moq: 6, stock: 4 },
  { n: 'Refined Sugar', ta: 'சர்க்கரை', c: 'Grocery & Staples/Sugar & Salt', b: 'Trippy', p: '1 kg', u: 'kg', mrp: 52, r: 47, w: 42, moq: 12, stock: 65,
    tiers: [[12, 49, 40], [50, null, 38]] },
  { n: 'Jaggery (Vellam)', ta: 'வெல்லம்', c: 'Grocery & Staples/Sugar & Salt', b: 'Pattam', p: '500 g', u: 'g', mrp: 62, r: 55, w: 48, moq: 8, stock: 29 },
  { n: 'Iodised Salt', ta: 'உப்பு', c: 'Grocery & Staples/Sugar & Salt', b: 'Aalaram', p: '1 kg', u: 'kg', mrp: 32, r: 28, w: 24, moq: 20, stock: 80,
    tiers: [[20, null, 22]] },
  { n: 'Filter Coffee Powder', ta: 'ஃபில்டர் காபி பொடி', c: 'Beverages/Tea & Coffee', b: 'Malgudi Blends', p: '500 g', u: 'g', mrp: 285, r: 258, w: 232, moq: 6, stock: 24, feat: 1,
    tiers: [[6, 17, 226], [18, 47, 218], [48, null, 209]], desc: '80:20 coffee-chicory, medium-dark roast for the traditional davara-setu.' },
  { n: 'Black Tea Powder', ta: ' டீ தூள்', c: 'Beverages/Tea & Coffee', b: 'Malgudi Blends', p: '250 g', u: 'g', mrp: 165, r: 149, w: 135, moq: 8, stock: 31,
    tiers: [[8, 23, 130], [24, null, 124]] },
  { n: 'Mango Pulp', ta: 'மாம்பழப் கூழ்', c: 'Beverages/Juices & Cordials', b: 'Thendral', p: '1 kg', u: 'packet', mrp: 265, r: 240, w: 218, moq: 4, stock: 7, low: 3 },
  { n: 'Lemon Cordial', ta: 'எலுமிச்சை பழநீர்', c: 'Beverages/Juices & Cordials', b: 'Thendral', p: '850 ml', u: 'ml', mrp: 120, r: 108, w: 96, moq: 6, stock: 20 },
  { n: 'Tender Coconut Water', ta: 'இளநீர்', c: 'Beverages/Soft Drinks', b: 'Kudamittai', p: '200 ml', u: 'packet', mrp: 45, r: 40, w: 35, moq: 12, stock: 48 },
  { n: 'Cola Soft Drink', ta: 'சோடா பானம்', c: 'Beverages/Soft Drinks', b: 'Zipzipp', p: '750 ml', u: 'piece', mrp: 45, r: 40, w: 35, moq: 12, stock: 36 },
  { n: 'Banana Chips', ta: 'வாழைச்சிப்ஸ்', c: 'Snacks/Namkeen', b: 'Vilaiyattu', p: '200 g', u: 'packet', mrp: 95, r: 85, w: 76, moq: 10, stock: 42,
    tiers: [[10, 49, 72], [50, null, 68]] },
  { n: 'Chettinad Murukku', ta: 'முறுக்கு', c: 'Snacks/Namkeen', b: 'Vilaiyattu', p: '250 g', u: 'packet', mrp: 110, r: 98, w: 88, moq: 6, stock: 18 },
  { n: 'Mixed Namkeen', ta: 'கலவை நம்கின்', c: 'Snacks/Namkeen', b: 'Vilaiyattu', p: '400 g', u: 'packet', mrp: 130, r: 118, w: 105, moq: 6, stock: 14 },
  { n: 'Glucose Biscuits', ta: 'குளுக்கோஸ் பிஸ்கட்', c: 'Snacks/Biscuits & Cookies', b: 'Crumbly', p: '1 kg', u: 'packet', mrp: 145, r: 130, w: 115, moq: 10, stock: 55,
    tiers: [[10, 39, 110], [40, null, 104]] },
  { n: 'Salted Potato Chips', ta: 'உருளைக்கிழங்கு சிப்ஸ்', c: 'Snacks/Chips', b: 'Crunchico', p: '90 g', u: 'packet', mrp: 40, r: 35, w: 31, moq: 24, stock: 90 },
  { n: 'Sesame Seed Ball (Ellu Urundai)', ta: 'எள் உண்டா', c: 'Snacks/Traditional Sweets', b: 'Pattam', p: '250 g', u: 'box', mrp: 120, r: 108, w: 96, moq: 6, stock: 11 },
  { n: 'Mysore Pak', ta: 'மைசூர் பாக்கு', c: 'Snacks/Traditional Sweets', b: 'Mithai Mahal', p: '500 g', u: 'box', mrp: 320, r: 289, w: 262, moq: 4, stock: 6, low: 3 },

  // ------------------------------------------------------- Dairy & Breakfast
  { n: 'Fresh Curd Cup', ta: 'தயிர்', c: 'Dairy & Breakfast/Milk & Curd', b: 'Amudhu', p: '400 g', u: 'piece', mrp: 42, r: 38, w: 34, moq: 10, stock: 44, min: 2 },
  { n: 'Table Butter', ta: 'வெண்ணெய்', c: 'Dairy & Breakfast/Milk & Curd', b: 'Amudhu', p: '100 g', u: 'packet', mrp: 62, r: 56, w: 51, moq: 10, stock: 26 },
  { n: 'White Bread Loaf', ta: 'ப்ரெட்', c: 'Dairy & Breakfast/Bread & Eggs', b: 'Daily Bake', p: '400 g', u: 'piece', mrp: 45, r: 40, w: 36, moq: 10, stock: 3, max: 6 },
  { n: 'Farm Eggs', ta: 'முட்டை', c: 'Dairy & Breakfast/Bread & Eggs', b: 'Kuzhandai', p: '12 pieces', u: 'dozen', mrp: 108, r: 96, w: 86, moq: 4, stock: 34,
    tiers: [[4, 11, 84], [12, null, 80]] },
  { n: 'Rolled Oats', ta: 'ஓட்ஸ்', c: 'Dairy & Breakfast/Cereals', b: 'Paushtik', p: '500 g', u: 'packet', mrp: 130, r: 118, w: 105, moq: 6, stock: 21 },
  { n: 'Herbal Bath Soap (Pack of 4)', ta: 'மூலிகை சோப்பு', c: 'Personal Care/Bath & Body', b: 'Pachai', p: '4 × 100 g', u: 'packet', mrp: 150, r: 135, w: 120, moq: 6, stock: 33 },
  { n: 'Anti-Dandruff Shampoo', ta: 'பொடுகு ஷாம்பு', c: 'Personal Care/Hair Care', b: 'Kesari', p: '340 ml', u: 'ml', mrp: 245, r: 222, w: 199, moq: 4, stock: 17 },
  { n: 'Amla Hair Oil', ta: 'நெல்லி எண்ணெய்', c: 'Personal Care/Hair Care', b: 'Kesari', p: '200 ml', u: 'ml', mrp: 135, r: 122, w: 109, moq: 6, stock: 28 },
  { n: 'Herbal Toothpaste', ta: 'பற்பசை', c: 'Personal Care/Oral Care', b: 'Dantanam', p: '150 g', u: 'box', mrp: 115, r: 104, w: 93, moq: 8, stock: 42 },
  { n: 'Baby Talcum Powder', ta: 'குழந்தை தூள்', c: 'Personal Care/Baby Care', b: 'Malar', p: '100 g', u: 'box', mrp: 105, r: 95, w: 86, moq: 6, stock: 14 },
  { n: 'Liquid Handwash Refill', ta: 'திரவ சோப்பு', c: 'Personal Care/Bath & Body', b: 'Suraksha', p: '750 ml', u: 'ml', mrp: 145, r: 130, w: 116, moq: 6, stock: 23 },

  // --------------------------------------------------------------- Household
  { n: 'Dishwash Gel', ta: 'தட்டு கழுவும் ஜெல்', c: 'Household/Kitchen Cleaning', b: 'Sudhu', p: '750 ml', u: 'ml', mrp: 175, r: 158, w: 140, moq: 6, stock: 35,
    tiers: [[6, 23, 135], [24, null, 129]] },
  { n: 'Laundry Detergent Powder', ta: 'டிடர்ஜன் பொடி', c: 'Household/Laundry', b: 'Sudhu', p: '1 kg', u: 'kg', mrp: 175, r: 158, w: 140, moq: 6, stock: 30 },
  { n: 'Floor Cleaner (Pine)', ta: 'தரை சுத்தம்', c: 'Household/Kitchen Cleaning', b: 'Sudhu', p: '1 litre', u: 'litre', mrp: 185, r: 168, w: 149, moq: 4, stock: 13 },
  { n: 'Mosquito Repellent Liquid', ta: 'கொசு மருந்து (திரவம்)', c: 'Household/Pest Control', b: 'Kavacham', p: '45 ml', u: 'piece', mrp: 165, r: 149, w: 133, moq: 6, stock: 19 },
  { n: 'Cockroach Gel Bait', ta: 'வீட்டான் மருந்து', c: 'Household/Pest Control', b: 'Kavacham', p: '12 g', u: 'piece', mrp: 115, r: 104, w: 93, moq: 4, stock: 0 },
  { n: 'Garbage Bags (Medium)', ta: 'குப்பை பைகள்', c: 'Household/Disposables', b: 'EcoSack', p: '30 pieces', u: 'packet', mrp: 130, r: 117, w: 104, moq: 8, stock: 27 },
  { n: 'Aluminium Foil', ta: 'அலுமினியம் ஃபாயில்', c: 'Kitchen Essentials/Foil & Wraps', b: 'Wrapwell', p: '10 m', u: 'box', mrp: 130, r: 118, w: 105, moq: 6, stock: 24 },
  { n: 'Cling Wrap', ta: 'பிளாஸ்டிக் ரேப்', c: 'Kitchen Essentials/Foil & Wraps', b: 'Wrapwell', p: '30 m', u: 'box', mrp: 145, r: 130, w: 116, moq: 6, stock: 16 },
  { n: 'Steel Storage Box (Set of 3)', ta: 'எஃகு பெட்டி', c: 'Kitchen Essentials/Storage', b: 'Irani', p: '1 litre × 3', u: 'box', mrp: 385, r: 349, w: 315, moq: 2, stock: 9 },
  { n: 'Non-Stick Tawa 24 cm', ta: 'தவா', c: 'Kitchen Essentials/Cookware', b: 'Irani', p: '1 piece', u: 'piece', mrp: 645, r: 585, w: 525, moq: 2, stock: 5, low: 2 },
  { n: 'Stainless Steel Cooker 3 L', ta: 'அழுத்த குக்கர்', c: 'Kitchen Essentials/Cookware', b: 'Irani', p: '3 litre', u: 'piece', mrp: 1290, r: 1175, w: 1075, moq: 1, stock: 4, low: 2 },
  { n: 'Camphor (Pachha Karpooram)', ta: 'பச்சை கர்பூரம்', c: 'Puja & Festivals', b: 'Devalayam', p: '25 g', u: 'packet', mrp: 45, r: 40, w: 35, moq: 6, stock: 28 },
  { n: 'Sandanan Agarbatti', ta: 'அகர்பத்தி', c: 'Puja & Festivals', b: 'Devalayam', p: '20 minis', u: 'packet', mrp: 65, r: 58, w: 51, moq: 10, stock: 44 },

];

/** Businesses that buy in bulk — used by the seed for wholesale accounts + orders. */
export const SEED_ACCOUNTS = {
  retail: [
    { full_name: 'Priya Raghavan', mobile: '9840012345', password: 'priya@123', lang: 'en', email: 'priya.r@example.com' },
    { full_name: 'Gokulakrishnan M', mobile: '9840023456', password: 'gokul@1234', lang: 'ta' },
    { full_name: 'Farida Noorani', mobile: '9840067890', password: 'farida@123', lang: 'en' },
  ],
  wholesale: [
    {
      full_name: 'Ramesh Kumar', mobile: '9840034567', password: 'balaji@123', status: 'active',
      business_name: 'Sri Balaji Tiffin Room', business_type: 'restaurant', gst_number: '33ABCDE1234F1Z5', lang: 'en',
      notes: 'Tiffin counter, 60 seats. Regular early-morning oil + dal supply.',
    },
    {
      full_name: 'Suresh Babu', mobile: '9840045678', password: 'newmumbai@123', status: 'pending_verification',
      business_name: 'New Mumbai Stores', business_type: 'shop', gst_number: '33AAACN5678P1ZQ', lang: 'en',
      notes: 'Kirana shop in Villivakkam, wants slab prices on staples.',
    },
    {
      full_name: 'Lakshmi Priya', mobile: '9840078901', password: 'annanagar@123', status: 'active',
      business_name: 'Anna Nagar Staff Canteen', business_type: 'canteen', gst_number: null, lang: 'ta',
      notes: 'Office canteen, 120 lunches a day. Pays by UPI only.',
    },
    {
      full_name: 'Abdul Shakoor', mobile: '9840089012', password: 'koyambedu@123', status: 'suspended',
      business_name: 'Koyambedu Caterers', business_type: 'other', gst_number: '33XYZCA9012B1Z3', lang: 'en',
      notes: 'Suspended after two bounced UPI claims. Revisit next month.',
    },
  ],
};

export const ADDRESSES = {
  '9840012345': [
    { label: 'Home', kind: 'home', line1: 'Flat 3B, Sai Apartments', line2: '12th Street', area: 'T. Nagar', city: 'Chennai', pincode: '600017', landmark: 'Opposite Ranganathan Street', lat: 13.0418, lng: 80.2341, is_default: 1 },
    { label: 'Office', kind: 'home', line1: 'No. 5, 2nd Floor, Chetpet', line2: 'Dr. Radhakrishnan Salai', area: 'Chetpet', city: 'Chennai', pincode: '600031', landmark: 'Near Chetpet railway station' },
  ],
  '9840023456': [
    { label: 'Home', kind: 'home', line1: 'No. 78, West Mada Street', line2: '', area: 'Triplicane', city: 'Chennai', pincode: '600005', landmark: 'Near Parthasarathy temple', lat: 13.0542, lng: 80.2745, is_default: 1 },
  ],
  '9840034567': [
    { label: 'Shop', kind: 'business', line1: 'Sri Balaji Tiffin Room, 14 North Usman Road', line2: '', area: 'T. Nagar', city: 'Chennai', pincode: '600017', landmark: 'Next to Satyam Theater', lat: 13.0446, lng: 80.2372, is_default: 1 },
    { label: 'Godown', kind: 'business', line1: 'Ground Floor, 22 Rangasamy Street', line2: '', area: 'T. Nagar', city: 'Chennai', pincode: '600017', landmark: '' },
  ],
  '9840045678': [
    { label: 'Shop', kind: 'business', line1: 'New Mumbai Stores, 4 Villivakkam Main Road', line2: '', area: 'Villivakkam', city: 'Chennai', pincode: '600049', landmark: 'Opposite bus depot', is_default: 1 },
  ],
  '9840078901': [
    { label: 'Canteen', kind: 'business', line1: 'Anna Nagar Staff Canteen, 5th Avenue Block O', line2: '', area: 'Anna Nagar', city: 'Chennai', pincode: '600040', landmark: 'Back gate', lat: 13.085, lng: 80.2101, is_default: 1 },
  ],
  '9840067890': [
    { label: 'Home', kind: 'home', line1: 'No. 9, Islamic Avenue Street', line2: '', area: 'Purasawalkam', city: 'Chennai', pincode: '600007', landmark: 'Near Wells Church', is_default: 1 },
  ],
};

/**
 * Hand-built demo orders so the owner dashboard has movement on every screen.
 * qty values are what each line was priced at; the seeder runs them through the
 * same pricing engine so seeded totals are consistent with the live app.
 */
export const SEED_ORDERS = [
  { account: '9840012345', age_hours: 0.4, status: 'placed', payment: 'cod', items: [['Filter Coffee Powder', 1], ['White Bread Loaf', 2], ['Farm Eggs', 1]] },
  { account: '9840023456', age_hours: 1.2, status: 'confirmed', payment: 'upi', payment_app: 'gpay', items: [['Toor Dal (Thuvaram Paruppu)', 1], ['Turmeric Powder', 2], ['Refined Sugar', 2]] },
  { account: '9840034567', age_hours: 2.1, status: 'preparing', payment: 'upi', payment_app: 'phonepe', upi_ref: '4129****8871', items: [['Refined Sunflower Oil', 12], ['Ponni Boiled Rice', 5], ['Toor Dal (Thuvaram Paruppu)', 8], ['Iodised Salt', 24]] },
  { account: '9840078901', age_hours: 3.4, status: 'out_for_delivery', payment: 'upi', payment_app: 'paytm', upi_ref: 'TXN98421', items: [['Whole Wheat Atta', 14], ['Table Butter', 12], ['Glucose Biscuits', 8], ['Dishwash Gel', 6]] },
  { account: '9840067890', age_hours: 6.5, status: 'delivered', payment: 'upi', payment_app: 'gpay', items: [['Herbal Bath Soap (Pack of 4)', 2], ['Anti-Dandruff Shampoo', 1], ['Liquid Handwash Refill', 1]] },
  { account: '9840012345', age_hours: 28, status: 'delivered', payment: 'cod', items: [['Banana Chips', 3], ['Mixed Namkeen', 1], ['Black Tea Powder', 1]] },
  { account: '9840034567', age_hours: 30, status: 'delivered', payment: 'upi', payment_app: 'phonepe', items: [['Groundnut Oil', 8], ['Red Chilli Powder', 10], ['Filter Coffee Powder', 6]] },
  { account: '9840023456', age_hours: 32, status: 'cancelled', payment: 'cod', cancel_reason: 'Customer called: ordering from the shop directly', items: [['Mysore Pak', 1], ['Sesame Seed Ball (Ellu Urundai)', 1]] },
  { account: '9840078901', age_hours: 52, status: 'delivered', payment: 'upi', payment_app: 'paytm', items: [['Ponni Boiled Rice', 12], ['Refined Sunflower Oil', 26], ['Masoor Dal', 6]] },
  { account: '9840045678', age_hours: 54, status: 'delivered', payment: 'cod', items: [['Glucose Biscuits', 20], ['Salted Potato Chips', 48], ['Cola Soft Drink', 24]] },
  { account: '9840012345', age_hours: 76, status: 'delivered', payment: 'upi', payment_app: 'gpay', voided: true, void_note: 'Duplicate order — same items placed twice in error', items: [['Jaggery (Vellam)', 2], ['Rolled Oats', 1]] },
  { account: '9840034567', age_hours: 100, status: 'delivered', payment: 'upi', payment_app: 'phonepe', items: [['Refined Sunflower Oil', 48], ['Toor Dal (Thuvaram Paruppu)', 20], ['Rasam Powder', 6]] },
  { account: '9840067890', age_hours: 120, status: 'delivered', payment: 'cod', items: [['Sona Masoori Rice', 1], ['Coriander Powder', 1], ['Fresh Curd Cup', 4]] },
];
