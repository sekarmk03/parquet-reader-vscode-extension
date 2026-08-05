/**
 * Generates test/demo.parquet — the file used for screenshots and for the remote
 * (s3://) demo. Everything here is deterministic: rerunning it produces a byte-identical
 * file, so a screenshot taken today still matches the file you ship tomorrow.
 *
 * It is deliberately shaped to exercise every part of the viewer at once:
 * wide enough to scroll, tall enough to page, with one column per rendering rule.
 */
import { parquetWriteFile } from 'hyparquet-writer'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const out = join(dirname(fileURLToPath(import.meta.url)), 'demo.parquet')

const ROWS = 1200 // 12 pages at 100 rows each
const ROW_GROUP = 300 // 4 row groups, so the Schema tab sums chunks across groups

// Small LCG rather than Math.random: the file must be reproducible.
let seed = 20260805
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const pick = list => list[Math.floor(rand() * list.length)]
const range = n => Array.from({ length: n }, (_, i) => i)

const CATEGORIES = ['Electronics', 'Grocery', 'Apparel', 'Home & Kitchen', 'Books', 'Toys']
const PRODUCTS = {
  Electronics: ['Wireless Earbuds', 'Mechanical Keyboard', '4K Monitor', 'USB-C Hub'],
  Grocery: ['Arabica Beans 1kg', 'Olive Oil 500ml', 'Basmati Rice 5kg', 'Dark Chocolate 70%'],
  Apparel: ['Merino Wool Socks', 'Denim Jacket', 'Running Shorts', 'Linen Shirt'],
  'Home & Kitchen': ['Cast Iron Skillet', 'Ceramic Mug Set', 'Bamboo Cutting Board'],
  Books: ['Designing Data-Intensive Applications', 'The Pragmatic Programmer', 'Refactoring'],
  Toys: ['Wooden Train Set', 'Rubik’s Cube', 'Model Glider Kit'],
}
const CITIES = [
  ['Jakarta', 'DKI Jakarta', '10110'],
  ['Bandung', 'Jawa Barat', '40111'],
  ['Surabaya', 'Jawa Timur', '60111'],
  ['Yogyakarta', 'DI Yogyakarta', '55111'],
  ['Medan', 'Sumatera Utara', '20111'],
  ['Makassar', 'Sulawesi Selatan', '90111'],
]
const COURIERS = ['JNE', 'SiCepat', 'AnterAja', 'Ninja Xpress']
const NOTE_WORDS = `customer requested gift wrapping fragile handle with care leave at front desk
call before delivery apartment building access code required signature on delivery preferred
weekend delivery only do not ring the bell dog in the yard package must fit the letterbox
replacement for damaged item from previous order include printed invoice remove price tag`
  .split(/\s+/)

/** Long, varied free text — this is the column that shows off the detail pane. */
function note() {
  const words = 50 + Math.floor(rand() * 110)
  return range(words).map(() => pick(NOTE_WORDS)).join(' ')
}

/** Values that are exact in float32, so the Schema tab shows 12.5 and not 12.499999… */
const DISCOUNTS = [5, 7.5, 10, 12.5, 15, 20, 25, 30]

function uuid() {
  const hex = range(32).map(() => '0123456789abcdef'[Math.floor(rand() * 16)]).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const rows = range(ROWS).map(i => {
  const category = pick(CATEGORIES)
  const [city, province, postcode] = pick(CITIES)
  const quantity = 1 + Math.floor(rand() * 5)
  const unitPrice = Math.round((rand() * 240 + 9) * 100) / 100
  return {
    category,
    product: pick(PRODUCTS[category]),
    quantity,
    unitPrice,
    city,
    province,
    postcode,
    // Placed over about a year, at a readable time of day.
    placedAt: new Date(Date.UTC(2025, 0, 1 + (i % 365), 6 + (i % 12), (i * 7) % 60, (i * 13) % 60)),
    customer: uuid(),
    // Roughly a quarter of orders carry a discount; the rest are NULL.
    discount: rand() < 0.25 ? pick(DISCOUNTS) : null,
    rating: rand() < 0.12 ? null : Math.round(rand() * 4 + 1),
    isGift: rand() < 0.18,
    note: rand() < 0.35 ? null : note(),
  }
})

parquetWriteFile({
  filename: out,
  compressed: true,
  rowGroupSize: ROW_GROUP,
  columnData: [
    { name: 'order_id', type: 'INT64', data: rows.map((_, i) => BigInt(100001 + i)) },
    { name: 'placed_at', type: 'TIMESTAMP', data: rows.map(r => r.placedAt) },
    { name: 'customer_id', type: 'UUID', data: rows.map(r => r.customer) },
    {
      name: 'sku',
      type: 'STRING',
      data: rows.map((_, i) => `SKU-${String(1 + (i % 240)).padStart(5, '0')}`),
    },
    { name: 'product', type: 'STRING', data: rows.map(r => r.product) },
    // A few missing categories, so the Schema tab shows a non-zero null count.
    {
      name: 'category',
      type: 'STRING',
      data: rows.map((r, i) => (i % 53 === 0 ? null : r.category)),
    },
    { name: 'quantity', type: 'INT32', data: rows.map(r => r.quantity) },
    { name: 'unit_price', type: 'DOUBLE', data: rows.map(r => r.unitPrice) },
    {
      name: 'total',
      type: 'DOUBLE',
      data: rows.map(r => Math.round(r.quantity * r.unitPrice * 100) / 100),
    },
    { name: 'discount_pct', type: 'FLOAT', data: rows.map(r => r.discount) },
    { name: 'rating', type: 'INT32', data: rows.map(r => r.rating) },
    { name: 'is_gift', type: 'BOOLEAN', data: rows.map(r => r.isGift) },
    // Nested: renders as one column of JSON, expands in the detail pane.
    // Kept shallow on purpose — every nested field becomes two more rows in the
    // Schema tab, and a demo file should stay readable there too.
    {
      name: 'shipment',
      type: 'VARIANT',
      shredding: true,
      data: rows.map(r => ({
        courier: pick(COURIERS),
        tracking: `TRK${Math.floor(rand() * 1e9).toString().padStart(9, '0')}`,
        address: { city: r.city, province: r.province, postcode: r.postcode },
        legs: range(1 + Math.floor(rand() * 3)).map(n => ({
          hub: pick(CITIES)[0],
          status: pick(['picked_up', 'in_transit', 'out_for_delivery', 'delivered']),
        })),
      })),
    },
    // Left uncompressed on purpose: the info bar then reports two codecs.
    { name: 'notes', type: 'STRING', codec: 'UNCOMPRESSED', data: rows.map(r => r.note) },
  ],
})

console.log(`demo.parquet written: ${ROWS} rows, 14 columns, ${ROWS / 100} pages`)
